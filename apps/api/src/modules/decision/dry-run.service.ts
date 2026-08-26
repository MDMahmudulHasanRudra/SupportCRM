import { Injectable } from '@nestjs/common';
import { AIGatewayService } from '../ai/ai-gateway.service';
import { ActionType, AutomationStatus, type EvaluationContext } from '../automation/automation-types';
import { RuleEvaluator } from '../automation/rule-evaluator';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';
import { ConversationStatus } from '../crm/conversation-states';
import { DecisionContextBuilder } from './decision-context';
import { DecisionPolicy } from './decision-policy';
import { DecisionOutcome } from './decision-types';

/**
 * "What would happen if a customer said this?" (brief §31).
 *
 * The point of a dry run is that it is trustworthy, and the only way to make it trustworthy is for
 * it to use **the same evaluator and the same policy** the live engine uses. It does — the
 * evaluator is pure and the policy is pure, so running them here produces exactly what would happen
 * there.
 *
 * What it never does: send a message, write a decision log, raise an escalation, touch a rule's
 * counters, or change a conversation. It reads and it reports.
 */

export interface DryRunRequest {
  text: string;
  groupId?: string | null;
  customerId?: string | null;
  conversationId?: string | null;
  conversationState?: string;
  messageType?: string;
  hasAttachment?: boolean;
  /** Restrict to specific rules, for testing one in isolation. */
  ruleIds?: string[];
  /** Run the AI half too. Costs a provider call and still sends nothing. */
  includeAi?: boolean;
  at?: string;
}

@Injectable()
export class DryRunService {
  constructor(
    private readonly contextBuilder: DecisionContextBuilder,
    private readonly evaluator: RuleEvaluator,
    private readonly policy: DecisionPolicy,
    private readonly knowledge: KnowledgeRetrievalService,
    private readonly ai: AIGatewayService,
  ) {}

  async run(request: DryRunRequest) {
    const now = request.at ? new Date(request.at) : new Date();

    // Naming rules explicitly means "test THESE", and the rule somebody most needs to test is the
    // draft they have not dared activate yet. The evaluator refuses anything that is not ACTIVE —
    // correctly, since that is what keeps an unapproved rule away from customers — so a targeted
    // run evaluates a copy with the status raised, and reports each rule's real status alongside
    // the result. The live engine never passes ruleIds, so its behaviour is untouched.
    const targeted = (request.ruleIds?.length ?? 0) > 0;

    const loaded = targeted
      ? await this.contextBuilder.loadRulesByIds(request.ruleIds as string[])
      : await this.contextBuilder.loadRulesForScope({
          conversationId: request.conversationId ?? undefined,
          customerId: request.customerId ?? undefined,
          groupId: request.groupId ?? undefined,
        });

    const realStatus = new Map(loaded.map((rule) => [rule.id, rule.status]));

    const rules = targeted
      ? loaded.map((rule) => ({ ...rule, status: AutomationStatus.ACTIVE }))
      : loaded;

    const context: EvaluationContext = {
      body: request.text,
      messageType: request.messageType ?? 'TEXT',
      hasAttachment: request.hasAttachment ?? false,
      conversationState: request.conversationState ?? ConversationStatus.OPEN,
      customerTags: [],
      now,
      businessHours: null,
    };

    const evaluation = this.evaluator.evaluate(rules, context);

    const matched = evaluation.matches.map((match) => ({
      id: match.rule.id,
      name: match.rule.name,
      priority: match.rule.priority,
      scopeType: match.rule.scopeType,
      won: match.rule.id === evaluation.winner?.rule.id,
      skipped: match.skipped,
      actions: match.rule.actions.map((action) => action.type),
      /** The rule's real status. A draft matching here would still not run against a customer. */
      status: realStatus.get(match.rule.id) ?? match.rule.status,
    }));

    const winner = evaluation.winner?.rule ?? null;
    const wouldSend = winner?.actions.find((action) => action.type === ActionType.SEND_MESSAGE)?.value ?? null;
    const handsToAi =
      !winner || winner.actions.some((action) => action.type === ActionType.TRIGGER_KNOWLEDGE_AI);

    const result: Record<string, unknown> = {
      evaluatedAt: now.toISOString(),
      rulesConsidered: rules.length,
      /**
       * Whether the run raised the status of the rules it was given.
       *
       * True means "this is what the rule would do once it is active", not "this is what happens
       * today" — a distinction worth stating rather than leaving to be inferred.
       */
      testedAsIfActive:
        targeted && loaded.some((rule) => realStatus.get(rule.id) !== AutomationStatus.ACTIVE),
      matched,
      winner: winner ? { id: winner.id, name: winner.name, version: winner.version } : null,
      wouldSend,
      wouldEscalate: winner?.actions.some((action) => action.type === ActionType.ESCALATE) ?? false,
      aiWouldRun: handsToAi,
      // Said explicitly, every time. A dry run that could send would be worse than useless.
      sent: false,
    };

    if (!request.includeAi || !handsToAi) return result;

    // --- the AI half, still sending nothing ----------------------------------------------------

    const retrieved = await this.knowledge.retrieve({
      query: request.text,
      groupId: request.groupId ?? null,
      customerId: request.customerId ?? null,
      limit: 6,
      productionOnly: true,
    });

    result.knowledge = retrieved.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      articleId: chunk.articleId,
      title: chunk.title,
      scopeType: chunk.scopeType,
      score: chunk.score,
      matchedBy: chunk.matchedBy,
      preview: chunk.content.slice(0, 240),
    }));

    if (!(await this.ai.isAvailable())) {
      result.ai = { available: false, note: 'No AI provider is configured, so this would escalate.' };
      result.finalOutcome = DecisionOutcome.HUMAN_HANDOFF;
      return result;
    }

    try {
      const { result: aiResult, provider, model } = await this.ai.decide(
        {
          question: request.text,
          history: [],
          knowledge: retrieved.chunks.map((chunk) => ({
            id: chunk.chunkId,
            title: chunk.title,
            content: chunk.content,
          })),
        },
        { groupId: request.groupId ?? null },
      );

      // The configured thresholds, not literals: a dry run that judged by different numbers than
      // the live engine would be confidently wrong, which is worse than not having it.
      const thresholds = await this.contextBuilder.resolveThresholds(null);

      const verdict = this.policy.apply({
        ai: aiResult,
        knowledgeCount: retrieved.chunks.length,
        thresholds,
      });

      result.ai = {
        available: true,
        provider,
        model,
        answer: aiResult.answer,
        confidence: aiResult.confidence,
        // Stated here as well as in the decision log: the number is a self-report.
        confidenceCalibrated: false,
        knowledgeSufficient: aiResult.knowledgeSufficient,
        needsHuman: aiResult.needsHuman,
      };
      result.finalOutcome = verdict.outcome;
      result.finalReason = verdict.reason;
      result.thresholds = thresholds;
    } catch (error) {
      result.ai = { available: true, failed: true, error: (error as Error).message };
      result.finalOutcome = DecisionOutcome.HUMAN_HANDOFF;
    }

    return result;
  }
}
