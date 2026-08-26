/**
 * The conversation state model.
 *
 * ## Two axes, not one
 *
 * `PROJECT_SPEC.md` §7 lists seven states on a single axis: `AUTOMATION_ACTIVE`, `AI_ACTIVE`,
 * `HUMAN_ACTIVE`, `HUMAN_REQUIRED`, `PAUSED`, `WAITING_CUSTOMER`, `RESOLVED`. Read closely, that
 * list mixes two independent questions:
 *
 *   1. **Where is this conversation in its support lifecycle?** (open, waiting, resolved)
 *   2. **Who is allowed to respond right now?** (automation, AI, a human, nobody)
 *
 * They are independent. A conversation can be `WAITING_FOR_CUSTOMER` while a human still holds it,
 * and it can be `OPEN` under any of the three responders. Collapsing them into one enum forces a
 * lossy choice every time both change, and makes "the customer replied, who should answer?"
 * unanswerable without extra columns anyway.
 *
 * So Phase 3 models them separately, as the Phase 3 brief §3 and §6/§7 do. The spec's seven states
 * map onto the pair without loss:
 *
 * | `PROJECT_SPEC.md` §7 | status                 | controlState        |
 * |----------------------|------------------------|---------------------|
 * | AUTOMATION_ACTIVE    | OPEN                   | AUTOMATION_ACTIVE   |
 * | AI_ACTIVE            | OPEN                   | AI_ACTIVE           |
 * | HUMAN_ACTIVE         | OPEN                   | HUMAN_ACTIVE        |
 * | HUMAN_REQUIRED       | WAITING_FOR_HUMAN      | (unchanged)         |
 * | PAUSED               | (unchanged)            | PAUSED              |
 * | WAITING_CUSTOMER     | WAITING_FOR_CUSTOMER   | (unchanged)         |
 * | RESOLVED             | RESOLVED               | (unchanged)         |
 *
 * `toSpecState()` below performs that projection, so anything that needs the spec's vocabulary —
 * the Phase 5 decision engine, Phase 9 reporting — can obtain it without this module having to
 * store a redundant third column that could drift.
 *
 * ## What this module does NOT do
 *
 * It stores and validates state. It decides nothing. The Phase 3 brief §6 is explicit: the
 * Conversation module stores state, the Message Decision Engine interprets it later. There is no
 * "should AI reply" logic here, and there must not be.
 */

/** Where the conversation is in its support lifecycle. */
export enum ConversationStatus {
  /** Live and needing attention. */
  OPEN = 'OPEN',
  /** Acknowledged, work is in progress, nobody is blocked on anybody. */
  PENDING = 'PENDING',
  /** We answered; the ball is with the customer. */
  WAITING_FOR_CUSTOMER = 'WAITING_FOR_CUSTOMER',
  /** Escalated or handed over; a human must act. Maps to the spec's HUMAN_REQUIRED. */
  WAITING_FOR_HUMAN = 'WAITING_FOR_HUMAN',
  /** The issue is dealt with, but the conversation can still reopen on a new customer message. */
  RESOLVED = 'RESOLVED',
  /** Terminal. A new message starts a new conversation rather than reopening this one. */
  CLOSED = 'CLOSED',
}

/** Who is permitted to respond. Phase 5 reads this; Phase 3 only records it. */
export enum ConversationControlState {
  AUTOMATION_ACTIVE = 'AUTOMATION_ACTIVE',
  AI_ACTIVE = 'AI_ACTIVE',
  /** A human holds the conversation. Automated responders must stand down. */
  HUMAN_ACTIVE = 'HUMAN_ACTIVE',
  /** Nobody responds automatically. Set by an operator or by an expiry-bearing pause. */
  PAUSED = 'PAUSED',
}

/** A conversation is either a one-to-one chat or a group (Phase 3 brief §4). */
export enum ConversationKind {
  DIRECT = 'DIRECT',
  GROUP = 'GROUP',
}

export enum ConversationPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

/**
 * Legal status transitions.
 *
 * Two properties worth stating explicitly:
 *  - `CLOSED` is terminal. Nothing transitions out of it; a new message opens a new conversation.
 *    That is what makes it different from `RESOLVED`, which reopens.
 *  - `RESOLVED → OPEN` exists because `PROJECT_SPEC.md` §7 requires a resolved conversation to be
 *    reopenable by a new customer message, subject to configuration.
 */
