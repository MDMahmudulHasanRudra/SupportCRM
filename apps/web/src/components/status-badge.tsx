import type { ConnectionState } from '../api/client';

/**
 * The connection state, as a glance.
 *
 * The label comes from the API (`statusText`), not from a table in the client — one place decides
 * what an operator is told about a connection, and it is the same place for the REST response, the
 * table and the dialog.
 */
export function StatusBadge({ state, label }: { state: ConnectionState; label: string }) {
  return (
    <span className="badge" title={label}>
      <span className={`dot ${toneFor(state)}`} aria-hidden="true" />
      {shortLabel(state)}
    </span>
  );
}

function toneFor(state: ConnectionState): string {
  switch (state) {
    case 'CONNECTED':
      return 'ok';
    case 'CONNECTING':
    case 'RECONNECTING':
    case 'DISCONNECTING':
      return 'busy';
    case 'QR_REQUIRED':
      return 'warn';
    case 'AUTH_FAILURE':
    case 'SESSION_ERROR':
    case 'RECOVERY_FAILED':
      return 'bad';
    default:
      return '';
  }
}

/** A badge needs two words; the sentence lives in the tooltip and in the row beneath it. */
function shortLabel(state: ConnectionState): string {
  switch (state) {
    case 'CONNECTED':
      return 'Connected';
    case 'CONNECTING':
      return 'Connecting';
    case 'RECONNECTING':
      return 'Reconnecting';
    case 'RECOVERY_FAILED':
      return 'Reconnect failed';
    case 'DISCONNECTING':
      return 'Disconnecting';
    case 'QR_REQUIRED':
      return 'Scan needed';
    case 'AUTH_FAILURE':
      return 'Re-link needed';
    case 'SESSION_ERROR':
      return 'Error';
    case 'DISCONNECTED':
      return 'Not connected';
    default:
      return 'Unknown';
  }
}

/** Dates an operator reads, not ISO strings. */
export function RelativeTime({ value }: { value: string | null }) {
  if (!value) return <span className="muted">—</span>;

  const then = new Date(value).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);

  let text: string;
  if (seconds < 60) text = 'just now';
  else if (seconds < 3600) text = `${Math.floor(seconds / 60)}m ago`;
  else if (seconds < 86_400) text = `${Math.floor(seconds / 3600)}h ago`;
  else if (seconds < 604_800) text = `${Math.floor(seconds / 86_400)}d ago`;
  else text = new Date(value).toLocaleDateString();

  return <time dateTime={value} title={new Date(value).toLocaleString()}>{text}</time>;
}
