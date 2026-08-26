import { Injectable } from '@nestjs/common';
import {
  ActionType,
  AutomationStatus,
  ConditionType,
  SCOPE_SPECIFICITY,
  SkipReason,
  type EvaluableRule,
  type EvaluationContext,
  type EvaluationResult,
  type RuleCondition,
  type RuleMatch,
} from './automation-types';

/**
 * The rule evaluator.
 *
 * **Pure.** Rules and a context in, matches out. No database, no clock, no network, no side effects
 * — `now` arrives in the context rather than being read. Three things follow from that, and they are
 * the reason it is written this way:
 *
 *  1. The dry-run endpoint and the live engine run *the same code*, so what an administrator is
 *     shown in a test is what will actually happen.
 *  2. The winner is reproducible. Given the same rules and the same message, the same rule wins,
 *     every time, on every replica.
 *  3. It is exhaustively unit-testable without a database.
 *
 * **Nothing here executes user input.** Conditions are interpreted, never evaluated. The single
 * place where user input becomes something executable-ish is `REGEX`, which is compiled under
 * strict limits — see `compileRegex`.
 */

/** Ceilings on the one condition type that runs user-supplied syntax. */
const MAX_PATTERN_LENGTH = 200;
const MAX_REGEX_SUBJECT = 4_000;

@Injectable()
export class RuleEvaluator {
  /**
   * Compiled patterns, keyed by source.
   *
   * Bounded so a large rule set cannot grow this without limit, and so a pattern is compiled once
   * rather than on every inbound message.
   */
  private readonly regexCache = new Map<string, RegExp | null>();

  /**
   * Picks the rule that gets to act.
   *
   * Ordering, in this order and never any other:
   *   1. scope specificity — CONVERSATION > CUSTOMER > GROUP > GLOBAL
   *   2. priority, descending
   *   3. createdAt, ascending — the older rule wins a genuine tie
   *   4. id, ascending — a total order, so there is never a coin flip
   *
   * A rule that matched but is in cooldown, or has spent its execution budget, is recorded as a
   * match and cannot win. It does not block a lower-ranked rule from winning: the customer still
   * gets an answer if some other rule can give one.
   */
  evaluate(rules: EvaluableRule[], context: EvaluationContext): EvaluationResult {
    const matches: RuleMatch[] = [];

    for (const rule of rules) {
      if (rule.status !== AutomationStatus.ACTIVE) continue;
      if (!this.matchesConditions(rule, context)) continue;

      matches.push({ rule, skipped: this.skipReason(rule, context.now) });
    }

    matches.sort((a, b) => compareRules(a.rule, b.rule));

    return { winner: matches.find((match) => match.skipped === null) ?? null, matches };
  }

  /** True when the rule's condition set holds for this message. An empty set never matches. */
  private matchesConditions(rule: EvaluableRule, context: EvaluationContext): boolean {
    const set = rule.conditions;
    if (!set || !Array.isArray(set.conditions) || set.conditions.length === 0) {
      // A rule with no conditions would match every message. That is almost certainly a mistake in
      // the rule rather than an intention, and the failure mode — answering everything — is bad
      // enough that it should never be reachable by accident.
      return false;
    }

    const results = set.conditions.map((condition) => this.matchesOne(condition, context));
    return set.match === 'ANY' ? results.some(Boolean) : results.every(Boolean);
  }

  private matchesOne(condition: RuleCondition, context: EvaluationContext): boolean {
    const result = this.rawMatch(condition, context);
    return condition.negate ? !result : result;
  }

