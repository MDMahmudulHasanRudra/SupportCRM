import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import type { NormalizedInboundMessage } from '../channel/channel-adapter.interface';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import type { ChannelKey } from '../channel/entities/channel.entity';
import { Group } from '../groups/entities/group.entity';
import { TeamMemberIdentity } from '../team/entities/team-member-identity.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ConversationKind, ConversationStatus } from './conversation-states';
import { Conversation } from './entities/conversation.entity';
import {
  ConversationParticipant,
  ConversationParticipantType,
} from './entities/conversation-participant.entity';
import { CustomerIdentity, IdentityMatchState } from './entities/customer-identity.entity';

/**
 * The minimum needed to place a conversation, from either direction.
 *
 * Inbound fills this from a normalized provider message; outbound fills it from the destination the
 * operator addressed. Keeping one shape means both directions run the same find-or-create — and so
 * cannot drift into creating two conversations for one chat.
 */
export interface ConversationDescriptor {
  externalConversationId: string;
  /** Set when the destination is a group. Null for a one-to-one chat. */
  externalGroupId: string | null;
  /** Used as the subject only when nothing better is known. */
  subjectHint?: string | null;
}

export interface ResolvedContext {
  conversation: Conversation;
  senderIdentity: CustomerIdentity;
  /** True the first time this conversation was seen — the caller emits `conversation.created`. */
  created: boolean;
}

/**
 * Attaches an inbound message to its conversation, and its sender to a channel identity
 * (Phase 3 brief §5).
 *
 * This is the seam where the Phase 2 channel layer meets the Phase 3 domain. It runs inside the
 * per-conversation lock the inbound processor already holds, so find-or-create is not racing itself.
 *
 * ## The rule this service exists to enforce
 *
 * Seeing a phone number creates an **identity**, never a customer. Every new sender gets an
 * `UNRESOLVED` identity row — a faithful record that someone messaged from that address, carrying
 * no claim about who they are. Promotion to a customer is a separate, human, audited act
 * (`CustomerService.confirmIdentity`). The Phase 3 brief §2 requires exactly this, and the database
 * check constraint on `customer_identities` makes it impossible to get wrong from any other path.
 *
 * A conversation's `customerId` is therefore populated only when the sender's identity is already
 * `CONFIRMED` — never inferred from the fact that a message arrived.
 */
@Injectable()
export class ConversationResolverService {
  private readonly logger = new AppLogger(ConversationResolverService.name);

