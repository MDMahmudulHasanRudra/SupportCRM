import type { AIDecisionResult } from '../../common/ai/ai-provider';
import { DecisionPolicy, MidConfidencePolicy, type ConfidenceThresholds } from './decision-policy';
import { DecisionOutcome, DecisionReason } from './decision-types';

/**
 * The policy that decides whether a customer hears from a machine.
 *
 * These are the tests that matter most in Phase 5. Every case here is one where getting it wrong
 * means either a customer receiving an unsupported answer, or a customer being ignored.
 */

const thresholds: ConfidenceThresholds = {
  autoReplyMin: 0.9,
  escalateBelow: 0.8,
  midPolicy: MidConfidencePolicy.ESCALATE,
};

function ai(overrides: Partial<AIDecisionResult> = {}): AIDecisionResult {
  return {
    decision: 'ANSWER',
    answer: 'Your billing date is the first of the month.',
    confidence: 0.95,
    reason: 'covered by knowledge',
    knowledgeSufficient: true,
    needsHuman: false,
    citedIds: ['chunk-1'],
    usage: { promptTokens: null, completionTokens: null },
    ...overrides,
  };
}

describe('DecisionPolicy', () => {
  const policy = new DecisionPolicy();

  it('replies when the answer is grounded and confidence is high', () => {
    const result = policy.apply({ ai: ai(), knowledgeCount: 3, thresholds });

    expect(result.outcome).toBe(DecisionOutcome.AI_REPLY);
    expect(result.reasonCode).toBe(DecisionReason.AI_ANSWERED);
  });

  it('escalates when the model says a person is needed, whatever the number says', () => {
    // The model's explicit flag outranks its own confidence. A model that is certain it should not
    // be the one answering is telling you something the number cannot.
    const result = policy.apply({ ai: ai({ needsHuman: true, confidence: 0.99 }), knowledgeCount: 5, thresholds });

    expect(result.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
    expect(result.reasonCode).toBe(DecisionReason.AI_NEEDS_HUMAN);
  });

  it('escalates when the model says the knowledge was insufficient, whatever the number says', () => {
    const result = policy.apply({
      ai: ai({ knowledgeSufficient: false, confidence: 0.99 }),
      knowledgeCount: 4,
      thresholds,
    });

    expect(result.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
    expect(result.reasonCode).toBe(DecisionReason.KNOWLEDGE_INSUFFICIENT);
  });

  it('escalates when nothing was retrieved, however certain the model claims to be', () => {
    // This is the §18 guarantee in one assertion: an answer with no source behind it never reaches
    // a customer, no matter what the model reports about itself.
    const result = policy.apply({ ai: ai({ confidence: 1 }), knowledgeCount: 0, thresholds });

    expect(result.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
    expect(result.reasonCode).toBe(DecisionReason.KNOWLEDGE_INSUFFICIENT);
  });

  it('escalates when the model chose to escalate', () => {
    const result = policy.apply({
      ai: ai({ decision: 'ESCALATE', answer: null }),
      knowledgeCount: 3,
      thresholds,
    });

    expect(result.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
  });

  it('escalates when no confidence was supplied at all', () => {
    // Absence is not high confidence. A provider that gives the policy nothing to work with gets a
    // human involved rather than the benefit of the doubt.
    const result = policy.apply({ ai: ai({ confidence: null }), knowledgeCount: 3, thresholds });

    expect(result.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
    expect(result.reason).toMatch(/no confidence estimate/i);
  });

  it('escalates below the escalation threshold', () => {
    const result = policy.apply({ ai: ai({ confidence: 0.5 }), knowledgeCount: 3, thresholds });

    expect(result.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
    expect(result.reasonCode).toBe(DecisionReason.AI_LOW_CONFIDENCE);
  });

  describe('the middle band', () => {
    const middling = ai({ confidence: 0.85 });

    it('escalates by default', () => {
      const result = policy.apply({ ai: middling, knowledgeCount: 3, thresholds });
      expect(result.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
    });

    it('replies when configured to', () => {
      const result = policy.apply({
        ai: middling,
        knowledgeCount: 3,
        thresholds: { ...thresholds, midPolicy: MidConfidencePolicy.REPLY },
      });
      expect(result.outcome).toBe(DecisionOutcome.AI_REPLY);
    });

    it('stays silent when configured to', () => {
      // Neither answering nor raising an escalation: for a business that would rather say nothing
      // than either guess or interrupt a person.
      const result = policy.apply({
        ai: middling,
        knowledgeCount: 3,
        thresholds: { ...thresholds, midPolicy: MidConfidencePolicy.SILENT },
      });
      expect(result.outcome).toBe(DecisionOutcome.NO_RESPONSE);
    });
  });

  it('respects configured thresholds rather than hardcoded ones', () => {
    const permissive: ConfidenceThresholds = {
      autoReplyMin: 0.5,
      escalateBelow: 0.3,
      midPolicy: MidConfidencePolicy.ESCALATE,
    };

    expect(policy.apply({ ai: ai({ confidence: 0.6 }), knowledgeCount: 2, thresholds: permissive }).outcome).toBe(
      DecisionOutcome.AI_REPLY,
    );
    expect(policy.apply({ ai: ai({ confidence: 0.6 }), knowledgeCount: 2, thresholds }).outcome).toBe(
      DecisionOutcome.HUMAN_HANDOFF,
    );
  });

  it('never turns an escalation into an answer', () => {
    // The property the whole file is built around: objective signals can only lower the outcome.
    // No combination of flags plus a high number produces a reply the signals rejected.
    const hostile = [
      ai({ needsHuman: true, confidence: 1 }),
      ai({ knowledgeSufficient: false, confidence: 1 }),
      ai({ decision: 'ESCALATE', confidence: 1 }),
      ai({ answer: null, confidence: 1 }),
    ];

    for (const result of hostile) {
      expect(policy.apply({ ai: result, knowledgeCount: 5, thresholds }).outcome).not.toBe(
        DecisionOutcome.AI_REPLY,
      );
    }
  });
});