  private rawMatch(condition: RuleCondition, context: EvaluationContext): boolean {
    const body = context.body ?? '';
    const value = condition.value ?? '';

    switch (condition.type) {
      case ConditionType.EXACT:
        return body.trim() === value.trim();

      case ConditionType.NORMALIZED:
        return normalize(body) === normalize(value);

      case ConditionType.CONTAINS:
        return normalize(body).includes(normalize(value)) && value.trim().length > 0;

      case ConditionType.PREFIX:
        return normalize(body).startsWith(normalize(value)) && value.trim().length > 0;

      case ConditionType.SUFFIX:
        return normalize(body).endsWith(normalize(value)) && value.trim().length > 0;

      case ConditionType.REGEX: {
        const pattern = this.compileRegex(value);
        if (!pattern) return false;
        // Capped subject: a pathological pattern against a very long body is the classic way to
        // turn a text match into a denial of service.
        return pattern.test(body.slice(0, MAX_REGEX_SUBJECT));
      }

      case ConditionType.MESSAGE_TYPE:
        return listOf(condition).includes(context.messageType);

      case ConditionType.HAS_ATTACHMENT:
        return context.hasAttachment;

      case ConditionType.CONVERSATION_STATE:
        return listOf(condition).includes(context.conversationState);

      case ConditionType.CUSTOMER_TAG: {
        const wanted = listOf(condition).map((tag) => tag.toLowerCase());
        return context.customerTags.some((tag) => wanted.includes(tag.toLowerCase()));
      }

      case ConditionType.BUSINESS_HOURS:
        // No configured hours means the question "are we open?" has no answer, and a rule that
        // depends on it must not fire on a guess.
        return context.businessHours ? withinBusinessHours(context.businessHours, context.now) : false;

      case ConditionType.TIME_WINDOW:
        return withinWindow(condition.from, condition.to, context.now);

      default:
        // An unknown condition type is a rule written by a newer version of the software. Refusing
        // to match is the safe reading: it withholds an answer rather than inventing one.
        return false;
    }
  }

  /**
   * Compiles a pattern, or returns null.
   *
   * Length-capped and cached. A pattern that does not compile yields null and the condition simply
   * does not match — a broken rule must not throw inside the inbound path and take a customer
   * message down with it.
   *
   * This is not a defence against a deliberately catastrophic pattern; the subject cap above is
   * what bounds that. It is a defence against the ordinary case of somebody mistyping.
   */
  private compileRegex(source: string): RegExp | null {
    if (source.length === 0 || source.length > MAX_PATTERN_LENGTH) return null;

    if (this.regexCache.has(source)) return this.regexCache.get(source) ?? null;

    let compiled: RegExp | null;
    try {
      // `i` only. No `g` — a global regex carries `lastIndex` state between calls, which would make
      // the same rule behave differently on consecutive messages.
      compiled = new RegExp(source, 'i');
    } catch {
      compiled = null;
    }

    if (this.regexCache.size > 500) this.regexCache.clear();
    this.regexCache.set(source, compiled);
    return compiled;
  }

  /** Why a matching rule may not act right now. */
  private skipReason(rule: EvaluableRule, now: Date): SkipReason | null {
    if (rule.effectiveFrom && now < rule.effectiveFrom) return SkipReason.NOT_EFFECTIVE_YET;
    if (rule.effectiveUntil && now > rule.effectiveUntil) return SkipReason.EXPIRED;

    if (rule.maxExecutions !== null && rule.executionCount >= rule.maxExecutions) {
      return SkipReason.MAX_EXECUTIONS;
    }

    if (rule.cooldownSeconds > 0 && rule.lastMatchedAt) {
      const elapsed = now.getTime() - rule.lastMatchedAt.getTime();
      if (elapsed < rule.cooldownSeconds * 1_000) return SkipReason.COOLDOWN;
    }

    return null;
  }