  constructor(
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(CustomerIdentity) private readonly identities: Repository<CustomerIdentity>,
    @InjectRepository(TeamMemberIdentity) private readonly teamIdentities: Repository<TeamMemberIdentity>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    private readonly realtime: RealtimeGateway,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Resolves (and creates on first sight) the conversation and sender identity for one message.
   *
   * Both find-or-create paths use insert-and-catch-23505 rather than select-then-insert: even under
   * the conversation lock, a *different* conversation's message can be creating the same sender
   * identity concurrently, and only the unique index can arbitrate.
   */
  async resolveForInbound(
    account: ChannelAccount,
    normalized: NormalizedInboundMessage,
  ): Promise<ResolvedContext> {
    const senderIdentity = await this.findOrCreateIdentity(account, normalized);
    const { conversation, created } = await this.findOrCreateConversation(account, {
      externalConversationId: normalized.externalConversationId,
      externalGroupId: normalized.externalGroupId,
      subjectHint: normalized.senderDisplayName,
    });

    await this.upsertParticipant(conversation, normalized, senderIdentity, account);

    // Only a CONFIRMED identity may set the conversation's customer. A CANDIDATE is a proposal, not
    // a fact, and acting on it here would make an unreviewed guess look like a decision.
    if (
      !conversation.customerId &&
      senderIdentity.matchState === IdentityMatchState.CONFIRMED &&
      senderIdentity.customerId
    ) {
      await this.conversations.update(conversation.id, { customerId: senderIdentity.customerId });
      conversation.customerId = senderIdentity.customerId;
    }

    return { conversation, senderIdentity, created };
  }

  /**
   * Resolves (and creates on first sight) the conversation an operator's message was addressed to.
   *
   * The counterpart to `resolveForInbound`, and deliberately the *same* find-or-create underneath:
   * a chat must end up in exactly one conversation whichever direction spoke first, and two code
   * paths with their own creation logic is how that stops being true.
   *
   * **Group detection comes from the synced group table, not from the shape of the id.** A group JID
   * looks different on every channel, and this layer is channel-neutral by design — asking whether a
   * `groups` row exists for `(account, destination)` is both correct and portable, and it is what
   * stops a group being filed as a one-to-one conversation.
   *
   * No identity is created and no participant is recorded: the account sending a message is not
   * evidence about who is on the other end. That remains the inbound path's job, on real evidence.
   */
  async resolveForOutbound(
    account: ChannelAccount,
    externalConversationId: string,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const group = await this.groups.findOne({
      where: { channelAccountId: account.id, externalId: externalConversationId },
    });

    return this.findOrCreateConversation(account, {
      externalConversationId,
      externalGroupId: group ? externalConversationId : null,
      subjectHint: group?.name ?? null,
    });
  }

  /**
   * Updates a conversation's activity counters after a message lands.
   *
   * Denormalised onto the conversation so the inbox list needs no aggregate over `messages` — the
   * query that would otherwise dominate the page at 3,000 groups.
   *
   * A `RESOLVED` conversation reopens on a new inbound customer message (`PROJECT_SPEC.md` §7).
   * `CLOSED` does not: that is the whole distinction between the two.
   */
  async recordActivity(
    conversation: Conversation,
    options: { at: Date; inbound: boolean; fromCustomer: boolean },
  ): Promise<ConversationStatus | null> {
    const patch: Partial<Conversation> = {
      lastMessageAt: options.at,
      ...(options.inbound ? { lastInboundAt: options.at } : { lastOutboundAt: options.at }),
    };

    let reopenedTo: ConversationStatus | null = null;
    if (options.inbound && options.fromCustomer && conversation.status === ConversationStatus.RESOLVED) {
      patch.status = ConversationStatus.OPEN;
      patch.resolvedAt = null;
      reopenedTo = ConversationStatus.OPEN;
    }

    await this.conversations.createQueryBuilder().update().set({...patch,lastMessageAt:()=>"GREATEST(\"lastMessageAt\", :activityAt)",...(options.inbound?{lastInboundAt:()=>"GREATEST(\"lastInboundAt\", :activityAt)"}:{lastOutboundAt:()=>"GREATEST(\"lastOutboundAt\", :activityAt)"})}).where('id=:id',{id:conversation.id}).setParameter('activityAt',options.at).execute();
    this.realtime.emitConversationEvent(options.inbound?'conversation.message_received':'conversation.message_sent',{conversationId:conversation.id,channelAccountId:conversation.channelAccountId});
    await this.conversations.increment({ id: conversation.id }, 'messageCount', 1);

    return reopenedTo;
  }

  /**
   * Finds or creates the sender's channel identity.
   *
   * A team member gets an identity row too. It is still a channel identity — it just never becomes
   * a customer, and the participant is typed `TEAM_MEMBER` instead.
   */
  private async findOrCreateIdentity(
    account: ChannelAccount,
    normalized: NormalizedInboundMessage,
  ): Promise<CustomerIdentity> {
    const channelKey = account.channelKey as ChannelKey;

    const existing = await this.identities.findOne({
      where: { channelKey, externalId: normalized.senderExternalId },
    });

    if (existing) {
      // Refresh the display name and last-seen. Never touches matchState: only a human moves that.
      await this.identities.update(existing.id, {
        lastSeenAt: normalized.sentAt,
        ...(normalized.senderDisplayName && normalized.senderDisplayName !== existing.displayName
          ? { displayName: normalized.senderDisplayName }
          : {}),
        ...(normalized.senderPhone && !existing.phone ? { phone: normalized.senderPhone } : {}),
      });
      return this.identities.findOneOrFail({ where: { id: existing.id } });
    }

    try {
      const created = await this.identities.save(
        this.identities.create({
          channelKey,
          channelAccountId: account.id,
          externalId: normalized.senderExternalId,
          phone: normalized.senderPhone,
          displayName: normalized.senderDisplayName,
          // UNRESOLVED with no customer. The database check constraint enforces the pairing.
          matchState: IdentityMatchState.UNRESOLVED,
          customerId: null,
          lastSeenAt: normalized.sentAt,
        }),
      );
      this.metrics.increment('crm.identity_created');
      return created;
    } catch (error) {
      // Another conversation's message created it between our read and write.
      if ((error as { code?: string }).code === '23505') {
        return this.identities.findOneOrFail({
          where: { channelKey, externalId: normalized.senderExternalId },
        });
      }
      throw error;
    }
  }

  /**
   * Promotes a conversation that was recorded as DIRECT before its group existed.
   *
   * A message from a group that has not been synced yet is deliberately stored as DIRECT rather
   * than dropped — the message is real either way. The comment below that decision has always said
   * "a resync reconciles the kind", and nothing ever did: `POST /groups/sync` creates group rows and
   * never revisits conversations, so a conversation created in that window stayed mislabelled
   * forever, with `kind = DIRECT` and a null `groupId`, however many group messages arrived
   * afterwards.
   *
   * Found by the Phase 5L real-WhatsApp validation, where a test group's conversation could not be
   * located by its group at all.
   *
   * Only ever DIRECT → GROUP. A conversation is never demoted: `groupId` going away would mean the
   * group was deleted, and rewriting history to match is not this method's business.
   */
  private async reconcileKind(conversation: Conversation, group: Group | null): Promise<Conversation> {
    const misfiled =
      group !== null && conversation.kind === ConversationKind.DIRECT && conversation.groupId === null;
    if (!misfiled) return conversation;

    await this.conversations.update(conversation.id, {
      kind: ConversationKind.GROUP,
      groupId: group.id,
      subject: conversation.subject ?? group.name ?? null,
    });

    this.logger.log('Conversation reconciled to GROUP now that its group is synced', {
      conversationId: conversation.id,
      groupId: group.id,
    });
    this.metrics.increment('crm.conversation_kind_reconciled');

    return this.conversations.findOneOrFail({ where: { id: conversation.id } });
  }

  private async findOrCreateConversation(
    account: ChannelAccount,
    descriptor: ConversationDescriptor,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const existing = await this.conversations.findOne({
      where: {
        channelAccountId: account.id,
        externalConversationId: descriptor.externalConversationId,
      },
    });

    const isGroup = Boolean(descriptor.externalGroupId);
    const group = descriptor.externalGroupId
      ? await this.groups.findOne({
          where: { channelAccountId: account.id, externalId: descriptor.externalGroupId },
        })
      : null;

    if (existing) return { conversation: await this.reconcileKind(existing, group), created: false };

    // A GROUP conversation requires a synced group row (a check constraint enforces it). If the
    // group has not been synced yet, record it as DIRECT rather than dropping the message — the
    // message is real either way, and a resync reconciles the kind.
    const kind = isGroup && group ? ConversationKind.GROUP : ConversationKind.DIRECT;
    if (isGroup && !group) {
      this.logger.warn('Group message arrived for an unsynced group; recording as DIRECT until resync', {
        channelAccountId: account.id,
        externalGroupId: descriptor.externalGroupId,
      });
    }

    try {
      const conversation = await this.conversations.save(
        this.conversations.create({
          channelKey: account.channelKey as ChannelKey,
          channelAccountId: account.id,
          externalConversationId: descriptor.externalConversationId,
          kind,
          groupId: kind === ConversationKind.GROUP ? group!.id : null,
          subject: group?.name ?? descriptor.subjectHint ?? null,
          status: ConversationStatus.OPEN,
          // customerId stays null: a conversation existing is not evidence of who it belongs to.
          customerId: null,
        }),
      );

      this.metrics.increment('crm.conversation_created', { kind });
      return { conversation, created: true };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return {
          conversation: await this.conversations.findOneOrFail({
            where: {
              channelAccountId: account.id,
              externalConversationId: descriptor.externalConversationId,
            },
          }),
          created: false,
        };
      }
      throw error;
    }
  }

