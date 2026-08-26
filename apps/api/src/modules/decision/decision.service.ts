import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { RateLimitService } from '../../common/redis/rate-limit.service';
import { AutomationExecution, ExecutionOutcome } from '../automation/entities/automation-execution.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { ConversationControlState, ConversationStatus } from '../crm/conversation-states';
import { Conversation } from '../crm/entities/conversation.entity';
import { EscalationService } from '../escalation/escalation.service';
import { Escalation, EscalationReason } from '../escalation/entities/escalation.entity';
import { Message } from '../messaging/entities/message.entity';
import { MessageService } from '../messaging/message.service';
import { OutboundSource } from '../messaging/entities/outbound-message.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DECISION_SETTINGS } from './decision-context';
import { DecisionEngine } from './decision-engine.service';
import { AiRun } from './entities/ai-run.entity';
import { DecisionLog } from './entities/decision-log.entity';
import {
  DecisionOutcome,
  DecisionReason,
  DecisionStatus,
  REPLYING_OUTCOMES,
  type Decision,
} from './decision-types';
import { SettingsService } from '../settings/settings.service';

/**
 * Runs a decision and applies it.
 *
 * The split matters: `DecisionEngine` decides and cannot send; this service is the only thing that
 * turns a decision into an action. Keeping them apart is what makes "no automatic response bypasses
 * the engine" checkable — every automatic send in the system originates here, from a decision, with
 * that decision's id attached to it.
 *
 * ## Claim first
 *
 * The first database write is the decision-log row, and `decision_logs.messageId` is uniquely
 * indexed. A duplicate webhook, a redelivered job or a second worker all collide on it and return
 * without deciding. That is the structural guarantee behind "a duplicate must never produce a
 * duplicate reply" — not a flag, not a check-then-act.
 */
@Injectable()
export class DecisionService {
  private readonly logger = new AppLogger(DecisionService.name);

