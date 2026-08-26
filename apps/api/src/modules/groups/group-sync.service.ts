import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import type { ChannelKey } from '../channel/entities/channel.entity';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { JobsService } from '../jobs/jobs.service';
import { JobType } from '../jobs/entities/job.entity';
import { ParticipantType } from '../messaging/message-types';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TeamMemberIdentity } from '../team/entities/team-member-identity.entity';
import { GroupParticipant } from './entities/group-participant.entity';
import { Group } from './entities/group.entity';
import { GroupOnboardingService } from './group-onboarding.service';

/** Rows written per statement when reconciling a large group list. */
const UPSERT_CHUNK = 200;

/**
 * Group and participant synchronization (brief §7, §8).
 *
 * Split into two passes because the gateway's API forces it, and the split happens to be the right
 * shape anyway:
 *
 *  1. **Listing** is one paginated walk returning id and name only. Cheap, so it covers every group.
 *  2. **Participants** need one detail request per group. At 3,000 groups that is 3,000 gateway
 *     calls — which is why it runs as a Job Center job with one item per group, giving per-group
 *     progress, per-group failures and retry-only-what-failed, rather than one long request that
 *     fails as a unit.
 */
@Injectable()
export class GroupSyncService {
  private readonly logger = new AppLogger(GroupSyncService.name);

  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(GroupParticipant) private readonly participants: Repository<GroupParticipant>,
    @InjectRepository(TeamMemberIdentity) private readonly identities: Repository<TeamMemberIdentity>,
    private readonly registry: ChannelRegistryService,
    private readonly jobs: JobsService,
    private readonly realtime: RealtimeGateway,
    private readonly metrics: MetricsService,
    private readonly onboarding: GroupOnboardingService,
  ) {}

  /**
   * Reconciles the group list for one account.
   *
   * Groups that disappear are **deactivated, never deleted** — message history keeps a valid
   * `groupId`, and the record of a support relationship survives leaving the group.
   *
   * Existing rows keep their `monitoringState`, `aiEnabled` and `automationEnabled`: those are
   * operator decisions, and a routine sync must never quietly reset them.
   */
  async syncGroups(
    account: ChannelAccount,
  ): Promise<{ discovered: number; created: number; deactivated: number; onboarded?: number }> {
    const started = Date.now();
    this.realtime.emitWhatsAppEvent('whatsapp.sync.started', {
      channelAccountId: account.id,
      scope: 'groups',
    });

    try {
      const adapter = this.registry.get(account.channelKey as ChannelKey);
      const discovered = await adapter.listGroups(account.id, { pageSize: 200 });
      const seenIds = new Set(discovered.map((g) => g.externalId));

      const existing = await this.groups.find({
        where: { channelAccountId: account.id },
        select: { id: true, externalId: true, isActive: true },
      });
      const existingByExternal = new Map(existing.map((g) => [g.externalId, g]));

      let created = 0;
      // Collected so onboarding runs once, after the sync, rather than inside the loop — a rule
      // lookup per group would be three thousand queries on a first sync.
      const createdIds: string[] = [];
      for (let i = 0; i < discovered.length; i += UPSERT_CHUNK) {
        const chunk = discovered.slice(i, i + UPSERT_CHUNK);

        for (const group of chunk) {
          const known = existingByExternal.get(group.externalId);
          if (known) {
            // Name and activity only. Never the control flags.
            await this.groups.update(known.id, {
              name: group.name,
              isActive: true,
              lastSyncedAt: new Date(),
            });
          } else {
            const saved = await this.groups.save(
              this.groups.create({
                channelKey: account.channelKey as ChannelKey,
                channelAccountId: account.id,
                externalId: group.externalId,
                name: group.name,
                // Safe defaults: a newly discovered group takes no part in support until an
                // operator says so (PROJECT_SPEC.md §46, §98).
                monitoringState: undefined,
                aiEnabled: false,
                automationEnabled: false,
                isActive: true,
                lastSyncedAt: new Date(),
              }),
            );
            created++;
            createdIds.push(saved.id);
          }
        }
      }

      // Onboarding is best-effort: a group that exists but is unconfigured is recoverable, and a
      // sync that failed because a rule referenced a deleted profile is not.
      let onboarded = 0;
      if (createdIds.length > 0) {
        try {
          const results = await this.onboarding.onboard(createdIds);
          onboarded = results.filter((result) => result.applied).length;
        } catch (error) {
          this.logger.warn('Group onboarding failed; the groups exist and are unconfigured', {
            channelAccountId: account.id,
            groups: createdIds.length,
            error: (error as Error).message,
          });
        }
      }

      const goneIds = existing.filter((g) => g.isActive && !seenIds.has(g.externalId)).map((g) => g.id);
      if (goneIds.length > 0) {
        await this.groups.update({ id: In(goneIds) }, { isActive: false });
      }

      const durationMs = Date.now() - started;
      this.metrics.observeDuration('group_sync.duration_ms', durationMs);
      this.metrics.increment('group_sync.completed');

      this.realtime.emitWhatsAppEvent('whatsapp.sync.completed', {
        channelAccountId: account.id,
        scope: 'groups',
        discovered: discovered.length,
        created,
        deactivated: goneIds.length,
        durationMs,
      });

      this.logger.log('Group sync complete', {
        channelAccountId: account.id,
        discovered: discovered.length,
        created,
        deactivated: goneIds.length,
        durationMs,
      });

      return { discovered: discovered.length, created, deactivated: goneIds.length, onboarded };
    } catch (error) {
      this.metrics.increment('group_sync.failed');
      this.realtime.emitWhatsAppEvent('whatsapp.error', {
        channelAccountId: account.id,
        scope: 'groups',
        reason: (error as Error).message.slice(0, 200),
      });
      throw error;
    }
  }

  /**
   * Queues a participant sync — one Job Center item per group.
   *
   * Not done inline: at 3,000 groups this is 3,000 sequential gateway calls, which
   * `PROJECT_SPEC.md` §49 forbids running inside a request and which needs per-item progress and
   * retry to be operable at all.
   */
  async queueParticipantSync(account: ChannelAccount, createdById: string | null) {
    const groups = await this.groups.find({
      where: { channelAccountId: account.id, isActive: true },
      select: { id: true, externalId: true },
    });

    if (groups.length === 0) {
      return null;
    }

    return this.jobs.create({
      type: JobType.CHANNEL_PARTICIPANT_SYNC,
      name: `Participant sync — ${account.label}`,
      payload: { channelAccountId: account.id },
      items: groups.map((group) => ({
        reference: group.externalId,
        payload: { groupId: group.id, channelAccountId: account.id },
      })),
      createdById,
    });
  }

  /**
   * Syncs one group's participants. Called per Job Center item.
   *
   * Membership is reconciled rather than replaced: departed members are deactivated so historical
   * attribution still resolves, and `participantType` is only ever promoted on evidence — a
   * registered team identity, or the connected account itself. **Nothing here ever writes
   * `CUSTOMER`** (brief §8).
   */
  async syncParticipants(
    account: ChannelAccount,
    groupId: string,
    externalGroupId: string,
  ): Promise<{ active: number; deactivated: number }> {
    const detail = await this.registry
      .get(account.channelKey as ChannelKey)
      .getGroupDetail(account.id, externalGroupId);

    await this.groups.update(groupId, {
      name: detail.group.name,
      description: detail.group.description,
      participantCount: detail.participants.length,
      ownerExternalId: detail.group.ownerExternalId,
      isAnnounceOnly: detail.group.isAnnounceOnly,
      participantsSyncedAt: new Date(),
      lastSyncedAt: new Date(),
    });

    const teamIdentities = await this.identities.find({
      where: { channelKey: account.channelKey as ChannelKey, isActive: true },
    });
    const teamByPhone = new Map(teamIdentities.map((identity) => [identity.phone, identity]));
    const teamByExternal = new Map(teamIdentities.map((identity) => [identity.externalId, identity]));

    const existing = await this.participants.find({ where: { groupId } });
    const existingByExternal = new Map(existing.map((p) => [p.externalId, p]));
    const now = new Date();
    const seen = new Set<string>();

    for (const participant of detail.participants) {
      seen.add(participant.externalId);

      const identity =
        teamByExternal.get(participant.externalId) ??
        (participant.phone ? teamByPhone.get(participant.phone) : undefined);

      // The connected account itself outranks a team match: if a support executive's number is also
      // the WhatsApp account, its messages are the account's, not that person's.
      //
      // Matched on PHONE, not on `account.externalId` — that is the gateway's session name, chosen
      // by the operator, and has no relationship to the account's WhatsApp identity.
      const isAccount = Boolean(
        (account.accountPhone && participant.phone === account.accountPhone) ||
          participant.externalId === `${account.accountPhone}@c.us`,
      );
      const participantType = isAccount
        ? ParticipantType.ACCOUNT
        : identity
          ? ParticipantType.TEAM_MEMBER
          : ParticipantType.UNKNOWN;

      const known = existingByExternal.get(participant.externalId);
      if (known) {
        await this.participants.update(known.id, {
          phone: participant.phone,
          displayName: participant.displayName,
          role: participant.role,
          participantType,
          teamMemberIdentityId: identity?.id ?? null,
          isActive: true,
          lastSeenInSyncAt: now,
        });
      } else {
        await this.participants.save(
          this.participants.create({
            groupId,
            externalId: participant.externalId,
            phone: participant.phone,
            displayName: participant.displayName,
            role: participant.role,
            participantType,
            teamMemberIdentityId: identity?.id ?? null,
            isActive: true,
            lastSeenInSyncAt: now,
          }),
        );
      }
    }

    const departed = existing.filter((p) => p.isActive && !seen.has(p.externalId)).map((p) => p.id);
    if (departed.length > 0) {
      await this.participants.update({ id: In(departed) }, { isActive: false });
    }

    this.metrics.increment('participant_sync.group_completed');
    return { active: detail.participants.length, deactivated: departed.length };
  }
}