  /**
   * Records the sender as a participant.
   *
   * Participant typing follows the same evidence rule as Phase 2: `ACCOUNT` if it is us,
   * `TEAM_MEMBER` on a registered identity, `CUSTOMER` only on a CONFIRMED identity, and `UNKNOWN`
   * otherwise. Nothing here promotes an unknown sender to a customer.
   */
  private async upsertParticipant(
    conversation: Conversation,
    normalized: NormalizedInboundMessage,
    identity: CustomerIdentity,
    account: ChannelAccount,
  ): Promise<void> {
    const teamIdentity = await this.teamIdentities.findOne({
      where: [
        { channelKey: account.channelKey as ChannelKey, externalId: normalized.senderExternalId, isActive: true },
        ...(normalized.senderPhone
          ? [{ channelKey: account.channelKey as ChannelKey, phone: normalized.senderPhone, isActive: true }]
          : []),
      ],
    });

    const isAccount =
      normalized.fromMe ||
      Boolean(account.accountPhone && normalized.senderPhone === account.accountPhone);

    const participantType = isAccount
      ? ConversationParticipantType.ACCOUNT
      : teamIdentity
        ? ConversationParticipantType.TEAM_MEMBER
        : identity.matchState === IdentityMatchState.CONFIRMED && identity.customerId
          ? ConversationParticipantType.CUSTOMER
          : ConversationParticipantType.UNKNOWN;

    const existing = await this.participants.findOne({
      where: { conversationId: conversation.id, externalId: normalized.senderExternalId },
    });

    if (existing) {
      await this.participants.update(existing.id, {
        lastSeenAt: normalized.sentAt,
        isActive: true,
        participantType,
        customerIdentityId: identity.id,
        customerId: participantType === ConversationParticipantType.CUSTOMER ? identity.customerId : null,
        teamMemberIdentityId: teamIdentity?.id ?? null,
        ...(normalized.senderDisplayName ? { displayName: normalized.senderDisplayName } : {}),
      });
      return;
    }

    try {
      await this.participants.save(
        this.participants.create({
          conversationId: conversation.id,
          externalId: normalized.senderExternalId,
          customerIdentityId: identity.id,
          customerId: participantType === ConversationParticipantType.CUSTOMER ? identity.customerId : null,
          teamMemberIdentityId: teamIdentity?.id ?? null,
          participantType,
          displayName: normalized.senderDisplayName,
          phone: normalized.senderPhone,
          firstSeenAt: normalized.sentAt,
          lastSeenAt: normalized.sentAt,
        }),
      );
    } catch (error) {
      // Concurrent insert for the same participant — harmless.
      if ((error as { code?: string }).code !== '23505') throw error;
    }
  }

  /** Emitted by the caller once the message row exists, so the event carries a real message id. */
  emitCreated(conversation: Conversation): void {
    this.realtime.emitConversationEvent('conversation.created', {
      conversationId: conversation.id,
      channelAccountId: conversation.channelAccountId,
      kind: conversation.kind,
      status: conversation.status,
      groupId: conversation.groupId,
    });
  }
}
