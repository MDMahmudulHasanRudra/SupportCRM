/**
 * Normalized connection lifecycle for any channel account.
 *
 * `PROJECT_SPEC.md` §52 and the Phase 2 brief §3. These names are OURS. A gateway's own state
 * vocabulary is mapped into this set at the adapter boundary and never leaks inward — OpenWA today
 * reports `created|initializing|qr_ready|authenticating|ready|disconnected|action_required|failed`,
 * a future Messenger adapter will report something else entirely, and the rest of the application
 * must not have to know either.
 *
 * `UNKNOWN` is a real, useful state, not a placeholder: it means "the gateway answered with
 * something this adapter version does not recognise". Treating an unrecognised state as
 * DISCONNECTED would be a guess, and treating it as CONNECTED would be dangerous — so it gets its
 * own value that the UI can surface and that no code path treats as ready to send.
 */
export enum ChannelConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  /** A QR (or pairing) code is waiting to be scanned. */
  QR_REQUIRED = 'QR_REQUIRED',
  CONNECTED = 'CONNECTED',
  DISCONNECTING = 'DISCONNECTING',
  ERROR = 'ERROR',
  UNKNOWN = 'UNKNOWN',
}

/** The only state in which the outbound layer may attempt a send. */
export function canSendInState(state: ChannelConnectionState): boolean {
  return state === ChannelConnectionState.CONNECTED;
}

/**
 * Why a connection state changed. Recorded on `channel_connection_events` so an operator can tell
 * "the gateway told us" from "an admin clicked disconnect" when reading the history.
 */
export enum ConnectionEventSource {
  /** A `session.*` webhook from the gateway. */
  GATEWAY_EVENT = 'GATEWAY_EVENT',
  /** A poll of the gateway's session API (health sync). */
  GATEWAY_POLL = 'GATEWAY_POLL',
  /** An operator action through the Support CRM API. */
  ADMIN_ACTION = 'ADMIN_ACTION',
  /** Support CRM itself concluded the state, e.g. a request failed. */
  SYSTEM = 'SYSTEM',
}
