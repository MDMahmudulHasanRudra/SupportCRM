/**
 * Who is withholding permission, and the permission itself — from one derivation.
 *
 * The product rests on a single rule: **a group with AI switched off must never receive an
 * automated reply**, whatever else is true. That rule is enforced by composing the layers rather
 * than choosing between them — every level holds a veto, and a `false` anywhere is decisive.
 *
 * The operations console also has to *explain* the outcome ("AI is disabled because Group AI is
 * OFF"), and that is where this file earns its place. The obvious implementation — compose a
 * boolean for the engine, and separately inspect the layers for the UI — produces two answers to
 * one question, and they drift the first time somebody adds a layer to one and not the other. The
 * failure is silent and it lands in the worst place: a screen confidently reporting that AI is
 * blocked by the group while the engine happily replies, or the reverse.
 *
 * So `effective` and `blockedBy` come out of the same pass over the same inputs. The explanation is
 * not a second opinion; it is the arithmetic that produced the boolean.
 *
 * This is diagnosis, never enforcement. Nothing here decides anything — the engine still gates on
 * `effective`, and the backend remains the only authority. A caller that trusted `blockedBy` and
 * ignored `effective` would be reading a description as a permission.
 */

/** The layers that can withhold a permission, most general to most specific. */
export type PermissionLayer = 'PROFILE' | 'GROUP' | 'CONVERSATION';

export interface PermissionChain {
  /**
   * Each layer's own answer, in the order they are applied.
   *
   * `null` means the layer does not apply to this message rather than that it said no — a direct
   * chat has no group, and a conversation with no automation profile has no profile. Absence must
   * never read as denial, or AI would be off for every one-to-one conversation in the product.
   */
  profile: boolean | null;
  group: boolean | null;
  conversation: boolean;

  /**
   * Every layer withholding permission, most specific last. Empty when the action is permitted.
   *
   * A list rather than the first match, because more than one layer can be off at once and telling
   * an operator to fix only the group is wrong when the conversation is muted too.
   */
  blockedBy: PermissionLayer[];

  /** The composed permission. This is the value the engine gates on. */
  effective: boolean;
}

/**
 * Composes one permission across the layers that apply to a message.
 *
 * Pass `null` for a layer that is absent. Anything present and `false` withholds the permission and
 * is named in `blockedBy`.
 */
export function composePermission(input: {
  conversation: boolean;
  group: boolean | null;
  profile: boolean | null;
}): PermissionChain {
  const blockedBy: PermissionLayer[] = [];

  // Ordered general → specific so the list reads the way the hierarchy does.
  if (input.profile === false) blockedBy.push('PROFILE');
  if (input.group === false) blockedBy.push('GROUP');
  if (!input.conversation) blockedBy.push('CONVERSATION');

  return {
    profile: input.profile,
    group: input.group,
    conversation: input.conversation,
    blockedBy,
    // Not a re-derivation: permitted exactly when nothing withheld it. Computing this independently
    // of `blockedBy` is what would let the two disagree.
    effective: blockedBy.length === 0,
  };
}

/** The most specific layer withholding permission, which is the one an operator should act on. */
export function primaryBlocker(chain: PermissionChain): PermissionLayer | null {
  return chain.blockedBy.length === 0 ? null : chain.blockedBy[chain.blockedBy.length - 1];
}
