import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { ChannelKey } from '../channel/entities/channel.entity';
import { User } from '../auth/entities/user.entity';
import { TeamMemberIdentity } from './entities/team-member-identity.entity';

export interface UpsertIdentityInput {
  channelKey: ChannelKey;
  phone: string;
  displayName: string;
  userId?: string | null;
  jobRole?: string | null;
  externalId?: string | null;
}

/**
 * Manages the Support CRM user ↔ channel identity mapping (brief §9).
 *
 * What this enables, and its only job in Phase 2: telling a support executive apart from a customer
 * when a message arrives. Without it every group message looks identical to the classifier.
 *
 * What it deliberately does NOT do is decide what counts as support activity. The brief is explicit
 * — "do not count every message from every internal user as support activity automatically" — and
 * `PROJECT_SPEC.md` §68 makes activity a function of rules and context. This table establishes
 * *who is internal*; Phase 3 decides *what counts*.
 */
@Injectable()
export class TeamIdentityService {
  private readonly logger = new AppLogger(TeamIdentityService.name);

  constructor(
    @InjectRepository(TeamMemberIdentity) private readonly identities: Repository<TeamMemberIdentity>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /**
   * Normalises a phone number to bare digits.
   *
   * Everything about matching depends on this being consistent: an admin types `+880 1711-223344`,
   * a JID carries `8801711223344@c.us`, and a participant list gives `8801711223344`. All three
   * must reduce to the same key or classification silently fails and every message from that person
   * is treated as a customer's.
   */
  static normalizePhone(raw: string): string {
    const digits = (raw ?? '').replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      throw new BadRequestException(
        `"${raw}" is not a usable phone number — expected 7 to 15 digits in international format.`,
      );
    }
    return digits;
  }

  /** WhatsApp's JID for a plain number. Derived rather than asked for — an admin knows the number. */
  static defaultExternalId(channelKey: ChannelKey, phone: string): string {
    return channelKey === ChannelKey.WHATSAPP ? `${phone}@c.us` : phone;
  }

  async create(input: UpsertIdentityInput): Promise<TeamMemberIdentity> {
    const phone = TeamIdentityService.normalizePhone(input.phone);
    const externalId = input.externalId ?? TeamIdentityService.defaultExternalId(input.channelKey, phone);

    if (input.userId) {
      const user = await this.users.findOne({ where: { id: input.userId } });
      if (!user) throw new NotFoundException(`User ${input.userId} not found`);
    }

    const clash = await this.identities.findOne({
      where: [
        { channelKey: input.channelKey, phone },
        { channelKey: input.channelKey, externalId },
      ],
    });
    if (clash) {
      // A number claimed by two people would make classification ambiguous, so the constraint is
      // real rather than advisory. Reactivating the existing row is the operator's call.
      throw new ConflictException(
        `A team identity for ${phone} already exists on this channel (${clash.displayName}).`,
      );
    }

    const identity = await this.identities.save(
      this.identities.create({
        channelKey: input.channelKey,
        phone,
        externalId,
        displayName: input.displayName,
        userId: input.userId ?? null,
        jobRole: input.jobRole ?? null,
        isActive: true,
      }),
    );

    this.logger.log('Team member identity registered', {
      identityId: identity.id,
      channelKey: identity.channelKey,
      // The phone number is PII and is not logged (PROJECT_SPEC.md §110, §129).
      linkedUser: Boolean(identity.userId),
    });
    return identity;
  }

  async update(
    id: string,
    changes: { displayName?: string; jobRole?: string | null; userId?: string | null; isActive?: boolean },
  ): Promise<TeamMemberIdentity> {
    const identity = await this.findOne(id);

    if (changes.userId) {
      const user = await this.users.findOne({ where: { id: changes.userId } });
      if (!user) throw new NotFoundException(`User ${changes.userId} not found`);
    }

    await this.identities.update(identity.id, {
      ...(changes.displayName !== undefined ? { displayName: changes.displayName } : {}),
      ...(changes.jobRole !== undefined ? { jobRole: changes.jobRole } : {}),
      ...(changes.userId !== undefined ? { userId: changes.userId } : {}),
      ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
    });
    return this.findOne(id);
  }

  async findOne(id: string): Promise<TeamMemberIdentity> {
    const identity = await this.identities.findOne({ where: { id } });
    if (!identity) throw new NotFoundException(`Team member identity ${id} not found`);
    return identity;
  }

  async list(options: { channelKey?: ChannelKey; includeInactive?: boolean } = {}) {
    const items = await this.identities.find({
      where: {
        ...(options.channelKey ? { channelKey: options.channelKey } : {}),
        ...(options.includeInactive ? {} : { isActive: true }),
      },
      order: { displayName: 'ASC' },
    });
    return { items, total: items.length };
  }

  /**
   * Deactivates rather than deletes.
   *
   * The row is what explains why historical messages were classified as TEAM_MESSAGE. Deleting it
   * would leave that history unexplainable, and `PROJECT_SPEC.md` favours soft deactivation for
   * exactly this reason.
   */
  async deactivate(id: string): Promise<TeamMemberIdentity> {
    await this.identities.update(id, { isActive: false });
    return this.findOne(id);
  }
}
