import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AIProviderError,
  AIUnavailableError,
} from '../../common/ai/ai-provider';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { RateLimitService } from '../../common/redis/rate-limit.service';
import { createHash } from 'node:crypto';
import {
  ActionType,
  type EvaluationContext,
  type EvaluationResult,
  type RuleAction,
} from '../automation/automation-types';
import { RuleEvaluator } from '../automation/rule-evaluator';
import { ConversationControlState, ConversationStatus } from '../crm/conversation-states';
import { Conversation } from '../crm/entities/conversation.entity';
import { GroupMonitoringState } from '../groups/entities/group.entity';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';
import { MessageClassification } from '../messaging/message-types';
import { Message } from '../messaging/entities/message.entity';
import { EMERGENCY_STOPS, SettingsService } from '../settings/settings.service';
import { AiRun, AiRunStatus } from './entities/ai-run.entity';
import { DECISION_SETTINGS, DecisionContextBuilder, type DecisionContext } from './decision-context';
import { AIGatewayService } from '../ai/ai-gateway.service';
import { AIMemoryService } from '../ai/ai-memory.service';
import { AIMessageRole } from '../ai/ai-types';
import { asksForHuman } from '../escalation/escalation-policy';
import { EscalationReason } from '../escalation/entities/escalation.entity';
import { DecisionPolicy } from './decision-policy';
import {
  DecisionOutcome,
  DecisionReason,
  type Decision,
  type DecisionEffect,
} from './decision-types';

/**
 * The Message Decision Engine — the single authority on what happens to an inbound customer
 * message (`PROJECT_SPEC.md` §5, §157–§161).
 *
 * ## It cannot send
 *
 * Look at the constructor: there is no `MessageService`, no channel adapter, no outbound queue.
 * `decide()` returns a value. Something else acts on it. That is a type-level guarantee rather than
 * a convention, and it is what makes "no automatic response bypasses the engine" enforceable — the
 * engine could not bypass itself if it wanted to.
 *
 * ## The order is the meaning
 *
 * Each step can end the pipeline, and the order encodes the system's priorities:
 * a human who has taken over outranks everything; a deterministic rule outranks AI; AI outranks
 * silence; and silence outranks a guess.
 */
@Injectable()
export class DecisionEngine {
  private readonly logger = new AppLogger(DecisionEngine.name);