  constructor(
    @InjectRepository(DecisionLog) private readonly logs: Repository<DecisionLog>,
    @InjectRepository(AutomationRule) private readonly rules: Repository<AutomationRule>,
    @InjectRepository(AutomationExecution) private readonly executions: Repository<AutomationExecution>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    private readonly engine: DecisionEngine,
    private readonly messages: MessageService,
    private readonly escalations: EscalationService,
    private readonly realtime: RealtimeGateway,
    private readonly settings: SettingsService,
    private readonly rateLimits: RateLimitService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * The entry point the inbound processor calls.
   *
   * Never throws. A message that has been persisted must not be undone by a decision failure, and
   * the caller is in the middle of the inbound path — so every error becomes a FAILED decision plus
   * an escalation, which is a person looking at it rather than a customer being ignored.
   */
  async handleInbound(message: Message, conversation: Conversation): Promise<DecisionLog | null> {
    const started = Date.now();

    const log = await this.claim(message, conversation);
    if (!log) {
      this.metrics.increment('decision.duplicate_suppressed');
      return null;
    }

    this.realtime.emitDecisionEvent('decision.started', {
      decisionId: log.id,
      conversationId: conversation.id,
      messageId: message.id,
    });

    let decision: Decision;
    try {
      decision = await this.engine.decide(message, conversation);
    } catch (error) {
      this.logger.error('The decision engine threw; escalating', {
        decisionId: log.id,
        conversationId: conversation.id,
        error: (error as Error).message,
      });
      this.metrics.increment('decision.engine_error');

      await this.logs.update(log.id, {
        status: DecisionStatus.FAILED,
        outcome: DecisionOutcome.FAILED,
        reasonCode: DecisionReason.ENGINE_ERROR,
        reason: 'The decision engine failed. A person was asked to look at this conversation.',
        error: (error as Error).message.slice(0, 1_000),
        humanRequired: true,
        processingTimeMs: Date.now() - started,
        completedAt: new Date(),
      });

      // The customer's message is stored and somebody is told. Nothing is silently lost.
      await this.escalations
        .raise({
          conversationId: conversation.id,
          messageId: message.id,
          decisionId: log.id,
          reason: EscalationReason.REPEATED_FAILURE,
          detail: 'The decision engine failed while processing this message.',
        })
        .catch(() => undefined);

      this.realtime.emitDecisionEvent('decision.failed', {
        decisionId: log.id,
        conversationId: conversation.id,
      });

      return this.logs.findOne({ where: { id: log.id } });
    }

    await this.apply(log, decision, message, conversation);

    const elapsed = Date.now() - started;
    this.metrics.increment('decision.processed', { outcome: decision.outcome });
    this.metrics.observeDuration('decision.latency_ms', elapsed, { outcome: decision.outcome });

    await this.logs.update(log.id, {
      status: DecisionStatus.COMPLETED,
      processingTimeMs: elapsed,
      completedAt: new Date(),
    });

    this.realtime.emitDecisionEvent('decision.completed', {
      decisionId: log.id,
      conversationId: conversation.id,
      messageId: message.id,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
    });

    return this.logs.findOne({ where: { id: log.id } });
  }

  /**
   * Claims the message.
   *
   * Returns null when somebody else already has it. Insert-and-catch-23505, the same pattern the
   * inbound and outbound paths use, because a `SELECT` followed by an `INSERT` has a window in it
   * and this is precisely the place where that window would cost a customer a duplicate reply.
   */
  private async claim(message: Message, conversation: Conversation): Promise<DecisionLog | null> {
    try {
      return await this.logs.save(
        this.logs.create({
          messageId: message.id,
          conversationId: conversation.id,
          channelAccountId: message.channelAccountId,
          groupId: message.groupId ?? null,
          customerId: conversation.customerId ?? null,
          status: DecisionStatus.IN_PROGRESS,
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return null;
      throw error;
    }
  }

  /** Writes what was decided, then does it. */
  private async apply(
    log: DecisionLog,
    decision: Decision,
    message: Message,
    conversation: Conversation,
  ): Promise<void> {
    await this.logs.update(log.id, {
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      reason: decision.reason.slice(0, 1_000),
      ruleId: decision.rule?.id ?? null,
      ruleVersion: decision.rule?.version ?? null,
      profileId: decision.profileId ?? null,
      candidateRuleIds: decision.candidateRuleIds?.length ? decision.candidateRuleIds : null,
      aiProvider: decision.ai?.provider ?? null,
      aiModel: decision.ai?.model ?? null,
      confidence:
        decision.ai?.confidence === null || decision.ai?.confidence === undefined
          ? null
          : String(decision.ai.confidence),
      // Always false: the number is a model's self-report, not a measured probability.
      confidenceCalibrated: false,
      knowledgeUsed: decision.knowledge?.used ?? false,
      knowledgeArticleIds: decision.knowledge?.articleIds?.length ? decision.knowledge.articleIds : null,
      knowledgeChunkIds: decision.knowledge?.chunkIds?.length ? decision.knowledge.chunkIds : null,
      escalationReason: decision.escalation?.reason ?? null,
      humanRequired: decision.outcome === DecisionOutcome.HUMAN_HANDOFF,
    });

    await this.recordExecutions(log, decision, message, conversation);
    await this.applyEffects(decision, conversation);

    if (REPLYING_OUTCOMES.includes(decision.outcome) && decision.reply) {
      await this.send(log, decision, message, conversation);
    }

    if (decision.escalation) {
      await this.escalations.raise({
        conversationId: conversation.id,
        messageId: message.id,
        decisionId: log.id,
        reason: decision.escalation.reason,
        detail: decision.escalation.detail ?? decision.reason,
        confidence: decision.ai?.confidence ?? null,
      });
    }
  }

  /**
   * Sends the reply.
   *
   * The idempotency key is derived from the decision, so a retried executor cannot produce a second
   * message even if the decision row is somehow processed twice — belt and braces alongside the
   * unique claim.
   */
  private async send(
    log: DecisionLog,
    decision: Decision,
    message: Message,
    conversation: Conversation,
  ): Promise<void> {
    const budgetSeconds = Number(
      await this.settings.get<number>(DECISION_SETTINGS.AUTO_REPLY_WINDOW_SECONDS, 300),
    );
    const budgetCount = Number(
      await this.settings.get<number>(DECISION_SETTINGS.AUTO_REPLIES_PER_CONVERSATION, 5),
    );

    // Consume the budget only when actually replying, so a conversation full of ignores does not
    // exhaust its allowance.
    await this.rateLimits.consume(`decision:replies:${conversation.id}`, budgetCount, budgetSeconds * 1_000);

    try {
      const outbound = await this.messages.send({
        channelAccountId: message.channelAccountId,
        externalConversationId: message.externalConversationId,
        body: decision.reply as string,
        source: decision.outcome === DecisionOutcome.RULE_REPLY ? OutboundSource.AUTOMATION : OutboundSource.AI,
        idempotencyKey: `decision:${log.id}`,
        decisionId: log.id,
        createdById: null,
      });

      await this.logs.update(log.id, { responseMessageId: outbound.id });

      // Answering means the ball is with the customer again — unless a human owns it, which this
      // path cannot reach.
      if (conversation.status !== ConversationStatus.WAITING_FOR_HUMAN) {
        await this.conversations
          .update(conversation.id, { status: ConversationStatus.WAITING_FOR_CUSTOMER })
          .catch(() => undefined);
      }
    } catch (error) {
      // The decision was sound; sending failed. Record it and get a person involved rather than
      // leaving the customer with silence and nobody knowing.
      this.logger.warn('Sending an automatic reply failed', {
        decisionId: log.id,
        error: (error as Error).message,
      });
      this.metrics.increment('decision.send_failed');

      await this.logs.update(log.id, {
        error: `Reply could not be sent: ${(error as Error).message}`.slice(0, 1_000),
        humanRequired: true,
      });

      await this.escalations
        .raise({
          conversationId: conversation.id,
          messageId: message.id,
          decisionId: log.id,
          reason: EscalationReason.REPEATED_FAILURE,
          detail: 'An automatic reply was decided but could not be sent.',
        })
        .catch(() => undefined);
    }
  }

  /**
   * Records what each matching rule did, and advances the winner's counters.
   *
   * This is the raw material for automation health (brief §23): which rules never fire, which
   * frequently lose to another, which are stuck in cooldown.
   */
  private async recordExecutions(
    log: DecisionLog,
    decision: Decision,
    message: Message,
    conversation: Conversation,
  ): Promise<void> {
    if (!decision.candidateRuleIds?.length) return;

    const winnerId = decision.rule?.id ?? null;

    for (const ruleId of decision.candidateRuleIds) {
      await this.executions
        .save(
          this.executions.create({
            ruleId,
            ruleVersion: ruleId === winnerId ? (decision.rule?.version ?? 1) : 1,
            decisionId: log.id,
            conversationId: conversation.id,
            messageId: message.id,
            outcome: ruleId === winnerId ? ExecutionOutcome.MATCHED_WON : ExecutionOutcome.MATCHED_LOST,
            detail: ruleId === winnerId ? decision.reason.slice(0, 500) : 'A more specific or higher-priority rule won',
          }),
        )
        .catch(() => undefined);
    }

    if (winnerId) {
      // `increment` rather than a read-modify-write: two workers deciding on two messages for the
      // same rule at the same moment must both count.
      await this.rules
        .createQueryBuilder()
        .update(AutomationRule)
        .set({ executionCount: () => '"executionCount" + 1', lastMatchedAt: new Date() })
        .where('id = :id', { id: winnerId })
        .execute()
        .catch(() => undefined);
    }
  }

  /** Tags, state changes and assignments a rule asked for. Best-effort, never fatal. */
  private async applyEffects(decision: Decision, conversation: Conversation): Promise<void> {
    for (const effect of decision.effects ?? []) {
      try {
        switch (effect.type) {
          case 'SET_CONVERSATION_STATE':
            if (Object.values(ConversationStatus).includes(effect.value as ConversationStatus)) {
              await this.conversations.update(conversation.id, { status: effect.value as ConversationStatus });
            }
            break;
          case 'ASSIGN_TEAM':
            await this.conversations.update(conversation.id, { assignedToTeamId: effect.targetId });
            break;
          case 'ASSIGN_AGENT':
            await this.conversations.update(conversation.id, {
              assignedToUserId: effect.targetId,
              controlState: ConversationControlState.HUMAN_ACTIVE,
            });
            break;
          default:
            // Tagging runs through the CRM's tag service in a later pass; the effect is recorded on
            // the decision either way, so nothing is silently dropped.
            break;
        }
      } catch (error) {
        this.logger.warn('A rule side effect failed', {
          conversationId: conversation.id,
          effect: effect.type,
          error: (error as Error).message,
        });
      }
    }
  }

  // === reads for the trace UI =====================================================================

  async findOne(id: string): Promise<DecisionLog | null> {
    return this.logs.findOne({ where: { id } });
  }

  async findForMessage(messageId: string): Promise<DecisionLog | null> {
    return this.logs.findOne({ where: { messageId } });
  }

  /**
   * Everything needed to answer "why did the system respond to this message?" (brief §30).
   *
   * One round trip rather than four, because the trace panel needs all of it at once and a partial
   * answer ("it replied") without the rule, the AI run and the escalation is exactly the kind of
   * half-explanation this phase exists to remove.
   */
  async trace(id: string) {
    const decision = await this.logs.findOne({ where: { id } });
    if (!decision) return null;

    const manager = this.logs.manager;

    const [rule, candidates, executions, aiRun, escalation] = await Promise.all([
      decision.ruleId ? this.rules.findOne({ where: { id: decision.ruleId } }) : Promise.resolve(null),
      decision.candidateRuleIds?.length
        ? this.rules.find({ where: { id: In(decision.candidateRuleIds) } })
        : Promise.resolve([] as AutomationRule[]),
      this.executions.find({ where: { decisionId: id }, order: { createdAt: 'ASC' } }),
      manager.getRepository(AiRun).findOne({ where: { decisionId: id }, order: { createdAt: 'DESC' } }),
      manager.getRepository(Escalation).findOne({ where: { decisionId: id } }),
    ]);

    return {
      decision,
      rule: rule ? { id: rule.id, name: rule.name, scopeType: rule.scopeType, priority: rule.priority } : null,
      candidateRules: candidates.map((row) => ({
        id: row.id,
        name: row.name,
        scopeType: row.scopeType,
        priority: row.priority,
        won: row.id === decision.ruleId,
      })),
      executions,
      /** Provider, model, tokens, latency. Never the prompt and never the credential. */
      aiRun,
      escalation,
    };
  }

  async list(options: { conversationId?: string; outcome?: DecisionOutcome; limit?: number; offset?: number }) {
    const [items, total] = await this.logs.findAndCount({
      where: {
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        ...(options.outcome ? { outcome: options.outcome } : {}),
      },
      order: { createdAt: 'DESC' },
      take: Math.min(options.limit ?? 50, 200),
      skip: options.offset ?? 0,
    });
    return { items, total };
  }
}
