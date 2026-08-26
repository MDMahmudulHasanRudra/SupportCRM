/**
 * The automation vocabulary.
 *
 * Rules are **data**. Everything in this file describes a structure that gets *interpreted* — there
 * is no code path anywhere in Phase 5 that executes a string from the database. No `eval`, no
 * `new Function`, no dynamic import. An administrator who can write a rule must not thereby be able
 * to run arbitrary code on the server, and the only way to guarantee that is for the rule format to
 * have no room for code in it.
 */

/** `PROJECT_SPEC.md` §199. Only ACTIVE rules execute. */
export enum AutomationStatus {
  DRAFT = 'DRAFT',
  REVIEW = 'REVIEW',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ARCHIVED = 'ARCHIVED',
}

/**
 * How specific a rule is.
 *
 * This is the FIRST ordering key when picking a winner, ahead of priority: a rule written for one
 * conversation should beat a global catch-all however high the catch-all's priority number.
 */
export enum RuleScopeType {
  CONVERSATION = 'CONVERSATION',
  CUSTOMER = 'CUSTOMER',
  GROUP = 'GROUP',
  GLOBAL = 'GLOBAL',
}

export const SCOPE_SPECIFICITY: Record<RuleScopeType, number> = {
  [RuleScopeType.CONVERSATION]: 4,
  [RuleScopeType.CUSTOMER]: 3,
  [RuleScopeType.GROUP]: 2,
  [RuleScopeType.GLOBAL]: 1,
};

/** Who or what wrote a rule. AI suggestions never become ACTIVE without a human (brief §25). */
export enum RuleOrigin {
  HUMAN = 'HUMAN',
  AI_SUGGESTED = 'AI_SUGGESTED',
  IMPORTED = 'IMPORTED',
}

// === conditions ====================================================================================

export enum ConditionType {
  /** Whole message equals the value, after trimming. Case-sensitive. */
  EXACT = 'EXACT',
  /** Equals after lowercasing, collapsing whitespace and stripping punctuation. */
  NORMALIZED = 'NORMALIZED',
  CONTAINS = 'CONTAINS',
  PREFIX = 'PREFIX',
  SUFFIX = 'SUFFIX',
  /** Anchored, length-capped, compiled once. See `rule-evaluator.ts` for the limits. */
  REGEX = 'REGEX',
  MESSAGE_TYPE = 'MESSAGE_TYPE',
  HAS_ATTACHMENT = 'HAS_ATTACHMENT',
  CONVERSATION_STATE = 'CONVERSATION_STATE',
  CUSTOMER_TAG = 'CUSTOMER_TAG',
  /** Inside the profile's configured business hours. */
  BUSINESS_HOURS = 'BUSINESS_HOURS',
  /** A daily window, e.g. 22:00–06:00 for an out-of-hours autoresponder. */
  TIME_WINDOW = 'TIME_WINDOW',
}

export interface RuleCondition {
  type: ConditionType;
  /** The comparison value. Meaning depends on `type`. */
  value?: string;
  /** For MESSAGE_TYPE, CONVERSATION_STATE, CUSTOMER_TAG — any of these matches. */
  values?: string[];
  /** Inverts the result of this one condition. */
  negate?: boolean;
  /** TIME_WINDOW only, 24-hour `HH:MM`. */
  from?: string;
  to?: string;
}

export interface RuleConditionSet {
  /** ALL = every condition must hold. ANY = at least one. */
  match: 'ALL' | 'ANY';
  conditions: RuleCondition[];
}

// === actions =======================================================================================

export enum ActionType {
  SEND_MESSAGE = 'SEND_MESSAGE',
  ESCALATE = 'ESCALATE',
  IGNORE = 'IGNORE',
  ADD_TAG = 'ADD_TAG',
  REMOVE_TAG = 'REMOVE_TAG',
  SET_CONVERSATION_STATE = 'SET_CONVERSATION_STATE',
  ASSIGN_TEAM = 'ASSIGN_TEAM',
  ASSIGN_AGENT = 'ASSIGN_AGENT',
  /** Hand this message to the knowledge-grounded AI path instead of answering deterministically. */
  TRIGGER_KNOWLEDGE_AI = 'TRIGGER_KNOWLEDGE_AI',
}

export interface RuleAction {
  type: ActionType;
  /** SEND_MESSAGE body, ESCALATE detail, tag name, state name, or an id for the ASSIGN_* actions. */
  value?: string;
  targetId?: string;
}

// === evaluation results ============================================================================

export interface EvaluableRule {
  id: string;
  name: string;
  status: AutomationStatus;
  priority: number;
  scopeType: RuleScopeType;
  scopeId: string | null;
  version: number;
  conditions: RuleConditionSet;
  actions: RuleAction[];
  cooldownSeconds: number;
  maxExecutions: number | null;
  executionCount: number;
  lastMatchedAt: Date | null;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  createdAt: Date;
}

/** Why a rule that matched was nonetheless not allowed to act. */
export enum SkipReason {
  COOLDOWN = 'COOLDOWN',
  MAX_EXECUTIONS = 'MAX_EXECUTIONS',
  NOT_EFFECTIVE_YET = 'NOT_EFFECTIVE_YET',
  EXPIRED = 'EXPIRED',
}

export interface RuleMatch {
  rule: EvaluableRule;
  /** Set when the rule matched but may not act. Skipped rules never win. */
  skipped: SkipReason | null;
}

export interface EvaluationResult {
  /** The single rule that gets to act, or null. */
  winner: RuleMatch | null;
  /** Everything that matched, winner first, so "why that rule?" is answerable. */
  matches: RuleMatch[];
}

/**
 * Everything the evaluator is allowed to look at.
 *
 * Deliberately a plain value: no repositories, no clock, no network. `now` is passed in rather than
 * read, which is what makes an evaluation reproducible — and what lets the dry-run endpoint show an
 * administrator exactly what would happen at a given moment.
 */
export interface EvaluationContext {
  body: string;
  messageType: string;
  hasAttachment: boolean;
  conversationState: string;
  customerTags: string[];
  now: Date;
  /** Profile business hours, if configured. Absent means BUSINESS_HOURS conditions cannot match. */
  businessHours?: BusinessHours | null;
  /** IANA zone for time comparisons. Falls back to the server's zone. */
  timezone?: string;
}

export interface BusinessHours {
  timezone?: string;
  /** 0 = Sunday. Days absent from the map are closed. */
  days: Record<string, { from: string; to: string }>;
}
