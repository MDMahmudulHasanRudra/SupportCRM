import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, IsNull, LessThan, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { Message } from '../messaging/entities/message.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  ConversationControlState,
  ConversationKind,
  ConversationPriority,
  ConversationStatus,
  StateChangeSource,
  isControlTransitionAllowed,
  isStatusTransitionAllowed,
  toSpecState,
} from './conversation-states';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import {
  ConversationAssignment,
  ConversationStateHistory,
} from './entities/conversation-history.entity';

/** What a conversation with no messages yet contributes to the inbox list. */
const EMPTY_PREVIEW = { lastMessagePreview: null, lastMessageDirection: null } as const;

export interface Actor {
  id: string | null;
  username: string | null;
}

/**
 * Conversations: state, assignment, takeover and history (Phase 3 brief §3, §6, §7, §8, §10).
 *
 * ## This service stores state. It does not decide anything.
 *
 * The brief §6 and §16 are explicit, and it is worth being precise about what that rules out.
 * There is no method here that answers "should AI reply", no keyword matching, no confidence, no
 * escalation trigger. `setControlState` records that a human moved a conversation to `HUMAN_ACTIVE`;
 * it does not decide when that should happen. The Phase 5 Message Decision Engine reads this state
 * and interprets it — that separation is `PROJECT_SPEC.md` §159/§161, and collapsing it would put
 * decision logic in three places instead of one.
 *
 * ## Every transition is recorded
 *
 * Status and control changes both write `conversation_state_history` with an actor and a reason.
 * `conversations` answers "what now"; the history answers "how, and who decided" — the question
 * that actually matters when reviewing why a customer waited.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new AppLogger(ConversationService.name);

  constructor(
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(ConversationStateHistory)
    private readonly history: Repository<ConversationStateHistory>,
    @InjectRepository(ConversationAssignment)
    private readonly assignments: Repository<ConversationAssignment>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    private readonly dataSource: DataSource,
    private readonly realtime: RealtimeGateway,
    private readonly metrics: MetricsService,
  ) {}

  async findOne(id: string): Promise<Conversation> {
    const conversation = await this.conversations.findOne({ where: { id } });
    if (!conversation) throw new NotFoundException(`Conversation ${id} not found`);
    return conversation;
  }

  /** Adds the derived `PROJECT_SPEC.md` §7 state, which is never stored (see conversation-states.ts). */
  withSpecState(conversation: Conversation) {
    return { ...conversation, specState: toSpecState(conversation.status, conversation.controlState) };
  }

  // === listing and history =======================================================================

  /**
   * The inbox query (brief §10, §11).
   *
   * Always paginated. `PROJECT_SPEC.md` §103 forbids loading thousands of records into a browser,
   * and this is the endpoint most likely to be asked for everything at once.
   */
  async list(options: {
    status?: ConversationStatus;
    kind?: ConversationKind;
    customerId?: string;
    assignedToUserId?: string;
    assignedToTeamId?: string;
    channelAccountId?: string;
    controlState?: ConversationControlState;
    unassignedOnly?: boolean;
    pinnedOnly?: boolean;
    activeOnly?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(options.limit ?? 25, 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const qb = this.conversations
      .createQueryBuilder('c')
      .orderBy('c.isPinned', 'DESC')
      .addOrderBy('c.lastMessageAt', 'DESC', 'NULLS LAST');

    if (options.status) qb.andWhere('c.status = :status', { status: options.status });
    if (options.activeOnly) qb.andWhere('c.status NOT IN (:...closed)', { closed: [ConversationStatus.RESOLVED, ConversationStatus.CLOSED] });
    if (options.kind) qb.andWhere('c.kind = :kind', { kind: options.kind });
    if (options.customerId) qb.andWhere('c.customerId = :customerId', { customerId: options.customerId });
    if (options.channelAccountId) {
      qb.andWhere('c.channelAccountId = :accountId', { accountId: options.channelAccountId });
    }
    if (options.controlState) qb.andWhere('c.controlState = :cs', { cs: options.controlState });
    if (options.assignedToUserId) {
      qb.andWhere('c.assignedToUserId = :userId', { userId: options.assignedToUserId });
    }
    if (options.assignedToTeamId) {
      qb.andWhere('c.assignedToTeamId = :teamId', { teamId: options.assignedToTeamId });
    }
    if (options.unassignedOnly) {
      qb.andWhere('c.assignedToUserId IS NULL AND c.assignedToTeamId IS NULL');
    }
    if (options.pinnedOnly) qb.andWhere('c.isPinned = true');

    if (options.search) {
      // Subject, or the message body via the Phase 2 full-text index. `plainto_tsquery` because the
      // input is untrusted and `to_tsquery` would let a user inject query operators.
      const term = `%${options.search}%`;
      qb.andWhere(
        new Brackets((w) => {
          w.where('c.subject ILIKE :term', { term }).orWhere(
            `EXISTS (
               SELECT 1 FROM messages m
               WHERE m."conversationId" = c.id
                 AND to_tsvector('simple', coalesce(m.body, '')) @@ plainto_tsquery('simple', :q)
             )`,
            { q: options.search },
          );
        }),
      );
    }

    const [items, total] = await qb.skip(offset).take(limit).getManyAndCount();
    const previews = await this.lastMessagePreviews(items.map((c) => c.id));

    return {
      items: items.map((c) => ({ ...this.withSpecState(c), ...(previews.get(c.id) ?? EMPTY_PREVIEW) })),
      total,
      limit,
      offset,
    };
  }

  /**
   * The most recent message of each conversation, for the inbox list.
   *
   * One query for the whole page rather than one per row: an inbox of fifty conversations must not
   * become fifty round trips. `DISTINCT ON` is the Postgres way to take the newest row per group
   * without a window function and a subquery around it.
   *
   * The body is truncated here rather than in the browser — a preview line has no use for eight
   * kilobytes of message, and sending it would make the list payload enormous for no benefit.
   */
  private async lastMessagePreviews(
    conversationIds: string[],
  ): Promise<Map<string, { lastMessagePreview: string | null; lastMessageDirection: string | null }>> {
    const map = new Map<string, { lastMessagePreview: string | null; lastMessageDirection: string | null }>();
    if (conversationIds.length === 0) return map;

    const rows = await this.messages.manager.query<
      Array<{ conversationId: string; body: string | null; direction: string; contentType: string }>
    >(
      `
      SELECT DISTINCT ON (m."conversationId")
             m."conversationId", m.body, m.direction, m."contentType"
      FROM messages m
      WHERE m."conversationId" = ANY($1)
      ORDER BY m."conversationId", m."sentAt" DESC
      `,
      [conversationIds],
    );

    for (const row of rows) {
      // A media message has no body worth previewing; naming the kind is more useful than a blank.
      const preview =
        row.body && row.body.trim().length > 0
          ? row.body.slice(0, 160)
          : row.contentType && row.contentType !== 'TEXT'
            ? `[${row.contentType.toLowerCase().replace(/_/g, ' ')}]`
            : null;

      map.set(row.conversationId, { lastMessagePreview: preview, lastMessageDirection: row.direction });
    }

    return map;
  }

  /**
   * Message history for one conversation.
   *
   * Cursor-based on `sentAt`, not offset-based. A long-running support conversation grows while it
   * is being read, and offset paging silently skips or repeats rows when it does
   * (`PROJECT_SPEC.md` §103).
   */
  async listMessages(
    conversationId: string,
    options: { limit?: number; before?: Date; beforeId?: string } = {},
  ) {
    await this.findOne(conversationId);
    const limit = Math.min(options.limit ?? 50, 200);

    const qb = this.messages
      .createQueryBuilder('m')
      .where('m.conversationId = :id', { id: conversationId })
      .orderBy('m.sentAt', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit + 1); // one extra to detect another page without a second COUNT

    if (options.before && options.beforeId) {
      qb.andWhere('(m.sentAt < :before OR (m.sentAt = :before AND m.id < :beforeId))', { before: options.before, beforeId: options.beforeId });
    } else if (options.before) qb.andWhere('m.sentAt < :before', { before: options.before });

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items,
      hasMore,
      nextCursor: hasMore ? items[items.length - 1].sentAt.toISOString() : null,
      nextCursorId: hasMore ? items[items.length - 1].id : null,
    };
  }

  async listParticipants(conversationId: string, includeInactive = false) {
    await this.findOne(conversationId);
    const items = await this.participants.find({
      where: { conversationId, ...(includeInactive ? {} : { isActive: true }) },
      order: { participantType: 'ASC', displayName: 'ASC' },
    });
    return { items, total: items.length };
  }

  async listStateHistory(conversationId: string, options: { limit?: number; offset?: number } = {}) {
    await this.findOne(conversationId);
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const [items, total] = await this.history.findAndCount({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });
    return { items, total, limit, offset };
  }

  async listAssignmentHistory(conversationId: string, options: { limit?: number; offset?: number } = {}) {
    await this.findOne(conversationId);
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const [items, total] = await this.assignments.findAndCount({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });
    return { items, total, limit, offset };
  }

  // === state =====================================================================================

  /** Moves the lifecycle status, validating the transition and recording it. */
  async setStatus(
    id: string,
    status: ConversationStatus,
    actor: Actor,
    options: { reason?: string | null; source?: StateChangeSource } = {},
  ): Promise<Conversation> {
    const conversation = await this.findOne(id);

    if (!isStatusTransitionAllowed(conversation.status, status)) {
      throw new BadRequestException(
        conversation.status === status
          ? `Conversation is already ${status}`
          : `Cannot move a conversation from ${conversation.status} to ${status}`,
      );
    }

    await this.conversations.update(id, {
      status,
      ...(status === ConversationStatus.RESOLVED
        ? { resolvedAt: new Date(), resolvedById: actor.id }
        : {}),
      ...(status === ConversationStatus.OPEN ? { resolvedAt: null, resolvedById: null } : {}),
    });

    await this.recordHistory({
      conversationId: id,
      previousStatus: conversation.status,
      status,
      source: options.source ?? StateChangeSource.HUMAN,
      actor,
      reason: options.reason ?? null,
    });

    const updated = await this.findOne(id);
    this.metrics.increment('crm.status_changed', { to: status });

    // Named events for the two transitions an operator actually watches for.
    if (status === ConversationStatus.RESOLVED) this.emit('conversation.resolved', updated, actor);
    else if (conversation.status === ConversationStatus.RESOLVED && status === ConversationStatus.OPEN) {
      this.emit('conversation.reopened', updated, actor);
    } else this.emit('conversation.updated', updated, actor);

    return updated;
  }

  /**
   * Moves the control axis — who is allowed to respond.
   *
   * Stored, not interpreted. Phase 5 reads it.
   */
  async setControlState(
    id: string,
    controlState: ConversationControlState,
    actor: Actor,
    options: { reason?: string | null; pausedUntil?: Date | null; source?: StateChangeSource } = {},
  ): Promise<Conversation> {
    const conversation = await this.findOne(id);

    if (!isControlTransitionAllowed(conversation.controlState, controlState)) {
      throw new BadRequestException(`Conversation control state is already ${controlState}`);
    }

    await this.conversations.update(id, {
      controlState,
      pausedUntil:
        controlState === ConversationControlState.PAUSED ? (options.pausedUntil ?? null) : null,
      // Leaving HUMAN_ACTIVE clears the takeover record; the history keeps it.
      ...(controlState !== ConversationControlState.HUMAN_ACTIVE
        ? { takeoverByUserId: null, takeoverReason: null, takeoverAt: null, takeoverExpiresAt: null }
        : {}),
    });

    await this.recordHistory({
      conversationId: id,
      previousControlState: conversation.controlState,
      controlState,
      source: options.source ?? StateChangeSource.HUMAN,
      actor,
      reason: options.reason ?? null,
    });

    const updated = await this.findOne(id);
    this.metrics.increment('crm.control_state_changed', { to: controlState });
    this.emit('conversation.updated', updated, actor);
    return updated;
  }

  /**
   * A human takes the conversation (brief §7).
   *
   * Sets `HUMAN_ACTIVE` and records who, why, when, and optionally until when. `PROJECT_SPEC.md`
   * §35 requires AI to stop immediately when this happens — that is Phase 5's job to honour, and
   * this is the state it will read.
   *
   * An expiry exists because a human who forgets to release would otherwise leave a conversation
   * permanently outside automation. `expireTakeovers()` sweeps them.
   */
  async startTakeover(
    id: string,
    actor: Actor,
    options: { reason?: string | null; expiresInMinutes?: number | null } = {},
  ): Promise<Conversation> {
    const conversation = await this.findOne(id);

    if (
      conversation.controlState === ConversationControlState.HUMAN_ACTIVE &&
      conversation.takeoverByUserId === actor.id
    ) {
      return conversation; // idempotent: taking over what you already hold is a no-op
    }

    const expiresAt =
      options.expiresInMinutes && options.expiresInMinutes > 0
        ? new Date(Date.now() + options.expiresInMinutes * 60_000)
        : null;

    await this.conversations.update(id, {
      controlState: ConversationControlState.HUMAN_ACTIVE,
      takeoverByUserId: actor.id,
      takeoverReason: options.reason ?? null,
      takeoverAt: new Date(),
      takeoverExpiresAt: expiresAt,
      pausedUntil: null,
    });

    await this.recordHistory({
      conversationId: id,
      previousControlState: conversation.controlState,
      controlState: ConversationControlState.HUMAN_ACTIVE,
      source: StateChangeSource.HUMAN,
      actor,
      reason: options.reason ?? 'Human takeover',
    });

    const updated = await this.findOne(id);
    this.metrics.increment('crm.takeover_started');
    this.emit('conversation.takeover_started', updated, actor);
    return updated;
  }

  /**
   * Releases a takeover back to a nominated control state.
   *
   * Defaults to `AUTOMATION_ACTIVE` rather than `AI_ACTIVE`: releasing to the least autonomous
   * responder is the conservative choice, and `PROJECT_SPEC.md` §36's "release to AI" is then an
   * explicit act rather than a default.
   */
  async endTakeover(
    id: string,
    actor: Actor,
    options: { releaseTo?: ConversationControlState; reason?: string | null; source?: StateChangeSource } = {},
  ): Promise<Conversation> {
    const conversation = await this.findOne(id);

    if (conversation.controlState !== ConversationControlState.HUMAN_ACTIVE) {
      throw new BadRequestException('This conversation is not under human takeover');
    }

    const releaseTo = options.releaseTo ?? ConversationControlState.AUTOMATION_ACTIVE;

    await this.conversations.update(id, {
      controlState: releaseTo,
      takeoverByUserId: null,
      takeoverReason: null,
      takeoverAt: null,
      takeoverExpiresAt: null,
    });

    await this.recordHistory({
      conversationId: id,
      previousControlState: ConversationControlState.HUMAN_ACTIVE,
      controlState: releaseTo,
      source: options.source ?? StateChangeSource.HUMAN,
      actor,
      reason: options.reason ?? 'Takeover released',
    });

    const updated = await this.findOne(id);
    this.metrics.increment('crm.takeover_ended');
    this.emit('conversation.takeover_ended', updated, actor);
    return updated;
  }

  /**
   * Releases takeovers whose expiry has passed. Run by the worker.
   *
   * Attributed to `SYSTEM` with an explicit reason, so the history distinguishes "a human released
   * this" from "it timed out" — a difference that matters when reviewing why automation resumed.
   */
  async expireTakeovers(now = new Date()): Promise<number> {
    const expired = await this.conversations.find({
      where: {
        controlState: ConversationControlState.HUMAN_ACTIVE,
        takeoverExpiresAt: LessThan(now),
      },
      take: 200,
    });

    for (const conversation of expired) {
      await this.endTakeover(
        conversation.id,
        { id: null, username: 'system' },
        {
          reason: 'Takeover expired automatically',
          source: StateChangeSource.SYSTEM,
        },
      ).catch((error) =>
        this.logger.warn('Could not expire a takeover', {
          conversationId: conversation.id,
          error: (error as Error).message,
        }),
      );
    }

    if (expired.length > 0) {
      this.metrics.increment('crm.takeover_expired', {}, expired.length);
      this.logger.log('Expired human takeovers', { count: expired.length });
    }
    return expired.length;
  }

  /** Clears an expired pause, so `PAUSED` with a deadline resolves itself. */
  async expirePauses(now = new Date()): Promise<number> {
    const expired = await this.conversations.find({
      where: { controlState: ConversationControlState.PAUSED, pausedUntil: LessThan(now) },
      take: 200,
    });

    for (const conversation of expired) {
      await this.setControlState(
        conversation.id,
        ConversationControlState.AUTOMATION_ACTIVE,
        { id: null, username: 'system' },
        { reason: 'Pause expired automatically', source: StateChangeSource.SYSTEM },
      ).catch(() => undefined);
    }
    return expired.length;
  }

  async setFlags(
    id: string,
    flags: { aiEnabled?: boolean; automationEnabled?: boolean; priority?: ConversationPriority; isPinned?: boolean },
    actor: Actor,
  ): Promise<{ before: Record<string, unknown>; after: Conversation }> {
    const conversation = await this.findOne(id);
    const before = {
      aiEnabled: conversation.aiEnabled,
      automationEnabled: conversation.automationEnabled,
      priority: conversation.priority,
      isPinned: conversation.isPinned,
    };

    await this.conversations.update(id, {
      ...(flags.aiEnabled !== undefined ? { aiEnabled: flags.aiEnabled } : {}),
      ...(flags.automationEnabled !== undefined ? { automationEnabled: flags.automationEnabled } : {}),
      ...(flags.priority !== undefined ? { priority: flags.priority } : {}),
      ...(flags.isPinned !== undefined ? { isPinned: flags.isPinned } : {}),
    });

    const after = await this.findOne(id);
    this.emit('conversation.updated', after, actor);
    return { before, after };
  }

  // === assignment ================================================================================

  /**
   * Assigns a conversation, preserving history (brief §8).
   *
   * Closing the previous open row and opening a new one in one transaction is what makes the
   * partial unique index (`at most one open assignment`) hold under concurrency: two simultaneous
   * assignments cannot both leave `unassignedAt` null.
   */
  async assign(
    id: string,
    target: { userId?: string | null; teamId?: string | null },
    actor: Actor,
    reason?: string | null,
  ): Promise<Conversation> {
    await this.findOne(id);

    const hasUser = Boolean(target.userId);
    const hasTeam = Boolean(target.teamId);
    if (hasUser === hasTeam) {
      throw new BadRequestException('Assign to exactly one of a user or a team.');
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        ConversationAssignment,
        { conversationId: id, unassignedAt: IsNull() },
        { unassignedAt: new Date(), unassignedById: actor.id },
      );

      await manager.save(
        manager.create(ConversationAssignment, {
          conversationId: id,
          assignedToUserId: target.userId ?? null,
          assignedToTeamId: target.teamId ?? null,
          assignedById: actor.id,
          reason: reason ?? null,
        }),
      );

      await manager.update(Conversation, id, {
        assignedToUserId: target.userId ?? null,
        assignedToTeamId: target.teamId ?? null,
        assignedAt: new Date(),
      });

      if (target.userId) {
        await manager.query(`INSERT INTO workspace_notifications ("userId",title,body,href)
          VALUES ($1,$2,$3,$4)`, [target.userId, 'A conversation is assigned to you',
          'Open your support queue to review and reply.', `/conversations?conversation=${id}`]);
      }
    });

    const updated = await this.findOne(id);
    this.metrics.increment('crm.assigned', { to: hasUser ? 'user' : 'team' });
    this.emit('conversation.assigned', updated, actor);
    return updated;
  }

  /** Clears the assignment. The history row is closed, never deleted. */
  async unassign(id: string, actor: Actor, reason?: string | null): Promise<Conversation> {
    await this.findOne(id);

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        ConversationAssignment,
        { conversationId: id, unassignedAt: IsNull() },
        { unassignedAt: new Date(), unassignedById: actor.id },
      );
      await manager.update(Conversation, id, {
        assignedToUserId: null,
        assignedToTeamId: null,
        assignedAt: null,
      });
    });

    const updated = await this.findOne(id);
    this.emit('conversation.assigned', updated, actor, { unassigned: true, reason });
    return updated;
  }

  // === internals =================================================================================

  private async recordHistory(entry: {
    conversationId: string;
    previousStatus?: ConversationStatus | null;
    status?: ConversationStatus | null;
    previousControlState?: ConversationControlState | null;
    controlState?: ConversationControlState | null;
    source: StateChangeSource;
    actor: Actor;
    reason: string | null;
  }): Promise<void> {
    await this.history.save(
      this.history.create({
        conversationId: entry.conversationId,
        previousStatus: entry.previousStatus ?? null,
        status: entry.status ?? null,
        previousControlState: entry.previousControlState ?? null,
        controlState: entry.controlState ?? null,
        source: entry.source,
        actorId: entry.actor.id,
        actorUsername: entry.actor.username,
        reason: entry.reason,
      }),
    );
  }

  /**
   * Emits a normalized conversation event (brief §12).
   *
   * Identifiers and state only — never a message body or a customer note. This is a fan-out to
   * every subscribed operator socket, and content belongs behind an authorised fetch
   * (`PROJECT_SPEC.md` §110).
   */
  private emit(
    event: Parameters<RealtimeGateway['emitConversationEvent']>[0],
    conversation: Conversation,
    actor: Actor,
    extra: Record<string, unknown> = {},
  ): void {
    this.realtime.emitConversationEvent(event, {
      conversationId: conversation.id,
      channelAccountId: conversation.channelAccountId,
      customerId: conversation.customerId,
      status: conversation.status,
      controlState: conversation.controlState,
      specState: toSpecState(conversation.status, conversation.controlState),
      assignedToUserId: conversation.assignedToUserId,
      assignedToTeamId: conversation.assignedToTeamId,
      actorId: actor.id,
      ...extra,
    });
  }
}
