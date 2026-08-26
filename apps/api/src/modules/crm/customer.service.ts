import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { ChannelKey } from '../channel/entities/channel.entity';
import { Conversation } from './entities/conversation.entity';
import {
  CustomerIdentity,
  IdentityMatchSource,
  IdentityMatchState,
} from './entities/customer-identity.entity';
import { Customer, CustomerSource, CustomerStatus } from './entities/customer.entity';
import {
  CustomerNote,
  EntityTag,
  Tag,
  TaggableEntity,
} from './entities/customer-metadata.entity';

export interface CreateCustomerInput {
  displayName: string;
  primaryPhone?: string | null;
  email?: string | null;
  company?: string | null;
  source?: CustomerSource;
  createdById?: string | null;
}

/**
 * Customers, their channel identities, notes and tags (Phase 3 brief §1, §2, §9).
 *
 * The service's central responsibility is the **identity match lifecycle**, and its central rule is
 * that promotion is always a decision someone made, never a side effect. `UNRESOLVED` identities
 * accumulate freely from inbound traffic; moving one to `CONFIRMED` requires an explicit call with
 * an actor, and that call is audited by the controller.
 *
 * `proposeMatch` is the one automated step, and it is deliberately conservative: it proposes
 * `CANDIDATE` only on an exact, unambiguous phone match, and refuses when more than one customer
 * shares the number. A guess that looks like a decision is worse than no guess.
 */
@Injectable()
export class CustomerService {
  private readonly logger = new AppLogger(CustomerService.name);