  constructor(
    @InjectRepository(AiRun) private readonly aiRuns: Repository<AiRun>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    private readonly contextBuilder: DecisionContextBuilder,
    private readonly evaluator: RuleEvaluator,
    private readonly policy: DecisionPolicy,
    private readonly knowledge: KnowledgeRetrievalService,
    private readonly ai: AIGatewayService,
    private readonly memory: AIMemoryService,
    private readonly settings: SettingsService,
    private readonly rateLimits: RateLimitService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Decides what to do about one message.
   *
   * Never throws for a business reason: every path that could go wrong resolves to a decision with
   * an outcome and a reason, because a message that produces no decision is a message nobody can
   * explain later. Only a programming error escapes, and the caller records that as FAILED.
   */
  async decide(message: Message, conversation: Conversation): Promise<Decision> {
    // --- 1. is this even ours to answer? -------------------------------------------------------

    if (!ANSWERABLE.includes(message.classification)) {
      // The anti-loop invariant. Our own outbound echoes come back as BOT_MESSAGE and a support
      // agent's own reply as TEAM_MESSAGE; either entering the auto-response pipeline is how a
      // system ends up talking to itself (brief §7, §33).
      return ignore(
        DecisionReason.NOT_CUSTOMER_MESSAGE,
        `A ${message.classification} does not trigger automatic responses.`,
      );
    }

    const context = await this.contextBuilder.build(message, conversation);

    // --- 2. global and per-scope switches ------------------------------------------------------

    if (context.group && context.group.monitoringState !== GroupMonitoringState.MONITORED) {
      return ignore(
        DecisionReason.MONITORING_DISABLED,
        'This group is not monitored, so nothing automatic runs in it.',
      );
    }

    if (conversation.status === ConversationStatus.CLOSED) {
      return ignore(DecisionReason.CONVERSATION_CLOSED, 'This conversation is closed.');
    }

    // --- 3. human takeover is authoritative ----------------------------------------------------

    const takeover = await this.checkTakeover(conversation, context.now);
    if (takeover === 'ACTIVE') {
      return {
        outcome: DecisionOutcome.HUMAN_HANDLING,
        reasonCode: DecisionReason.HUMAN_TAKEOVER_ACTIVE,
        reason: 'A person is handling this conversation, so nothing automatic replied.',
      };
    }

    // --- 4. deliberately paused ----------------------------------------------------------------

    if (
      conversation.controlState === ConversationControlState.PAUSED &&
      (!conversation.pausedUntil || conversation.pausedUntil > context.now)
    ) {
      return {
        outcome: DecisionOutcome.NO_RESPONSE,
        reasonCode: DecisionReason.CONVERSATION_PAUSED,
        reason: 'Automatic responses are paused for this conversation.',
      };
    }

    // --- 5. an explicit request for a person ---------------------------------------------------
    //
    // Checked before the rules, not after. §39 forbids the AI arguing with a customer who asks for
    // a human, and a rule that happens to match "I want to talk to someone" would do exactly that.
    // This is deliberately generous: fetching a person who was not strictly needed costs a moment
    // of an agent's time, and missing the request costs a customer shouting at a machine.
    if (asksForHuman(context.message.body)) {
      this.metrics.increment('decision.human_requested');
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.CUSTOMER_REQUESTED_HUMAN,
        reason: 'The customer asked to speak to a person.',
        escalation: {
          reason: EscalationReason.CUSTOMER_REQUESTED,
          detail: 'The customer asked for a human.',
        },
      };
    }

    // --- 6. loop protection --------------------------------------------------------------------

    const suppression = await this.checkLoopGuards(context);
    if (suppression) return suppression;

    // --- 7. deterministic rules ----------------------------------------------------------------

    if (context.automationEnabled && !(await this.settings.isStopped(EMERGENCY_STOPS.ALL_AUTOMATION_PAUSED))) {
      const evaluation = this.evaluator.evaluate(context.rules, this.toEvaluationContext(context));
      const decision = this.fromRules(evaluation, context);
      if (decision) return decision;
    }

    // --- 8. AI, only when no rule answered -----------------------------------------------------

    return this.tryAi(context, null);
  }

  /**
   * Human takeover, honouring expiry.
   *
   * An expired takeover is released here rather than left to a sweep, because the moment a message
   * arrives is exactly when the question "does a human still own this?" is being asked. The
   * maintenance sweep releases the ones no message ever arrives for.
   */
  private async checkTakeover(conversation: Conversation, now: Date): Promise<'ACTIVE' | 'RELEASED' | 'NONE'> {
    if (conversation.controlState !== ConversationControlState.HUMAN_ACTIVE) return 'NONE';

    if (conversation.takeoverExpiresAt && conversation.takeoverExpiresAt <= now) {
      await this.conversations.update(conversation.id, {
        controlState: ConversationControlState.AUTOMATION_ACTIVE,
        takeoverByUserId: null,
        takeoverAt: null,
        takeoverExpiresAt: null,
        takeoverReason: null,
      });
      // The in-memory copy is used by the rest of the pipeline; keep it in step.
      conversation.controlState = ConversationControlState.AUTOMATION_ACTIVE;
      conversation.takeoverExpiresAt = null;

      this.metrics.increment('decision.takeover_expired');
      this.logger.log('Human takeover expired and was released', { conversationId: conversation.id });
      return 'RELEASED';
    }

    return 'ACTIVE';
  }

