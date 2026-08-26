import { EscalationReason } from './entities/escalation.entity';

/**
 * Escalation configuration, and the score that sets its priority (`PROJECT_SPEC.md` §28–§34, §40).
 *
 * Pure. No database, no clock beyond what is handed in — the same discipline as the rule evaluator,
 * for the same reason: how urgently a waiting customer is treated should be reproducible from its
 * inputs and testable without infrastructure.
 */

export enum EscalationPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

/**
 * One level of escalation configuration.
 *
 * Every field optional, because the hierarchy is Global → Support Profile → Group → Conversation
 * and each level states only what it changes.
 */
export interface EscalationPolicy {
  /** The WhatsApp group support staff watch. */
  internalGroupId?: string | null;
  /** Individual people to notify for the serious ones. */
  primaryExecutiveUserId?: string | null;
  secondaryExecutiveUserId?: string | null;
  notifyInternalGroup?: boolean;
  notifyExecutives?: boolean;
  /**
   * Whether to tell the customer a human is coming (§32).
   *
   * Configurable rather than assumed: on a busy account "someone will be with you" every time is
   * noise, and on a quiet one it is reassurance.
   */
  notifyCustomer?: boolean;
  customerNotice?: string | null;
  /** How many times the AI may try before a person is fetched regardless of confidence. */
  maxAiAttempts?: number;
  /** How many automated replies one conversation may receive in total. */
  maxAiReplies?: number;
  /** Consecutive automated replies with no human in between. */
  maxConsecutiveAiReplies?: number;
  /** Seconds of quiet required before automation may reply again after a human did. */
  humanReplyCooldownSeconds?: number;
  /** The score at or above which a conversation escalates on accumulated signals alone. */
  escalationScoreThreshold?: number;
  guidance?: string | null;
}

export const DEFAULT_ESCALATION_POLICY: Required<
  Pick<
    EscalationPolicy,
    | 'notifyInternalGroup'
    | 'notifyExecutives'
    | 'notifyCustomer'
    | 'maxAiAttempts'
    | 'maxAiReplies'
    | 'maxConsecutiveAiReplies'
    | 'humanReplyCooldownSeconds'
    | 'escalationScoreThreshold'
  >
> = {
  notifyInternalGroup: true,
  // Off by default: waking an executive is a decision somebody makes deliberately, per account.
  notifyExecutives: false,
  notifyCustomer: false,
  maxAiAttempts: 3,
  maxAiReplies: 5,
  maxConsecutiveAiReplies: 3,
  humanReplyCooldownSeconds: 900,
  escalationScoreThreshold: 5,
};

/** Merges the hierarchy, broadest first. A later layer overrides only the fields it sets. */
export function mergeEscalationPolicy(...layers: Array<EscalationPolicy | null | undefined>): EscalationPolicy {
  const merged: EscalationPolicy = { ...DEFAULT_ESCALATION_POLICY };

  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== null && value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }

  return merged;
}

/**
 * Signals that push a conversation toward a person (§28, §40).
 *
 * Weighted rather than boolean because they compound: one "still not working" is a data point, and
 * three of them plus two failed AI attempts is a customer who has been talking to a machine for
 * twenty minutes and needs rescuing.
 */
export interface EscalationSignals {
  lowConfidence?: boolean;
  knowledgeMissing?: boolean;
  customerAskedForHuman?: boolean;
  repeatedComplaint?: boolean;
  aiAttempts?: number;
  aiFailures?: boolean;
  sensitiveRequest?: boolean;
  loopDetected?: boolean;
  angry?: boolean;
}

const WEIGHTS: Record<keyof EscalationSignals, number> = {
  // An explicit request is decisive on its own — see `scoreEscalation`.
  customerAskedForHuman: 10,
  sensitiveRequest: 10,
  loopDetected: 6,
  aiFailures: 4,
  knowledgeMissing: 3,
  repeatedComplaint: 3,
  angry: 3,
  lowConfidence: 2,
  aiAttempts: 1,
};

export interface EscalationVerdict {
  score: number;
  priority: EscalationPriority;
  /** The strongest reason, for the escalation record and the queue. */
  reason: EscalationReason;
  /** Whether the accumulated signals alone justify fetching a person. */
  shouldEscalate: boolean;
}

/**
 * Turns signals into a score, a priority and a reason.
 *
 * Two signals bypass the arithmetic entirely: a customer explicitly asking for a person, and a
 * request touching a restricted operation. Neither is a matter of degree, and neither should ever
 * be outvoted by a confident model.
 */
