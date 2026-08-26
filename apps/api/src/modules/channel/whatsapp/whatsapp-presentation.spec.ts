import { ChannelConnectionState } from '../channel-connection';
import {
  describeState,
  isActionable,
  toPresentationState,
  toUserFacingError,
} from './whatsapp-presentation';

const input = (
  status: ChannelConnectionState,
  lastError: string | null = null,
  lastConnectedAt: Date | null = null,
) => ({ status, lastError, lastConnectedAt });

describe('toPresentationState', () => {
  it('passes the ordinary states through unchanged', () => {
    for (const state of [
      ChannelConnectionState.DISCONNECTED,
      ChannelConnectionState.QR_REQUIRED,
      ChannelConnectionState.CONNECTED,
      ChannelConnectionState.DISCONNECTING,
      ChannelConnectionState.UNKNOWN,
    ]) {
      expect(toPresentationState(input(state))).toBe(state);
    }
  });

  it('distinguishes a revoked pairing from an ordinary error', () => {
    // The one failure a retry cannot fix — it needs a human to scan a new QR.
    for (const reason of ['Session logged out', 'device was UNLINKED', 'unauthorized', 'auth failed']) {
      expect(toPresentationState(input(ChannelConnectionState.ERROR, reason))).toBe('AUTH_FAILURE');
    }
  });

  it('treats an unrecognised error as a session error, not an auth failure', () => {
    expect(toPresentationState(input(ChannelConnectionState.ERROR, 'engine crashed'))).toBe('SESSION_ERROR');
    expect(toPresentationState(input(ChannelConnectionState.ERROR, null))).toBe('SESSION_ERROR');
  });

  it('calls a first connection CONNECTING and a later one RECONNECTING', () => {
    expect(toPresentationState(input(ChannelConnectionState.CONNECTING))).toBe('CONNECTING');
    expect(toPresentationState(input(ChannelConnectionState.CONNECTING, null, new Date()))).toBe(
      'RECONNECTING',
    );
  });
});

describe('describeState', () => {
  it('gives every state a human sentence', () => {
    for (const state of [
      'DISCONNECTED',
      'CONNECTING',
      'QR_REQUIRED',
      'CONNECTED',
      'DISCONNECTING',
      'RECONNECTING',
      'AUTH_FAILURE',
      'SESSION_ERROR',
      'UNKNOWN',
    ] as const) {
      const text = describeState(state);
      expect(text.length).toBeGreaterThan(0);
      // No state name, no snake case, no gateway vocabulary in what the operator reads.
      expect(text).not.toMatch(/_/);
      expect(text.toLowerCase()).not.toContain('openwa');
      expect(text.toLowerCase()).not.toContain('session id');
    }
  });

  it('tells the operator to re-link on an auth failure', () => {
    expect(describeState('AUTH_FAILURE')).toMatch(/linked again/i);
  });
});

describe('isActionable', () => {
  it('offers an action only where one would help', () => {
    expect(isActionable('DISCONNECTED')).toBe(true);
    expect(isActionable('AUTH_FAILURE')).toBe(true);
    expect(isActionable('SESSION_ERROR')).toBe(true);
    expect(isActionable('UNKNOWN')).toBe(true);
    // Mid-flight states must not offer a button that would fight the operation in progress.
    expect(isActionable('CONNECTING')).toBe(false);
    expect(isActionable('QR_REQUIRED')).toBe(false);
    expect(isActionable('CONNECTED')).toBe(false);
    expect(isActionable('RECONNECTING')).toBe(false);
  });
});

describe('toUserFacingError', () => {
  it('maps a timeout to a message that says it may still be working', () => {
    const text = toUserFacingError(new Error('The WhatsApp gateway did not respond within 120000ms on POST /api/sessions/x/start'));
    expect(text).toMatch(/taking longer than usual/i);
    // The route, the timeout and the word "gateway" must not survive.
    expect(text).not.toMatch(/api\/sessions/);
    expect(text).not.toMatch(/120000/);
  });

  it('maps an unreachable gateway to a retry message', () => {
    expect(toUserFacingError(new Error('The WhatsApp gateway is unreachable (ECONNREFUSED 172.19.0.2:2785)'))).toMatch(
      /temporarily unavailable/i,
    );
  });

  it('never leaks a host, port, URL or stack frame', () => {
    const hostile = new Error(
      'OpenWaError: OpenWA 500 on /api/sessions/4830436e-90bb/start\n' +
        '    at OpenWaClient.request (/app/dist/modules/channel/whatsapp/openwa.client.js:135:13)\n' +
        'http://openwa-validation:2785 X-API-Key: owa_k1_secret',
    );
    const text = toUserFacingError(hostile);

    for (const forbidden of ['openwa', '2785', 'http://', '/app/dist', 'X-API-Key', 'owa_k1', '4830436e']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('explains the gateway-automation refusal in the operator’s terms', () => {
    const text = toUserFacingError(new Error('2 gateway autoreply rule(s) are enabled on this session'));
    expect(text).toMatch(/auto-reply/i);
    expect(text).toMatch(/duplicate replies/i);
  });

  it('falls back to a vague message for anything unrecognised', () => {
    // The unrecognised case is exactly where the underlying text is most likely to contain an
    // internal detail, so it is the case where passing it through would do the most harm.
    const text = toUserFacingError(new Error('ENOSPC: no space left on device, write /var/lib/docker/overlay2'));
    expect(text).toMatch(/could not be started/i);
    expect(text).not.toMatch(/ENOSPC|docker|overlay2/);
  });

  it('handles a non-Error value without throwing', () => {
    expect(() => toUserFacingError('some string')).not.toThrow();
    expect(() => toUserFacingError(undefined)).not.toThrow();
  });
});
