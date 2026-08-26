/**
 * The decision vocabulary.
 *
 * One inbound customer message produces exactly one `DecisionOutcome`, and the pipeline that
 * produces it is the only authority permitted to cause an automatic reply (`PROJECT_SPEC.md` §5,
 * §161).
 */

export enum DecisionStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum DecisionOutcome {
  /** Nothing to do — not a customer message, monitoring off, or a rule said to ignore it. */
  IGNORE = 'IGNORE',
  /** A deterministic rule answered. */
  RULE_REPLY = 'RULE_REPLY',
  /** Knowledge-grounded AI answered with sufficient confidence. */
  AI_REPLY = 'AI_REPLY',
  /** A person now owns this conversation. Automatic responders stand down. */
  HUMAN_HANDOFF = 'HUMAN_HANDOFF',
  /** A person already owned it before this message arrived. */
  HUMAN_HANDLING = 'HUMAN_HANDLING',
  /** Deliberately no reply: paused, out of hours, or nothing matched and AI is off. */
  NO_RESPONSE = 'NO_RESPONSE',
  /** A loop guard or rate limit stopped a reply that would otherwise have been sent. */
  SUPPRESSED = 'SUPPRESSED',
  /** The pipeline itself failed. The message is still stored; a human is told. */
  FAILED = 'FAILED',
}

/**
 * Machine-readable "why".
 *
 * A short token beside the human sentence, so decisions can be counted and filtered without parsing
 * prose — "how often did we escalate for low confidence last week" should be a GROUP BY.
 */
export enum DecisionReason {
  /** The customer asked for a person, in so many words. Outranks every rule (§39). */
  CUSTOMER_REQUESTED_HUMAN = 'CUSTOMER_REQUESTED_HUMAN',
  NOT_CUSTOMER_MESSAGE = 'NOT_CUSTOMER_MESSAGE',
  MONITORING_DISABLED = 'MONITORING_DISABLED',
  EMERGENCY_STOP = 'EMERGENCY_STOP',
  HUMAN_TAKEOVER_ACTIVE = 'HUMAN_TAKEOVER_ACTIVE',
  CONVERSATION_PAUSED = 'CONVERSATION_PAUSED',
  CONVERSATION_CLOSED = 'CONVERSATION_CLOSED',
  RULE_MATCHED = 'RULE_MATCHED',
  RULE_IGNORE = 'RULE_IGNORE',
  RULE_ESCALATE = 'RULE_ESCALATE',
  NO_RULE_MATCH = 'NO_RULE_MATCH',
  /**
   * AI is switched off somewhere in the permission chain.
   *
   * Retained as the general case and still emitted when no single layer can be named. Rows written
   * before the per-layer codes below carry this value, so a query counting "AI was off" should
   * include it alongside them rather than assume the specific codes cover the whole history.
   */
  AI_DISABLED = 'AI_DISABLED',
  /**
   * The specific layer withholding AI, so the console can say which switch to change instead of
   * only that something is off. `reasonCode` is a plain varchar column, so these needed no
   * migration — but they only exist from the moment they were introduced.
   */
  AI_DISABLED_GROUP = 'AI_DISABLED_GROUP',
  AI_DISABLED_CONVERSATION = 'AI_DISABLED_CONVERSATION',
  AI_DISABLED_PROFILE = 'AI_DISABLED_PROFILE',
  AI_UNAVAILABLE = 'AI_UNAVAILABLE',
  AI_FAILED = 'AI_FAILED',
  AI_ANSWERED = 'AI_ANSWERED',
  AI_LOW_CONFIDENCE = 'AI_LOW_CONFIDENCE',
  AI_NEEDS_HUMAN = 'AI_NEEDS_HUMAN',
  KNOWLEDGE_INSUFFICIENT = 'KNOWLEDGE_INSUFFICIENT',
  LOOP_GUARD = 'LOOP_GUARD',
  RATE_LIMITED = 'RATE_LIMITED',
  REPEATED_MESSAGE = 'REPEATED_MESSAGE',
  ENGINE_ERROR = 'ENGINE_ERROR',
}

/**
 * What the engine decided.
 *
 * A **value**, not an action. The engine cannot send: it is constructed without `MessageService`,
 * without a channel adapter and without the outbound queue, and returning this is the only thing it
 * can do. A separate executor acts on it (`PROJECT_SPEC.md` §161).
 */
export interface Decision {
  outcome: DecisionOutcome;
  reasonCode: DecisionReason;
  /** One sentence an operator can read in the trace. */
  reason: string;

  /** The text to send, when the outcome is a reply. Never set for any other outcome. */
  reply?: string | null;

  rule?: { id: string; name: string; version: number } | null;
  candidateRuleIds?: string[];
  profileId?: string | null;

  ai?: {
    /** Null when no provider answered — a failure path has no vendor to name. */
    provider: string | null;
    model: string | null;
    /** Self-reported and uncalibrated — see `confidenceCalibrated` on the decision log. */
    confidence: number | null;
    knowledgeSufficient: boolean;
  } | null;

  knowledge?: {
    used: boolean;
    articleIds: string[];
    chunkIds: string[];
  } | null;

  escalation?: { reason: string; detail?: string } | null;

  /** Side effects a rule asked for, applied by the executor after the reply decision. */
  effects?: DecisionEffect[];
}

export type DecisionEffect =
  | { type: 'ADD_TAG'; value: string }
  | { type: 'REMOVE_TAG'; value: string }
  | { type: 'SET_CONVERSATION_STATE'; value: string }
  | { type: 'ASSIGN_TEAM'; targetId: string }
  | { type: 'ASSIGN_AGENT'; targetId: string };

/** Outcomes that cause a customer-facing message. Used by the executor and by the tests. */
export const REPLYING_OUTCOMES: readonly DecisionOutcome[] = [
  DecisionOutcome.RULE_REPLY,
  DecisionOutcome.AI_REPLY,
];
