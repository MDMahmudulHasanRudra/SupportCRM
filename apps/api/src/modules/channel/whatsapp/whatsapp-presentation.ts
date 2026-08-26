import { ChannelConnectionState } from '../channel-connection';

/**
 * What Support CRM tells an administrator about a WhatsApp connection.
 *
 * `docs/WHATSAPP_UX_ARCHITECTURE.md` §4 and §8. Two jobs, both about the boundary:
 *
 *  1. **Presentation states.** The stored machine has seven values; the UI needs to distinguish two
 *     more — a revoked pairing (which needs a human to re-link) from an ordinary error, and an
 *     automatic recovery from a first connection. Both are *derived* here rather than stored, so the
 *     state machine and its migration stay as they are.
 *  2. **Human messages.** Gateway detail never reaches the browser: no stack traces, no URLs, no
 *     ports, no session UUIDs, no API keys, no Docker errors, no OpenWA type names.
 */

/** The vocabulary the UI reacts to. A superset of `ChannelConnectionState`, never persisted. */
export type PresentationState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QR_REQUIRED'
  | 'CONNECTED'
  | 'DISCONNECTING'
  | 'RECONNECTING'
  | 'RECOVERY_FAILED'
  | 'AUTH_FAILURE'
  | 'SESSION_ERROR'
  | 'UNKNOWN';

/**
 * Phrases in a gateway error that mean the pairing itself was revoked — the phone was unlinked, or
 * WhatsApp logged the device out. This is the one failure a retry cannot fix: it needs a human to
 * scan a new QR, and telling them to "try again" would waste their time.
 */
const AUTH_FAILURE_HINTS = ['logged out', 'logout', 'unpaired', 'unlink', 'unauthor', 'auth fail', 'banned'];

export interface PresentationInput {
  status: ChannelConnectionState;
  lastError: string | null;
  /** Set once the account has ever paired. Distinguishes a recovery from a first connection. */
  lastConnectedAt: Date | null;
  /** Automatic recovery has an attempt booked for this account (Phase 3.5). */
  recoveryNextAttemptAt?: Date | null;
  /** Automatic recovery spent its budget and stopped. The account is waiting for a human. */
  recoveryExhaustedAt?: Date | null;
}

export function toPresentationState(input: PresentationInput): PresentationState {
  const error = (input.lastError ?? '').toLowerCase();

  // A revoked pairing outranks everything: no amount of retrying fixes it, and saying "reconnecting"
  // would send an operator away from the one action that would help.
  if (
    input.status === ChannelConnectionState.ERROR &&
    AUTH_FAILURE_HINTS.some((hint) => error.includes(hint))
  ) {
    return 'AUTH_FAILURE';
  }

  // Recovery states describe an account that is DOWN. A booking left over from an earlier outage
  // must never mask a session that is up again — belt and braces alongside clearing the cycle on
  // CONNECTED, because "Reconnecting…" over a working account is worse than no status at all.
  const isDown =
    input.status === ChannelConnectionState.DISCONNECTED ||
    input.status === ChannelConnectionState.UNKNOWN ||
    input.status === ChannelConnectionState.ERROR;

  if (isDown) {
    // Recovery has given up. Distinct from a plain disconnect, because the difference between
    // "press Connect" and "it is handling itself" is the whole point.
    if (input.recoveryExhaustedAt) return 'RECOVERY_FAILED';

    // An attempt is booked. Nothing for the operator to do but wait.
    if (input.recoveryNextAttemptAt) return 'RECONNECTING';
  }

  if (input.status === ChannelConnectionState.ERROR) return 'SESSION_ERROR';

  // Connecting on an account that has paired before is a recovery, not a first connection — worth
  // saying differently, because the operator does not need to reach for their phone.
  if (input.status === ChannelConnectionState.CONNECTING && input.lastConnectedAt) {
    return 'RECONNECTING';
  }

  return input.status as PresentationState;
}

/** One sentence per state. No gateway vocabulary, no identifiers, nothing to leak. */
export function describeState(state: PresentationState): string {
  switch (state) {
    case 'CONNECTED':
      return 'Connected.';
    case 'CONNECTING':
      return 'Starting WhatsApp… this can take up to a minute.';
    case 'RECONNECTING':
      return 'Connection is being restored…';
    case 'QR_REQUIRED':
      return 'Scan the QR code with WhatsApp on your phone.';
    case 'DISCONNECTING':
      return 'Disconnecting…';
    case 'DISCONNECTED':
      return 'Not connected.';
    case 'RECOVERY_FAILED':
      return 'Reconnecting did not work. Try connecting it again.';
    case 'AUTH_FAILURE':
      return 'This WhatsApp account needs to be linked again.';
    case 'SESSION_ERROR':
      return 'WhatsApp connection could not be started.';
    default:
      return 'Connection status is currently unavailable.';
  }
}

/** True when an operator can usefully act — the UI enables Connect/Reconnect on these. */
export function isActionable(state: PresentationState): boolean {
  // RECONNECTING is absent on purpose: an attempt is already booked, and a second one launched by
  // an impatient operator would only lose the account lock and show them a conflict.
  return (
    state === 'DISCONNECTED' ||
    state === 'SESSION_ERROR' ||
    state === 'RECOVERY_FAILED' ||
    state === 'AUTH_FAILURE' ||
    state === 'UNKNOWN'
  );
}

/**
 * Turns any internal failure into something safe to show.
 *
 * The default is deliberately vague. An unrecognised error is exactly the case where the underlying
 * message is most likely to contain a URL, a port, a stack frame or a gateway internal — so it is
 * the case where passing it through would do the most harm.
 */
export function toUserFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes('did not respond within')) {
    return 'Starting WhatsApp is taking longer than usual. It may still be connecting — check again in a moment.';
  }
  if (message.includes('unreachable') || message.includes('econnrefused') || message.includes('fetch failed')) {
    return 'WhatsApp service is temporarily unavailable. Please try again shortly.';
  }
  if (message.includes('not configured')) {
    return 'WhatsApp service is not configured on this server. Contact your system administrator.';
  }
  if (message.includes('auto-reply') || message.includes('autoreply')) {
    return (
      'This WhatsApp session has its own auto-reply rules enabled. Disable them before connecting, ' +
      'or customers will receive duplicate replies.'
    );
  }
  if (message.includes('not owned') || message.includes('ownership')) {
    return 'Support CRM is not managing this account. Enable it in the account settings first.';
  }
  if (message.includes('already running') || message.includes('already started')) {
    return 'Another operation is already running for this account. Try again in a moment.';
  }
  if (AUTH_FAILURE_HINTS.some((hint) => message.includes(hint))) {
    return 'This WhatsApp account needs to be linked again.';
  }

  return 'WhatsApp connection could not be started. Please try again, or contact your administrator.';
}