export function scoreEscalation(signals: EscalationSignals, threshold: number): EscalationVerdict {
  let score = 0;
  for (const [key, weight] of Object.entries(WEIGHTS) as Array<[keyof EscalationSignals, number]>) {
    const value = signals[key];
    if (typeof value === 'number') score += weight * value;
    else if (value) score += weight;
  }

  const decisive = Boolean(signals.customerAskedForHuman) || Boolean(signals.sensitiveRequest);

  const priority = decisive || score >= threshold * 2
    ? EscalationPriority.URGENT
    : score >= threshold
      ? EscalationPriority.HIGH
      : score >= Math.max(1, Math.floor(threshold / 2))
        ? EscalationPriority.NORMAL
        : EscalationPriority.LOW;

  return {
    score,
    priority,
    reason: strongestReason(signals),
    shouldEscalate: decisive || score >= threshold,
  };
}

function strongestReason(signals: EscalationSignals): EscalationReason {
  if (signals.customerAskedForHuman) return EscalationReason.CUSTOMER_REQUESTED;
  if (signals.sensitiveRequest) return EscalationReason.RULE_ESCALATION;
  if (signals.aiFailures) return EscalationReason.AI_FAILED;
  if (signals.knowledgeMissing) return EscalationReason.KNOWLEDGE_INSUFFICIENT;
  if (signals.loopDetected || signals.repeatedComplaint) return EscalationReason.REPEATED_FAILURE;
  if (signals.lowConfidence) return EscalationReason.LOW_CONFIDENCE;
  return EscalationReason.NO_AUTOMATION_MATCH;
}

/**
 * Does this message ask for a person? (§39)
 *
 * Bangla, English, and the mix people actually type. Deliberately generous: the cost of fetching a
 * human who was not strictly needed is a moment of an agent's time, and the cost of missing the
 * request is a customer arguing with a machine — which §39 forbids outright.
 *
 * Matching is on a normalised copy, so punctuation, case and repeated spaces do not defeat it.
 */
const HUMAN_REQUEST_PATTERNS: RegExp[] = [
  // English
  /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a\s+)?(?:human|person|agent|someone|somebody|representative)\b/,
  /\b(?:real|actual|live)\s+(?:person|human|agent)\b/,
  /\b(?:human|agent|operator|representative)\s+(?:please|plz)\b/,
  /\bcustomer\s+(?:care|service|support)\s+(?:agent|person|number)?\b/,
  /\bconnect\s+me\b/,
  /\bi\s+(?:want|need)\s+(?:an?\s+)?(?:human|person|agent)\b/,
  // Bangla, in Bengali script
  /মানুষ(?:ের)?\s*(?:সাথে|সঙ্গে)?\s*(?:কথা)?/,
  /এজেন্ট/,
  /(?:সাপোর্ট|সার্ভিস)\s*(?:এজেন্ট|টিম)?\s*(?:দেন|চাই|লাগবে)/,
  /কাস্টমার\s*কেয়ার/,
  // Romanised Bangla, which is how most of it is actually typed
  /\bmanush(?:er)?\s*(?:sathe|shathe)?\b/,
  /\b(?:agent|human|support)\s*(?:chai|lagbe|den|dorkar)\b/,
  /\bkotha\s+bol/,
];

export function asksForHuman(text: string | null | undefined): boolean {
  if (!text) return false;

  const normalised = text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalised) return false;
  return HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(normalised));
}

/**
 * Does this message repeat a complaint? (§28)
 *
 * "Still not working" in its common forms. A second one of these after an automated answer is the
 * clearest signal available that the automation is not helping.
 */
const REPEATED_COMPLAINT_PATTERNS: RegExp[] = [
  /\bstill\s+(?:not|isn t|isnt|doesn t|doesnt)\s+(?:work|working|fixed)\b/,
  /\bnot\s+working\s+(?:yet|still)\b/,
  /\bsame\s+problem\b/,
  /\bagain\s+(?:not|no)\s+(?:work|working|internet)\b/,
  /\bekhono\s+(?:hoy|hocche|hochhe)\s*(?:na|ni)\b/,
  /এখনো\s*(?:হয়নি|হচ্ছে\s*না|ঠিক\s*হয়নি)/,
];

export function repeatsComplaint(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalised = text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return REPEATED_COMPLAINT_PATTERNS.some((pattern) => pattern.test(normalised));
}
