import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { whatsapp, type WhatsAppAccount } from '../api/client';
import { onChannelStatus } from '../api/realtime';
import { useAuth } from '../auth-context';
import { ConnectPanel } from '../components/connect-panel';
import { IconAlertCircle, IconMessageCircle, IconPlug, IconRefresh } from '../components/icons';
import { RelativeTime, StatusBadge } from '../components/status-badge';
import { Card, Empty, ErrorState, Loading, PageHeader } from '../components/ui';

/**
 * WhatsApp Accounts.
 *
 * Everything an operator needs to run their WhatsApp connections, and nothing about how they are
 * run: no gateway URL, no session UUID, no API key, no port. Connection status arrives over the
 * realtime socket, so the page stays current without a refresh button being the plan.
 *
 * The pairing code lives on the page rather than behind a modal — linking a number is what this
 * screen is for, so the accounts and the code you scan to add one sit side by side.
 */
export function WhatsAppAccountsPage() {
  const { can } = useAuth();
  const [accounts, setAccounts] = useState<WhatsAppAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * What the pairing panel is currently working on. `null` is the idle form (create a new account);
   * an account re-links that one. `key` forces a fresh panel per target — the pairing hook starts a
   * session on mount, so a new target needs a new instance.
   */
  const [target, setTarget] = useState<{ account: WhatsAppAccount | null; key: number }>({
    account: null,
    key: 0,
  });

  const manage = can('channels.manage');

  const load = useCallback(async () => {
    try {
      const { items } = await whatsapp.overview();
      setAccounts(items);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load WhatsApp accounts.');
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The push carries identifiers and a state, never the derived presentation state or an error
  // detail — so a change refetches the rows rather than patching them from a partial payload.
  useEffect(() => onChannelStatus(() => void load()), [load]);

  async function act(account: WhatsAppAccount, action: 'reconnect' | 'disconnect') {
    setBusyId(account.id);
    setError(null);

    try {
      await (action === 'reconnect' ? whatsapp.reconnect(account.id) : whatsapp.disconnect(account.id));
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  const beginPairing = (account: WhatsAppAccount | null) =>
    setTarget((current) => ({ account, key: current.key + 1 }));

  return (
    <>
      <PageHeader
        title="WhatsApp accounts"
        description="The WhatsApp numbers Support CRM handles messages for."
        actions={
          manage &&
          target.account !== null && (
            <button type="button" onClick={() => beginPairing(null)}>
              Connect another number
            </button>
          )
        }
      />

      {error && <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />}

      <div className="wa-grid">
        {/* --- the accounts themselves ------------------------------------------------------- */}
        <Card title="Your accounts">
          {accounts === null ? (
            <Loading label="Checking connections…" />
          ) : accounts.length === 0 ? (
            <Empty
              title="No WhatsApp account yet"
              hint="Scan the code beside this to link your first number. Nothing else in the console does anything until then."
              icon={<IconPlug size={20} />}
            />
          ) : (
            accounts.map((account) => (
              <div key={account.id} className="stack" style={{ gap: 10 }}>
                <div className="wa-account">
                  <span className={account.connected ? 'wa-avatar' : 'wa-avatar off'}>
                    <IconMessageCircle size={18} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="wa-account-name">
                      {account.phoneNumber ? formatPhone(account.phoneNumber) : account.name}
                    </div>
                    <div className="wa-account-sub">
                      {account.displayName ?? account.sessionName}
                      {account.isPrimary && ' · primary'}
                    </div>
                  </div>
                  <StatusBadge state={account.state} label={account.statusText} />
                </div>

                {/* Only figures the overview actually returns. There is no contact count or
                    active-chat count on this payload, and inventing one would be a lie on the
                    screen an operator trusts most. */}
                <div className="wa-stats">
                  <div className="wa-stat">
                    <div className="wa-stat-value">{account.groupCount}</div>
                    <div className="wa-stat-label">Groups</div>
                  </div>
                  <div className="wa-stat">
                    <div className="wa-stat-value" style={{ fontSize: 13 }}>
                      <RelativeTime value={account.lastConnectedAt} />
                    </div>
                    <div className="wa-stat-label">Last connected</div>
                  </div>
                  <div className="wa-stat">
                    <div className="wa-stat-value" style={{ fontSize: 13 }}>
                      <RelativeTime value={account.lastActivityAt} />
                    </div>
                    <div className="wa-stat-label">Last activity</div>
                  </div>
                </div>

                <div className="muted small">{account.statusText}</div>

                <div className="row">
                  <Link to={`/channels/whatsapp/${account.id}`} className="small">
                    Health &amp; activity →
                  </Link>
                  <Link to={`/channels/whatsapp/${account.id}/groups`} className="small">
                    Groups →
                  </Link>
                  {manage && (
                    <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
                      {account.canConnect ? (
                        <button
                          type="button"
                          className="primary"
                          disabled={busyId === account.id}
                          onClick={() => beginPairing(account)}
                        >
                          <IconPlug size={15} />
                          {account.state === 'AUTH_FAILURE' ? 'Link again' : 'Connect'}
                        </button>
                      ) : account.connected ? (
                        <>
                          <button
                            type="button"
                            disabled={busyId === account.id}
                            onClick={() => void act(account, 'reconnect')}
                          >
                            <IconRefresh size={15} /> Reconnect
                          </button>
                          <button
                            type="button"
                            disabled={busyId === account.id}
                            onClick={() => void act(account, 'disconnect')}
                          >
                            Disconnect
                          </button>
                        </>
                      ) : account.state === 'QR_REQUIRED' ? (
                        <button type="button" className="primary" onClick={() => beginPairing(account)}>
                          Show QR code
                        </button>
                      ) : (
                        <span className="muted small">Working…</span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </Card>

        {/* --- pairing ------------------------------------------------------------------------ */}
        {manage ? (
          <ConnectPanel
            key={target.key}
            account={target.account}
            onChanged={load}
            onDone={() => beginPairing(null)}
          />
        ) : (
          <div className="card card-pad">
            <Empty title="Connecting needs permission" hint="Ask an administrator to link a WhatsApp number." />
          </div>
        )}
      </div>
    </>
  );
}

/** WhatsApp reports a bare international number; a space or two makes it readable. */
function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10) return `+${digits}`;
  return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -7)} ${digits.slice(-7, -4)} ${digits.slice(-4)}`;
}