  /**
   * Two guards against a system that talks to itself or shouts at a customer.
   *
   * The classification check upstream stops the direct echo loop. These stop the subtler ones: a
   * conversation where something keeps triggering replies, and a customer whose identical message
   * arrives repeatedly (a stuck client, a retrying gateway, or somebody frustrated).
   */
  private async checkLoopGuards(context: DecisionContext): Promise<Decision | null> {
    const conversationId = context.conversation.id;

    const perConversation = await this.settings.get<number>(
      DECISION_SETTINGS.AUTO_REPLIES_PER_CONVERSATION,
      5,
    );
    const windowSeconds = await this.settings.get<number>(DECISION_SETTINGS.AUTO_REPLY_WINDOW_SECONDS, 300);

    const budget = await this.rateLimits.peek(
      `decision:replies:${conversationId}`,
      Number(perConversation),
      Number(windowSeconds) * 1_000,
    );
    if (!budget.allowed) {
      this.metrics.increment('decision.loop_suppressed', { guard: 'conversation_budget' });
      return {
        outcome: DecisionOutcome.SUPPRESSED,
        reasonCode: DecisionReason.LOOP_GUARD,
        reason: `This conversation already had ${perConversation} automatic replies in the last ${windowSeconds} seconds.`,
      };
    }

    const repeatSeconds = Number(
      await this.settings.get<number>(DECISION_SETTINGS.REPEAT_SUPPRESSION_SECONDS, 60),
    );
    if (repeatSeconds > 0 && (context.message.body ?? '').trim().length > 0) {
      const fingerprint = createHash('sha256')
        .update(`${conversationId}:${(context.message.body ?? '').trim().toLowerCase()}`)
        .digest('hex')
        .slice(0, 32);

      const first = await this.rateLimits.markFirstSeen(`decision:repeat:${fingerprint}`, repeatSeconds * 1_000);
      if (!first) {
        this.metrics.increment('decision.loop_suppressed', { guard: 'repeat' });
        return {
          outcome: DecisionOutcome.SUPPRESSED,
          reasonCode: DecisionReason.REPEATED_MESSAGE,
          reason: 'The same message was already answered moments ago.',
        };
      }
    }

    return null;
  }

  /** Turns an evaluation into a decision, or null when the AI path should take over. */
  private fromRules(evaluation: EvaluationResult, context: DecisionContext): Decision | null {
    const candidateRuleIds = evaluation.matches.map((match) => match.rule.id);

    if (!evaluation.winner) {
      return null; // Nothing matched, or everything that matched was in cooldown. Try AI.
    }

    const { rule } = evaluation.winner;
    const rulePart = { id: rule.id, name: rule.name, version: rule.version };
    const effects = toEffects(rule.actions);

    this.metrics.increment('decision.rule_matched');

    // TRIGGER_KNOWLEDGE_AI is a rule deliberately handing over rather than answering.
    if (rule.actions.some((action) => action.type === ActionType.TRIGGER_KNOWLEDGE_AI)) {
      return null;
    }

    if (rule.actions.some((action) => action.type === ActionType.ESCALATE)) {
      const detail = rule.actions.find((a) => a.type === ActionType.ESCALATE)?.value;
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.RULE_ESCALATE,
        reason: `Rule "${rule.name}" escalates this to a person.`,
        rule: rulePart,
        candidateRuleIds,
        profileId: context.profile?.id ?? null,
        escalation: { reason: 'RULE_ESCALATION', detail: detail ?? undefined },
        effects,
      };
    }

    if (rule.actions.some((action) => action.type === ActionType.IGNORE)) {
      return {
        outcome: DecisionOutcome.IGNORE,
        reasonCode: DecisionReason.RULE_IGNORE,
        reason: `Rule "${rule.name}" says to ignore this.`,
        rule: rulePart,
        candidateRuleIds,
        profileId: context.profile?.id ?? null,
        effects,
      };
    }

    const send = rule.actions.find((action) => action.type === ActionType.SEND_MESSAGE);
    if (send?.value) {
      return {
        outcome: DecisionOutcome.RULE_REPLY,
        reasonCode: DecisionReason.RULE_MATCHED,
        reason: `Rule "${rule.name}" matched.`,
        reply: send.value,
        rule: rulePart,
        candidateRuleIds,
        profileId: context.profile?.id ?? null,
        effects,
      };
    }