export const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<ConversationStatus, readonly ConversationStatus[]>> = {
  [ConversationStatus.OPEN]: [
    ConversationStatus.PENDING,
    ConversationStatus.WAITING_FOR_CUSTOMER,
    ConversationStatus.WAITING_FOR_HUMAN,
    ConversationStatus.RESOLVED,
    ConversationStatus.CLOSED,
  ],
  [ConversationStatus.PENDING]: [
    ConversationStatus.OPEN,
    ConversationStatus.WAITING_FOR_CUSTOMER,
    ConversationStatus.WAITING_FOR_HUMAN,
    ConversationStatus.RESOLVED,
    ConversationStatus.CLOSED,
  ],
  [ConversationStatus.WAITING_FOR_CUSTOMER]: [
    ConversationStatus.OPEN,
    ConversationStatus.PENDING,
    ConversationStatus.WAITING_FOR_HUMAN,
    ConversationStatus.RESOLVED,
    ConversationStatus.CLOSED,
  ],
  [ConversationStatus.WAITING_FOR_HUMAN]: [
    ConversationStatus.OPEN,
    ConversationStatus.PENDING,
    ConversationStatus.WAITING_FOR_CUSTOMER,
    ConversationStatus.RESOLVED,
    ConversationStatus.CLOSED,
  ],
  [ConversationStatus.RESOLVED]: [
    // Reopening is the point of RESOLVED existing separately from CLOSED.
    ConversationStatus.OPEN,
    ConversationStatus.CLOSED,
  ],
  [ConversationStatus.CLOSED]: [],
};

/**
 * Legal control-state transitions.
 *
 * Every state can reach every other, which looks permissive until you consider what each means: a
 * human can always take over from anything, a pause can always be applied, and releasing back to
 * AI or automation is an explicit operator act. The constraint that matters is not *which*
 * transitions are legal but that each one is recorded with an actor and a reason — that is what
 * `conversation_state_history` is for.
 *
 * The self-transition is excluded so a no-op cannot manufacture a history row.
 */
export function isControlTransitionAllowed(
  from: ConversationControlState,
  to: ConversationControlState,
): boolean {
  return from !== to;
}

export function isStatusTransitionAllowed(from: ConversationStatus, to: ConversationStatus): boolean {
  if (from === to) return false;
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

/** The spec's §7 single-axis vocabulary, projected from the pair. Never stored — always derived. */
export type SpecConversationState =
  | 'AUTOMATION_ACTIVE'
  | 'AI_ACTIVE'
  | 'HUMAN_ACTIVE'
  | 'HUMAN_REQUIRED'
  | 'PAUSED'
  | 'WAITING_CUSTOMER'
  | 'RESOLVED';

/**
 * Projects the two axes onto `PROJECT_SPEC.md` §7's list.
 *
 * Order matters and encodes precedence: a paused conversation is PAUSED whatever its lifecycle
 * says, and a conversation waiting on a human is HUMAN_REQUIRED whoever nominally holds control.
 * Both of those are safety-relevant readings — they are the states in which an automated responder
 * must not act — so they win over the more permissive ones.
 */
export function toSpecState(
  status: ConversationStatus,
  controlState: ConversationControlState,
): SpecConversationState {
  if (controlState === ConversationControlState.PAUSED) return 'PAUSED';
  if (status === ConversationStatus.WAITING_FOR_HUMAN) return 'HUMAN_REQUIRED';
  if (status === ConversationStatus.RESOLVED || status === ConversationStatus.CLOSED) return 'RESOLVED';
  if (status === ConversationStatus.WAITING_FOR_CUSTOMER) return 'WAITING_CUSTOMER';

  switch (controlState) {
    case ConversationControlState.HUMAN_ACTIVE:
      return 'HUMAN_ACTIVE';
    case ConversationControlState.AI_ACTIVE:
      return 'AI_ACTIVE';
    default:
      return 'AUTOMATION_ACTIVE';
  }
}

/** Statuses in which a conversation is still live work. Used for inbox filters and counts. */
export function isActiveStatus(status: ConversationStatus): boolean {
  return (
    status === ConversationStatus.OPEN ||
    status === ConversationStatus.PENDING ||
    status === ConversationStatus.WAITING_FOR_CUSTOMER ||
    status === ConversationStatus.WAITING_FOR_HUMAN
  );
}

/** What caused a state change. Recorded on every history row so the trail is explicable. */
export enum StateChangeSource {
  /** An operator acted through the API. */
  HUMAN = 'HUMAN',
  /** Support CRM itself concluded it — a takeover expiring, a conversation opening on first message. */
  SYSTEM = 'SYSTEM',
  /** Reserved for Phase 5. Nothing in Phase 3 writes this. */
  AUTOMATION = 'AUTOMATION',
  /** Reserved for Phase 6. Nothing in Phase 3 writes this. */
  AI = 'AI',
}