  /**
   * Structural validation of a rule an administrator is trying to save.
   *
   * Returns problems in plain words. Called by the service on create and update, so a rule that
   * cannot work is rejected at authoring time rather than silently never matching.
   */
  validate(conditions: unknown, actions: unknown): string[] {
    const problems: string[] = [];
    const set = conditions as { match?: string; conditions?: unknown[] };

    if (!set || !Array.isArray(set.conditions) || set.conditions.length === 0) {
      problems.push('A rule needs at least one condition, or it would match every message.');
    } else {
      if (set.match !== 'ALL' && set.match !== 'ANY') {
        problems.push('Condition match must be either ALL or ANY.');
      }

      set.conditions.forEach((raw, index) => {
        const condition = raw as RuleCondition;
        if (!Object.values(ConditionType).includes(condition?.type)) {
          problems.push(`Condition ${index + 1} has an unknown type.`);
          return;
        }
        if (condition.type === ConditionType.REGEX) {
          if (!condition.value || condition.value.length > MAX_PATTERN_LENGTH) {
            problems.push(`Condition ${index + 1}: a pattern must be 1–${MAX_PATTERN_LENGTH} characters.`);
          } else if (!this.compileRegex(condition.value)) {
            problems.push(`Condition ${index + 1}: that pattern is not valid.`);
          }
        }
        const needsValue = [
          ConditionType.EXACT,
          ConditionType.NORMALIZED,
          ConditionType.CONTAINS,
          ConditionType.PREFIX,
          ConditionType.SUFFIX,
        ];
        if (needsValue.includes(condition.type) && !condition.value?.trim()) {
          problems.push(`Condition ${index + 1} needs a value to compare against.`);
        }
      });
    }

    if (!Array.isArray(actions) || actions.length === 0) {
      problems.push('A rule needs at least one action.');
    } else {
      (actions as RuleAction[]).forEach((action, index) => {
        if (!Object.values(ActionType).includes(action?.type)) {
          problems.push(`Action ${index + 1} has an unknown type.`);
          return;
        }
        if (action.type === ActionType.SEND_MESSAGE && !action.value?.trim()) {
          problems.push(`Action ${index + 1}: a reply needs text to send.`);
        }
        if (
          (action.type === ActionType.ASSIGN_TEAM || action.type === ActionType.ASSIGN_AGENT) &&
          !action.targetId
        ) {
          problems.push(`Action ${index + 1}: an assignment needs a target.`);
        }
      });

      const sends = (actions as RuleAction[]).filter((a) => a.type === ActionType.SEND_MESSAGE).length;
      if (sends > 1) {
        // One rule, at most one customer-facing message. Two would double-message a customer for a
        // single inbound, which is never what somebody means.
        problems.push('A rule can send at most one message.');
      }
    }

    return problems;
  }
}

type RuleAction = { type: ActionType; value?: string; targetId?: string };

/** The total order that decides a winner. Exported for the tests that pin it down. */
export function compareRules(a: EvaluableRule, b: EvaluableRule): number {
  const specificity = SCOPE_SPECIFICITY[b.scopeType] - SCOPE_SPECIFICITY[a.scopeType];
  if (specificity !== 0) return specificity;

  if (b.priority !== a.priority) return b.priority - a.priority;

  const age = a.createdAt.getTime() - b.createdAt.getTime();
  if (age !== 0) return age;

  return a.id.localeCompare(b.id);
}

/**
 * Case, whitespace and punctuation folded away.
 *
 * "Hello!", "hello" and "  HELLO  " are the same greeting from a customer's point of view, and a
 * rule author should not have to enumerate the variants.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function listOf(condition: RuleCondition): string[] {
  if (condition.values && condition.values.length > 0) return condition.values;
  return condition.value ? [condition.value] : [];
}

/** `HH:MM` to minutes since midnight, or null if it is not a time. */
function toMinutes(value: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/** Handles a window that wraps midnight, which is the common case for out-of-hours rules. */
function withinWindow(from: string | undefined, to: string | undefined, now: Date): boolean {
  const start = toMinutes(from);
  const end = toMinutes(to);
  if (start === null || end === null) return false;

  const current = now.getHours() * 60 + now.getMinutes();
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

function withinBusinessHours(hours: { days: Record<string, { from: string; to: string }> }, now: Date): boolean {
  const today = hours.days?.[String(now.getDay())];
  if (!today) return false;
  return withinWindow(today.from, today.to, now);
}