    // A rule with only side effects — tags, assignment, state. It matched and acted; there is
    // simply nothing to say to the customer.
    return {
      outcome: DecisionOutcome.NO_RESPONSE,
      reasonCode: DecisionReason.RULE_MATCHED,
      reason: `Rule "${rule.name}" matched and applied its changes without replying.`,
      rule: rulePart,
      candidateRuleIds,
      profileId: context.profile?.id ?? null,
      effects,
    };
  }

  /**
   * The knowledge-grounded AI path.
   *
   * Retrieval first, then the model, then the policy. Every failure here ends in an escalation or a
   * silence — never in a fabricated answer, and never in a lost message.
   */
  private async tryAi(context: DecisionContext, decisionId: string | null): Promise<Decision> {
    const base = {
      candidateRuleIds: [] as string[],
      profileId: context.profile?.id ?? null,
    };

    if (!context.aiEnabled) {
      return {
        outcome: DecisionOutcome.NO_RESPONSE,
        reasonCode: DecisionReason.AI_DISABLED,
        reason: 'No rule matched, and AI is switched off here.',
        ...base,
      };
    }

    if (await this.settings.isStopped(EMERGENCY_STOPS.ALL_AI_PAUSED)) {
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.EMERGENCY_STOP,
        reason: 'AI is paused by the emergency control, so this went to a person.',
        escalation: { reason: 'AI_UNAVAILABLE', detail: 'Emergency stop engaged' },
        ...base,
      };
    }

    if (!(await this.ai.isAvailable())) {
      // Honest unavailability, exactly as the embedding provider does it. Escalating is the correct
      // answer; inventing a reply is not (brief §20).
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.AI_UNAVAILABLE,
        reason: 'No rule matched and no AI provider is configured, so a person was asked to look.',
        escalation: { reason: 'AI_UNAVAILABLE', detail: 'No provider configured' },
        ...base,
      };
    }

    // --- retrieval (Phase 4, unchanged) --------------------------------------------------------

    const maxChunks = Number(await this.settings.get<number>(DECISION_SETTINGS.MAX_KNOWLEDGE_CHUNKS, 6));
    const maxChars = Number(await this.settings.get<number>(DECISION_SETTINGS.MAX_CONTEXT_CHARS, 8_000));

    const retrieved = await this.knowledge.retrieve({
      query: context.message.body ?? '',
      groupId: context.group?.id ?? null,
      customerId: context.conversation.customerId ?? null,
      profileId: context.profile?.knowledgeProfileId ?? null,
      limit: maxChunks,
      maxChars,
      // The default, stated explicitly because it is the guarantee that matters most here: a draft
      // must never reach a customer.
      productionOnly: true,
    });

    const knowledge = {
      used: retrieved.chunks.length > 0,
      articleIds: [...new Set(retrieved.chunks.map((c) => c.articleId).filter((id): id is string => Boolean(id)))],
      chunkIds: retrieved.chunks.map((c) => c.chunkId),
    };

    // --- the provider ---------------------------------------------------------------------------

    const history = await this.loadHistory(context);
    const started = Date.now();

    try {
      // Memory and knowledge are different things and stay separate: the summary and the
      // approved customer facts are context, the retrieved passages are the only thing the model
      // may state as fact.
      const remembered = context.conversation
        ? await this.memory.load(context.conversation.id, context.conversation.customerId)
        : { history: [], summary: null, customerFacts: [] };

      const { result, provider, model } = await this.ai.decide(
        {
          question: context.message.body ?? '',
          history,
          knowledge: retrieved.chunks.map((chunk) => ({
            id: chunk.chunkId,
            title: chunk.title,
            content: chunk.content,
          })),
          guidance: (context.profile?.escalationPolicy?.guidance as string) ?? null,
        },
        {
          profileId: context.profile?.id ?? null,
          groupId: context.group?.id ?? null,
          summary: remembered.summary,
          customerFacts: remembered.customerFacts,
        },
      );

      await this.recordAiRun(decisionId, context, AiRunStatus.SUCCESS, {
        latencyMs: Date.now() - started,
        confidence: result.confidence,
        usage: result.usage,
        provider,
        model,
      });

      // The turn log, for the conversation view and the AI performance report. Verdict and usage
      // only — never the reasoning behind them (§27, §165).
      await this.memory.recordTurn({
        conversationId: context.conversation?.id ?? null,
        decisionId,
        messageId: context.message.id,
        role: AIMessageRole.ASSISTANT,
        content: result.answer,
        provider,
        model,
        latencyMs: Date.now() - started,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        decision: result.decision,
        confidence: result.confidence,
        knowledgeSufficient: result.knowledgeSufficient,
        needsHuman: result.needsHuman,
        citedIds: result.citedIds,
      });

      const verdict = this.policy.apply({
        ai: result,
        knowledgeCount: retrieved.chunks.length,
        thresholds: context.thresholds,
      });

      this.metrics.increment('ai.success');
      if (verdict.outcome === DecisionOutcome.HUMAN_HANDOFF) this.metrics.increment('ai.escalated');

      return {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        reason: verdict.reason,
        reply: verdict.outcome === DecisionOutcome.AI_REPLY ? result.answer : null,
        ai: {
          provider,
          model,
          confidence: result.confidence,
          knowledgeSufficient: result.knowledgeSufficient,
        },
        knowledge,
        escalation: verdict.escalationReason ? { reason: verdict.escalationReason, detail: verdict.reason } : null,
        ...base,
      };
    } catch (error) {
      const kind =
        error instanceof AIProviderError
          ? error.kind === 'TIMEOUT'
            ? AiRunStatus.TIMEOUT
            : error.kind === 'RATE_LIMITED'
              ? AiRunStatus.RATE_LIMITED
              : AiRunStatus.FAILED
          : error instanceof AIUnavailableError
            ? AiRunStatus.UNAVAILABLE
            : AiRunStatus.FAILED;

      await this.recordAiRun(decisionId, context, kind, {
        latencyMs: Date.now() - started,
        error: (error as Error).message,
      });

      this.metrics.increment('ai.failure', { kind });
      this.logger.warn('AI decision failed; escalating', {
        conversationId: context.conversation.id,
        kind,
        error: (error as Error).message,
      });

      // A provider failure must never become a customer-facing guess, and must never lose the
      // message. It becomes a person's problem instead.
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.AI_FAILED,
        reason: 'The assistant could not be reached, so this was passed to a person.',
        // No provider answered, so there is nothing truthful to name here.
        ai: { provider: null, model: null, confidence: null, knowledgeSufficient: false },
        knowledge,
        escalation: { reason: 'AI_FAILED', detail: (error as Error).message.slice(0, 500) },
        ...base,
      };
    }
  }

  /** Recent turns, bounded, oldest first. Bodies only — no ids, no metadata, no internals. */
  private async loadHistory(context: DecisionContext) {
    const limit = Number(await this.settings.get<number>(DECISION_SETTINGS.MAX_HISTORY_MESSAGES, 10));
    if (limit <= 0) return [];

    const rows = await this.messages.find({
      where: { conversationId: context.conversation.id },
      order: { sentAt: 'DESC' },
      take: limit + 1,
      select: { id: true, body: true, direction: true, sentAt: true, classification: true },
    });

    return rows
      .filter((row) => row.id !== context.message.id && (row.body ?? '').trim().length > 0)
      .reverse()
      .map((row) => ({
        role: (row.classification === MessageClassification.CUSTOMER_MESSAGE ? 'customer' : 'agent') as
          | 'customer'
          | 'agent',
        text: (row.body ?? '').slice(0, 1_000),
      }));
  }

  private async recordAiRun(
    decisionId: string | null,
    context: DecisionContext,
    status: AiRunStatus,
    extra: {
      latencyMs?: number;
      confidence?: number | null;
      error?: string;
      usage?: { promptTokens: number | null; completionTokens: number | null };
      /** Known only when a provider actually answered. */
      provider?: string | null;
      model?: string | null;
    },
  ): Promise<void> {
    await this.aiRuns
      .save(
        this.aiRuns.create({
          decisionId,
          conversationId: context.conversation.id,
          purpose: 'DECISION',
          provider: extra.provider ?? null,
          model: extra.model ?? null,
          status,
          latencyMs: extra.latencyMs ?? null,
          confidence: extra.confidence === null || extra.confidence === undefined ? null : String(extra.confidence),
          promptTokens: extra.usage?.promptTokens ?? null,
          completionTokens: extra.usage?.completionTokens ?? null,
          // The provider's message, never the request: the request carries customer content and the
          // retrieved knowledge, and this table is read more widely than either.
          error: extra.error?.slice(0, 1_000) ?? null,
        }),
      )
      .catch(() => undefined);
  }

  /** The evaluator's view of this message. Pure data — it reads nothing itself. */
  private toEvaluationContext(context: DecisionContext): EvaluationContext {
    return {
      body: context.message.body ?? '',
      messageType: context.message.contentType,
      hasAttachment: context.message.contentType !== 'TEXT',
      conversationState: context.conversation.status,
      customerTags: context.customerTags,
      now: context.now,
      businessHours: context.profile?.businessHours ?? null,
      timezone: context.profile?.businessHours?.timezone,
    };
  }
}

