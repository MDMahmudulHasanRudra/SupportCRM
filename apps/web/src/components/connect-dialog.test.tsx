import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppAccount } from '../api/client';
import { ConnectDialog } from './connect-dialog';

/**
 * A session-lifecycle call is not idempotent from the operator's side: it takes the account lock,
 * and a second one loses that race and comes back 409. So the dialog has to issue exactly one,
 * however many times React chooses to run its effects.
 */

const reconnect = vi.fn();
const connect = vi.fn();
const qr = vi.fn();

// Partial mock: only the endpoints this file drives are replaced. The rest of the module has to
// come through for real — `auth-context` narrows failures with `error instanceof ApiError`, and a
// mock without that class turns a background `me()` call into an unhandled rejection that vitest
// reports on whichever test happened to be running.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  get whatsapp() {
    return {
      reconnect: (...args: unknown[]) => reconnect(...args),
      connect: (...args: unknown[]) => connect(...args),
      qr: (...args: unknown[]) => qr(...args),
    };
  },
}));

vi.mock('../api/realtime', () => ({
  onPairingCode: () => () => undefined,
  onChannelStatus: () => () => undefined,
}));

const account = (state: WhatsAppAccount['state']): WhatsAppAccount => ({
  id: 'acct-1',
  name: 'Final validation',
  sessionName: 'final-validation',
  phoneNumber: null,
  displayName: null,
  state,
  statusText: '',
  canConnect: true,
  isPrimary: false,
  ownershipEnabled: true,
  connected: false,
  lastConnectedAt: null,
  lastHeartbeatAt: null,
  lastActivityAt: null,
  groupCount: 0,
});

describe('ConnectDialog auto-start', () => {
  beforeEach(() => {
    reconnect.mockReset().mockResolvedValue({});
    connect.mockReset().mockResolvedValue({ id: 'acct-1' });
    qr.mockReset().mockResolvedValue({ qr: null, format: 'text', expiresAt: null, state: 'CONNECTING' });
  });

  afterEach(() => vi.clearAllMocks());

  it('reconnects exactly once, even when React runs the mount effect twice', async () => {
    // StrictMode double-invokes mount effects. Before this was guarded, the second call lost the
    // account lock and the operator saw "another operation is already running" after one click.
    // Regression: real-WhatsApp validation.
    render(
      <StrictMode>
        <ConnectDialog account={account('DISCONNECTED')} onClose={() => undefined} onChanged={() => undefined} />
      </StrictMode>,
    );

    await waitFor(() => expect(reconnect).toHaveBeenCalled());
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith('acct-1');
  });

  it('does not restart a session that is already showing a code', async () => {
    // The code on screen is live. Restarting would throw it away and make the operator wait again.
    render(
      <StrictMode>
        <ConnectDialog account={account('QR_REQUIRED')} onClose={() => undefined} onChanged={() => undefined} />
      </StrictMode>,
    );

    await waitFor(() => expect(qr).toHaveBeenCalled());
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('creates nothing until the operator submits the form', async () => {
    render(
      <StrictMode>
        <ConnectDialog account={null} onClose={() => undefined} onChanged={() => undefined} />
      </StrictMode>,
    );

    expect(await screen.findByLabelText('Account name')).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });
});