  constructor(
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(CustomerIdentity) private readonly identities: Repository<CustomerIdentity>,
    @InjectRepository(CustomerNote) private readonly notes: Repository<CustomerNote>,
    @InjectRepository(Tag) private readonly tags: Repository<Tag>,
    @InjectRepository(EntityTag) private readonly entityTags: Repository<EntityTag>,
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  /** Digits only. The same normalisation the team-identity and channel layers use. */
  static normalizePhone(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? digits : null;
  }

  // === customers =================================================================================

  async create(input: CreateCustomerInput): Promise<Customer> {
    const phone = CustomerService.normalizePhone(input.primaryPhone);
    if (input.primaryPhone && !phone) {
      throw new BadRequestException(`"${input.primaryPhone}" is not a usable phone number`);
    }

    const customer = await this.customers.save(
      this.customers.create({
        displayName: input.displayName.trim(),
        primaryPhone: phone,
        email: input.email?.trim() || null,
        company: input.company?.trim() || null,
        status: CustomerStatus.ACTIVE,
        source: input.source ?? CustomerSource.MANUAL,
        createdById: input.createdById ?? null,
      }),
    );

    this.metrics.increment('crm.customer_created', { source: customer.source });
    // The phone number is PII and is deliberately absent from the log line (PROJECT_SPEC.md §110).
    this.logger.log('Customer created', { customerId: customer.id, source: customer.source });
    return customer;
  }

  async findOne(id: string): Promise<Customer> {
    const customer = await this.customers.findOne({ where: { id }, relations: ['identities'] });
    if (!customer) throw new NotFoundException(`Customer ${id} not found`);
    return customer;
  }

  async update(
    id: string,
    changes: Partial<Pick<Customer, 'displayName' | 'email' | 'company' | 'status'>> & { primaryPhone?: string | null },
  ): Promise<{ before: Partial<Customer>; after: Customer }> {
    const before = await this.findOne(id);
    const snapshot = {
      displayName: before.displayName,
      primaryPhone: before.primaryPhone,
      email: before.email,
      company: before.company,
      status: before.status,
    };

    const phone =
      changes.primaryPhone === undefined
        ? undefined
        : CustomerService.normalizePhone(changes.primaryPhone);
    if (changes.primaryPhone && !phone) {
      throw new BadRequestException(`"${changes.primaryPhone}" is not a usable phone number`);
    }

    await this.customers.update(id, {
      ...(changes.displayName !== undefined ? { displayName: changes.displayName.trim() } : {}),
      ...(phone !== undefined ? { primaryPhone: phone } : {}),
      ...(changes.email !== undefined ? { email: changes.email?.trim() || null } : {}),
      ...(changes.company !== undefined ? { company: changes.company?.trim() || null } : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
    });

    return { before: snapshot, after: await this.findOne(id) };
  }

  /**
   * Paginated, searchable customer list (brief §11).
   *
   * Search spans name, phone, email and company. Every term is parameterised — a customer name is
   * untrusted input and must never be concatenated into SQL.
   */
  async list(options: {
    search?: string;
    status?: CustomerStatus;
    tagKeys?: string[];
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(options.limit ?? 25, 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const qb = this.customers.createQueryBuilder('c').orderBy('c.updatedAt', 'DESC');

    if (options.status) qb.andWhere('c.status = :status', { status: options.status });

    if (options.search) {
      const term = `%${options.search}%`;
      const digits = options.search.replace(/\D/g, '');
      qb.andWhere(
        new Brackets((w) => {
          w.where('c.displayName ILIKE :term', { term })
            .orWhere('c.email ILIKE :term', { term })
            .orWhere('c.company ILIKE :term', { term });
          if (digits.length >= 4) w.orWhere('c.primaryPhone LIKE :digits', { digits: `%${digits}%` });
        }),
      );
    }

    if (options.tagKeys?.length) {
      qb.andWhere(
        `EXISTS (
           SELECT 1 FROM entity_tags et
           JOIN tags t ON t.id = et."tagId"
           WHERE et."entityType" = :entityType AND et."entityId" = c.id AND t.key IN (:...tagKeys)
         )`,
        { entityType: TaggableEntity.CUSTOMER, tagKeys: options.tagKeys },
      );
    }

    const [items, total] = await qb.skip(offset).take(limit).getManyAndCount();
    return { items, total, limit, offset };
  }

  // === identities ================================================================================

  async findIdentity(id: string): Promise<CustomerIdentity> {
    const identity = await this.identities.findOne({ where: { id } });
    if (!identity) throw new NotFoundException(`Identity ${id} not found`);
    return identity;
  }

  async listIdentities(options: {
    customerId?: string;
    matchState?: IdentityMatchState;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const qb = this.identities.createQueryBuilder('i').orderBy('i.lastSeenAt', 'DESC', 'NULLS LAST');
    if (options.customerId) qb.andWhere('i.customerId = :customerId', { customerId: options.customerId });
    if (options.matchState) qb.andWhere('i.matchState = :state', { state: options.matchState });
    if (options.search) {
      const term = `%${options.search}%`;
      qb.andWhere(
        new Brackets((w) => {
          w.where('i.displayName ILIKE :term', { term })
            .orWhere('i.phone LIKE :term', { term })
            .orWhere('i.externalId ILIKE :term', { term });
        }),
      );
    }

    const [items, total] = await qb.skip(offset).take(limit).getManyAndCount();
    return { items, total, limit, offset };
  }

  /**
   * Registers a channel identity directly, for an operator adding a known number.
   *
   * `customerId` is optional. Without it the identity is created `UNRESOLVED` — the same state
   * inbound traffic produces — because "an operator typed this number in" is not by itself evidence
   * of whose it is.
   */
  async createIdentity(input: {
    channelKey: ChannelKey;
    externalId?: string;
    phone: string;
    displayName?: string | null;
    customerId?: string | null;
    resolvedById?: string | null;
  }): Promise<CustomerIdentity> {
    const phone = CustomerService.normalizePhone(input.phone);
    if (!phone) throw new BadRequestException(`"${input.phone}" is not a usable phone number`);

    const externalId =
      input.externalId ?? (input.channelKey === ChannelKey.WHATSAPP ? `${phone}@c.us` : phone);

    if (input.customerId) await this.findOne(input.customerId);

    try {
      const identity = await this.identities.save(
        this.identities.create({
          channelKey: input.channelKey,
          externalId,
          phone,
          displayName: input.displayName ?? null,
          customerId: input.customerId ?? null,
          // Linking at creation is a human act, so it is CONFIRMED — but only when a customer was
          // actually named. Otherwise the check constraint would reject a linked UNRESOLVED row.
          matchState: input.customerId ? IdentityMatchState.CONFIRMED : IdentityMatchState.UNRESOLVED,
          matchSource: IdentityMatchSource.MANUAL,
          resolvedById: input.customerId ? (input.resolvedById ?? null) : null,
          resolvedAt: input.customerId ? new Date() : null,
        }),
      );
      return identity;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(
          `An identity for "${externalId}" already exists on ${input.channelKey}. Link it to a customer instead of creating a second.`,
        );
      }
      throw error;
    }
  }

  /**
   * Proposes a customer for an unresolved identity, on an exact phone match only.
   *
   * The only automated step in the match lifecycle, and deliberately timid:
   *  - it proposes `CANDIDATE`, never `CONFIRMED` — a rule may suggest, only a human decides;
   *  - it refuses when several customers share the number, because "probably that one" is exactly
   *    the guess that produces a wrong customer on a real conversation;
   *  - it never touches an identity that is already CANDIDATE, CONFIRMED or REJECTED.
   */
  async proposeMatch(identityId: string): Promise<{ identity: CustomerIdentity; proposed: boolean; reason: string }> {
    const identity = await this.findIdentity(identityId);

    if (identity.matchState !== IdentityMatchState.UNRESOLVED) {
      return { identity, proposed: false, reason: `Identity is already ${identity.matchState}` };
    }
    if (!identity.phone) {
      return { identity, proposed: false, reason: 'Identity has no phone number to match on' };
    }

    const matches = await this.customers.find({ where: { primaryPhone: identity.phone }, take: 5 });

    if (matches.length === 0) {
      return { identity, proposed: false, reason: 'No customer has this phone number' };
    }
    if (matches.length > 1) {
      // Ambiguity is reported, never resolved by picking one.
      return {
        identity,
        proposed: false,
        reason: `${matches.length} customers share this phone number — a human must choose`,
      };
    }

    await this.identities.update(identity.id, {
      customerId: matches[0].id,
      matchState: IdentityMatchState.CANDIDATE,
      matchSource: IdentityMatchSource.EXACT_PHONE,
    });

    this.metrics.increment('crm.identity_candidate_proposed');
    return {
      identity: await this.findIdentity(identity.id),
      proposed: true,
      reason: `Exact phone match with customer "${matches[0].displayName}" — awaiting confirmation`,
    };
  }

  /**
   * Confirms that an identity belongs to a customer. **The only path to `CONFIRMED`.**
   *
   * Backfills the link onto every conversation this identity already participates in that has no
   * customer yet — the point of confirming is that past traffic becomes attributable, not just
   * future traffic. Conversations that already name a *different* customer are left alone: a group
   * with two customers in it must not have its primary rewritten by whoever was confirmed second.
   */
  async confirmIdentity(
    identityId: string,
    customerId: string,
    actorId: string | null,
    note?: string | null,
  ): Promise<CustomerIdentity> {
    const identity = await this.findIdentity(identityId);
    await this.findOne(customerId);

    if (identity.matchState === IdentityMatchState.CONFIRMED && identity.customerId === customerId) {
      return identity;
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(CustomerIdentity, identityId, {
        customerId,
        matchState: IdentityMatchState.CONFIRMED,
        resolvedById: actorId,
        resolvedAt: new Date(),
        resolutionNote: note ?? null,
      });

      const participantRows = await manager.query(
        `SELECT DISTINCT "conversationId" FROM conversation_participants WHERE "customerIdentityId" = $1`,
        [identityId],
      );
      const conversationIds = participantRows.map((r: { conversationId: string }) => r.conversationId);

      if (conversationIds.length > 0) {
        await manager.update(
          'conversation_participants',
          { customerIdentityId: identityId },
          { customerId, participantType: 'CUSTOMER' },
        );
        // Only fill an EMPTY customerId. Never overwrite an existing one.
        await manager
          .createQueryBuilder()
          .update(Conversation)
          .set({ customerId })
          .where('id IN (:...ids)', { ids: conversationIds })
          .andWhere('"customerId" IS NULL')
          .execute();
      }
    });

    this.metrics.increment('crm.identity_confirmed');
    this.logger.log('Customer identity confirmed', { identityId, customerId, actorId });
    return this.findIdentity(identityId);
  }

  /**
   * Records that an identity is NOT a customer.
   *
   * Keeps `customerId` populated on purpose — the row is the record of which customer was ruled
   * out, which is what stops the same wrong match being proposed again. Any conversation that had
   * been attributed on the strength of this identity is detached.
   */
  async rejectIdentity(
    identityId: string,
    actorId: string | null,
    note?: string | null,
  ): Promise<CustomerIdentity> {
    const identity = await this.findIdentity(identityId);
    if (!identity.customerId) {
      throw new BadRequestException(
        'This identity is not linked to any customer, so there is nothing to reject.',
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(CustomerIdentity, identityId, {
        matchState: IdentityMatchState.REJECTED,
        resolvedById: actorId,
        resolvedAt: new Date(),
        resolutionNote: note ?? null,
      });
      await manager.update(
        'conversation_participants',
        { customerIdentityId: identityId },
        { customerId: null, participantType: 'UNKNOWN' },
      );
      await manager.update(Conversation, { customerId: identity.customerId }, { customerId: null });
    });

    this.metrics.increment('crm.identity_rejected');
    return this.findIdentity(identityId);
  }

  // === notes and tags ===========================================================================

  async addNote(
    customerId: string,
    body: string,
    author: { id: string | null; username: string | null },
    isPinned = false,
  ): Promise<CustomerNote> {
    await this.findOne(customerId);
    return this.notes.save(
      this.notes.create({
        customerId,
        body: body.trim(),
        authorId: author.id,
        authorUsername: author.username,
        isPinned,
      }),
    );
  }

  async listNotes(customerId: string, options: { limit?: number; offset?: number } = {}) {
    await this.findOne(customerId);
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const [items, total] = await this.notes.findAndCount({
      where: { customerId },
      order: { isPinned: 'DESC', createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });
    return { items, total, limit, offset };
  }

  /** Creates the tag if it does not exist, then attaches it. Idempotent. */
  async addTag(
    entityType: TaggableEntity,
    entityId: string,
    tagKey: string,
    taggedById: string | null,
  ): Promise<Tag> {
    const key = tagKey.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) {
      throw new BadRequestException(
        'A tag key must be 1–64 characters of lowercase letters, digits, hyphens or underscores.',
      );
    }

    let tag = await this.tags.findOne({ where: { key } });
    if (!tag) {
      tag = await this.tags.save(this.tags.create({ key, label: tagKey.trim() }));
    }

    await this.entityTags
      .save(this.entityTags.create({ tagId: tag.id, entityType, entityId, taggedById }))
      .catch((error: { code?: string }) => {
        // Already attached — the desired end state, not an error.
        if (error.code !== '23505') throw error;
      });

    return tag;
  }

  async removeTag(entityType: TaggableEntity, entityId: string, tagKey: string): Promise<void> {
    const tag = await this.tags.findOne({ where: { key: tagKey.trim().toLowerCase() } });
    if (!tag) return;
    await this.entityTags.delete({ tagId: tag.id, entityType, entityId });
  }

  async listTagsFor(entityType: TaggableEntity, entityId: string): Promise<Tag[]> {
    const attachments = await this.entityTags.find({ where: { entityType, entityId } });
    if (attachments.length === 0) return [];
    return this.tags.find({ where: { id: In(attachments.map((a) => a.tagId)) } });
  }
}