/**
 * Which classifications the engine will act on.
 *
 * CUSTOMER_MESSAGE is obvious. UNKNOWN is included deliberately, and the reason matters: Phase 3
 * classifies a sender as CUSTOMER_MESSAGE only inside a monitored group, so a person messaging the
 * support number **directly** is UNKNOWN — which is exactly what an unrecognised customer looks
 * like. The real-WhatsApp validation bore this out: every direct message it saw was UNKNOWN.
 *
 * Excluding UNKNOWN would make the engine inert for one-to-one support, which is the most common
 * way a customer contacts a support number.
 *
 * What stays excluded is what the anti-loop rules are actually about — TEAM_MESSAGE, BOT_MESSAGE
 * and SYSTEM_EVENT. And an UNKNOWN sender in an *unmonitored* group is still ignored, by the
 * monitoring check immediately below this one. Being answerable is not the same as being a
 * customer: nothing here promotes anybody to a customer record (Phase 3's invariant).
 */
const ANSWERABLE: readonly MessageClassification[] = [
  MessageClassification.CUSTOMER_MESSAGE,
  MessageClassification.UNKNOWN,
];

function ignore(reasonCode: DecisionReason, reason: string): Decision {
  return { outcome: DecisionOutcome.IGNORE, reasonCode, reason };
}

/** Side effects a rule asked for, in the order it listed them. */
function toEffects(actions: RuleAction[]): DecisionEffect[] {
  const effects: DecisionEffect[] = [];

  for (const action of actions) {
    switch (action.type) {
      case ActionType.ADD_TAG:
        if (action.value) effects.push({ type: 'ADD_TAG', value: action.value });
        break;
      case ActionType.REMOVE_TAG:
        if (action.value) effects.push({ type: 'REMOVE_TAG', value: action.value });
        break;
      case ActionType.SET_CONVERSATION_STATE:
        if (action.value) effects.push({ type: 'SET_CONVERSATION_STATE', value: action.value });
        break;
      case ActionType.ASSIGN_TEAM:
        if (action.targetId) effects.push({ type: 'ASSIGN_TEAM', targetId: action.targetId });
        break;
      case ActionType.ASSIGN_AGENT:
        if (action.targetId) effects.push({ type: 'ASSIGN_AGENT', targetId: action.targetId });
        break;
      default:
        break;
    }
  }

  return effects;
}
