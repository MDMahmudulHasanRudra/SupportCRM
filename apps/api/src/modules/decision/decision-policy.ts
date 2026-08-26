import { Injectable } from '@nestjs/common';
import type { AIDecisionResult } from '../../common/ai/ai-provider';
import { DecisionOutcome, DecisionReason } from './decision-types';

/**
 * Turning an AI result into an outcome.
 *
 * Separated from the engine and made pure so the rule that decides whether a customer hears from a
 * machine is one readable function with its own tests, rather than a branch buried in a pipeline.
 *
 * ## The confidence problem, and what this does about it
 *
 * A language model asked "how confident are you?" returns a number that looks like a probability
 * and is not one. It is not calibrated against outcomes, it drifts between models, and it rises
 * when the model is confidently wrong. Treating it as a probability is the most dangerous thing
 * this file could do.
 *
 * So the policy is built on **objective signals first**, and the self-reported number is only ever
 * allowed to make the outcome *more* cautious:
 *
 *  1. The model said it needs a human            → escalate, whatever the number says.
 *  2. The model said the knowledge was insufficient → escalate, whatever the number says.
 *  3. Nothing was retrieved                       → escalate. An answer with no source behind it is
 *                                                   exactly what §18 forbids.
 *  4. The model chose to escalate                 → escalate.
 *  5. No confidence was supplied at all           → escalate. Absence is not high confidence.
 *  6. Only then does the number decide, against configured thresholds.
 *
 * Nothing here can turn an escalation into an answer.
 */

export interface ConfidenceThresholds {
  /** At or above this, a knowledge-grounded answer may be sent automatically. */
  autoReplyMin: number;
  /** Below this, always escalate. */
  escalateBelow: number;
  /** What to do in between. */
  midPolicy: MidConfidencePolicy;
}

export enum MidConfidencePolicy {
  /** Send it. Suitable where a wrong answer is cheap and a human is slow. */
  REPLY = 'REPLY',
  /** Hand to a human. The safe default. */
  ESCALATE = 'ESCALATE',
  /** Say nothing automatic, but do not raise an escalation either. */
  SILENT = 'SILENT',
}

export interface PolicyInput {
  ai: AIDecisionResult;
  /** How many knowledge passages were supplied to the model. */
  knowledgeCount: number;
  thresholds: ConfidenceThresholds;
}

export interface PolicyOutput {
  outcome: DecisionOutcome;
  reasonCode: DecisionReason;
  reason: string;
  escalationReason?: string;
}

@Injectable()
export class DecisionPolicy {
  apply(input: PolicyInput): PolicyOutput {
    const { ai, knowledgeCount, thresholds } = input;

    // --- objective signals, in order of authority ---------------------------------------------

    if (ai.needsHuman) {
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.AI_NEEDS_HUMAN,
        reason: 'The assistant judged that this needs a person.',
        escalationReason: 'AI_NEEDS_HUMAN',
      };
    }

    if (!ai.knowledgeSufficient) {
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.KNOWLEDGE_INSUFFICIENT,
        reason: 'The approved knowledge did not cover this question.',
        escalationReason: 'KNOWLEDGE_INSUFFICIENT',
      };
    }

    if (knowledgeCount === 0) {
      // Even a model claiming certainty has nothing to be certain *from*. An answer with no source
      // is the failure mode §18 exists to prevent.
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.KNOWLEDGE_INSUFFICIENT,
        reason: 'No approved knowledge matched this question, so there was nothing to answer from.',
        escalationReason: 'KNOWLEDGE_INSUFFICIENT',
      };
    }

    if (ai.decision === 'ESCALATE' || !ai.answer) {
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.AI_LOW_CONFIDENCE,
        reason: ai.reason ?? 'The assistant chose not to answer.',
        escalationReason: 'AI_DECLINED',
      };
    }

    if (ai.confidence === null) {
      // A provider that supplies no self-assessment gives the policy nothing to work with. Silence
      // is not consent: treat the absence as a reason to involve a person.
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.AI_LOW_CONFIDENCE,
        reason: 'The assistant gave no confidence estimate, so the answer was not sent automatically.',
        escalationReason: 'NO_CONFIDENCE',
      };
    }

    // --- only now, the number ------------------------------------------------------------------

    if (ai.confidence >= thresholds.autoReplyMin) {
      return {
        outcome: DecisionOutcome.AI_REPLY,
        reasonCode: DecisionReason.AI_ANSWERED,
        reason: `Answered from approved knowledge (self-reported confidence ${ai.confidence.toFixed(2)}).`,
      };
    }

    if (ai.confidence < thresholds.escalateBelow) {
      return {
        outcome: DecisionOutcome.HUMAN_HANDOFF,
        reasonCode: DecisionReason.AI_LOW_CONFIDENCE,
        reason: `Confidence ${ai.confidence.toFixed(2)} is below the escalation threshold ${thresholds.escalateBelow}.`,
        escalationReason: 'LOW_CONFIDENCE',
      };
    }

    switch (thresholds.midPolicy) {
      case MidConfidencePolicy.REPLY:
        return {
          outcome: DecisionOutcome.AI_REPLY,
          reasonCode: DecisionReason.AI_ANSWERED,
          reason: `Answered at middling confidence ${ai.confidence.toFixed(2)}, as configured.`,
        };
      case MidConfidencePolicy.SILENT:
        return {
          outcome: DecisionOutcome.NO_RESPONSE,
          reasonCode: DecisionReason.AI_LOW_CONFIDENCE,
          reason: `Confidence ${ai.confidence.toFixed(2)} is in the middle band; configured to stay silent.`,
        };
      case MidConfidencePolicy.ESCALATE:
      default:
        return {
          outcome: DecisionOutcome.HUMAN_HANDOFF,
          reasonCode: DecisionReason.AI_LOW_CONFIDENCE,
          reason: `Confidence ${ai.confidence.toFixed(2)} is in the middle band; configured to escalate.`,
          escalationReason: 'MID_CONFIDENCE',
        };
    }
  }
}
