import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  groups as groupsApi,
  whatsapp,
  type ConnectionEvent,
  type WhatsAppAccount,
  type WhatsAppAccountHealth,
  type WhatsAppGroup,
} from '../api/client';
import { onChannelStatus } from '../api/realtime';
import { useAuth } from '../auth-context';
import { IconAlertCircle, IconInbox, IconPlug, IconRefresh } from '../components/icons';
import { RelativeTime } from '../components/status-badge';
import {
  Badge,
  Card,
  ConfirmDialog,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  errorMessage,
  humanise,
  useToast,
  type Tone,
} from '../components/ui';

/**
 * One WhatsApp account: its health, its lifecycle, and what it has been doing.
 *
 * Everything here is read from the API — our stored state, the gateway's live state, the automation
 * safety check, and the account's own connection history. Nothing is inferred in the browser, and
 * an unreachable gateway is reported as unreachable rather than guessed at.
 */
export function WhatsAppAccountPage() {
  const { accountId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('channels.manage');

  const [account, setAccount] = useState<WhatsAppAccount | null>(null);
  const [health, setHealth] = useState<WhatsAppAccountHealth | null>(null);
  const [events, setEvents] = useState<ConnectionEvent[] | null>(null);
  const [groupRows, setGroupRows] = useState<WhatsAppGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'disconnect' | 'handback' | null>(null);

  const load = useCallback(async () => {
    try {
      const [overview, healthPayload, eventPage] = await Promise.all([
        whatsapp.overview(),
        whatsapp.health(accountId).catch(() => null),
        whatsapp.connectionEvents(accountId).catch(() => ({ items: [] as ConnectionEvent[], total: 0 })),
      ]);
      setAccount(overview.items.find((item) => item.id === accountId) ?? null);
      setHealth(healthPayload);
      setEvents(eventPage.items);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'This account could not be loaded.'));
    }
  }, [accountId]);

  const loadGroups = useCallback(async () => {
    const page = await groupsApi.list(accountId).catch(() => null);
    setGroupRows(page?.items ?? []);
  }, [accountId]);

  useEffect(() => {
    void load();
    void loadGroups();
  }, [load, loadGroups]);

  useEffect(() => onChannelStatus(() => void load()), [load]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      toast.success(label);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That did not work.'));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />;
  if (!account) return <Loading label="Loading account…" />;

  const monitored = groupRows?.filter((group) => group.monitoringState === 'MONITORED').length ?? 0;

  return (
    <>
      <PageHeader
        title={account.phoneNumber ? formatPhone(account.phoneNumber) : account.name}
        description={`${account.displayName ?? account.sessionName} · ${account.statusText}`}
        actions={
          <>
            <Link to="/channels/whatsapp" className="small">
              ← All accounts
            </Link>
            <button type="button" onClick={() => void load()} disabled={busy}>
              <IconRefresh size={15} /> Refresh
            </button>
          </>
        }
      />

      <div className="split">
        {/* --- health ------------------------------------------------------------------------- */}
        <Card title="Health">
          {!health ? (
            <Loading label="Checking…" />
          ) : (
            <div className="rowlist">
              <HealthRow
                label="Gateway"
                tone={health.gateway.reachable ? 'ok' : 'bad'}
                value={health.gateway.reachable ? 'Reachable' : 'Unreachable'}
                sub={
                  health.gateway.reachable
                    ? `Reports ${humanise(health.gateway.state)}`
                    : 'Support CRM cannot reach the WhatsApp gateway.'
                }
              />
              <HealthRow
                label="Session"
                tone={account.connected ? 'ok' : account.canConnect ? 'warn' : 'neutral'}
                value={humanise(account.state)}
                sub={account.statusText}
              />
              <HealthRow
                label="Webhook"
                tone={health.webhookRegistered ? 'ok' : 'warn'}
                value={health.webhookRegistered ? 'Registered' : 'Not registered'}
                sub={
                  health.webhookRegistered
                    ? 'Inbound messages are delivered to Support CRM.'
                    : 'Inbound messages will not reach Support CRM until the session connects.'
                }
              />
              <HealthRow
                label="Ownership"
                tone={health.ownershipEnabled ? 'ok' : 'warn'}
                value={health.ownershipEnabled ? 'Support CRM is handling this' : 'Handed back'}
                sub={
                  health.ownershipEnabled
                    ? 'Sending, syncing and inbound processing are active.'
                    : 'Everything is preserved, but nothing is sent, synced or processed.'
                }
              />
              {/* The gateway's own automation is a safety question, not a status: two systems
                  replying on one number is exactly the failure this check exists to prevent. */}
              <HealthRow
                label="Gateway automation"
                tone={health.gatewayAutomation.safe ? 'ok' : 'bad'}
                value={health.gatewayAutomation.safe ? 'Safe' : `${health.gatewayAutomation.activeRuleCount} active`}
                sub={
                  health.gatewayAutomation.detail ??
                  (health.gatewayAutomation.safe
                    ? 'Nothing else is replying on this number.'
                    : 'Another system is also replying on this number.')
                }
              />
              <HealthRow
                label="Last heartbeat"
                tone="neutral"
                value={<RelativeTime value={health.lastHeartbeatAt} />}
                sub={health.lastConnectedAt ? undefined : 'This account has never completed a connection.'}
              />
            </div>
          )}
        </Card>

        {/* --- lifecycle ---------------------------------------------------------------------- */}
        <Card title="Session control">
          <div className="stack" style={{ gap: 12 }}>
            <div className="wa-stats">
              <div className="wa-stat">
                <div className="wa-stat-value">{groupRows?.length ?? '—'}</div>
                <div className="wa-stat-label">Groups</div>
              </div>
              <div className="wa-stat">
                <div className="wa-stat-value">{monitored}</div>
                <div className="wa-stat-label">Monitored</div>
              </div>
              <div className="wa-stat">
                <div className="wa-stat-value" style={{ fontSize: 13 }}>
                  <RelativeTime value={account.lastActivityAt} />
                </div>
                <div className="wa-stat-label">Last activity</div>
              </div>
            </div>

            {!manage ? (
              <div className="muted small">You do not have permission to change this session.</div>
            ) : (
              <div className="row">
                {/* The code itself lives on the accounts page, so this hands the operator straight
                    to it rather than leaving a session that is waiting to be scanned with no way
                    to reach the thing it is waiting for. */}
                {(account.canConnect || account.state === 'QR_REQUIRED') && (
                  <Link to="/channels/whatsapp" className="button-link">
                    <IconPlug size={15} />
                    {account.state === 'QR_REQUIRED' ? 'Show QR code' : 'Connect'}
                  </Link>
                )}
                <button
                  type="button"
                  disabled={busy || !account.connected}
                  onClick={() => void run('Reconnecting.', () => whatsapp.reconnect(account.id))}
                >
                  <IconRefresh size={15} /> Reconnect
                </button>
                <button type="button" disabled={busy || !account.connected} onClick={() => setConfirming('disconnect')}>
                  Disconnect
                </button>
                <button
                  type="button"
                  className={health?.ownershipEnabled ? '' : 'primary'}
                  disabled={busy}
                  onClick={() =>
                    health?.ownershipEnabled
                      ? setConfirming('handback')
                      : void run('Support CRM is handling this account again.', () =>
                          whatsapp.setOwnership(account.id, true),
                        )
                  }
                >
                  {health?.ownershipEnabled ? 'Hand back' : 'Take over'}
                </button>
              </div>
            )}

            <p className="hint" style={{ marginTop: 0 }}>
              Reconnect restarts the session without re-pairing — you will not rescan. Disconnect stops the session
              but keeps the device link, so it can be started again.
            </p>

            <Link to={`/channels/whatsapp/${account.id}/groups`} className="small">
              Manage groups →
            </Link>
          </div>
        </Card>
      </div>

      {/* --- activity ------------------------------------------------------------------------- */}
      <div style={{ marginTop: 14 }}>
        <Card title="Connection activity" actions={<span className="muted small">Newest first</span>}>
          {!events ? (
            <Loading label="Loading…" />
          ) : events.length === 0 ? (
            <Empty
              title="Nothing recorded yet"
              hint="Connection changes for this account appear here."
              icon={<IconInbox size={20} />}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Change</th>
                    <th>Source</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(0, 40).map((event) => (
                    <tr key={event.id}>
                      <td className="small muted">
                        <RelativeTime value={event.createdAt} />
                      </td>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          {event.previousState && (
                            <span className="muted small">{humanise(event.previousState)} →</span>
                          )}
                          <Badge tone={stateTone(event.state)}>{humanise(event.state)}</Badge>
                        </span>
                      </td>
                      <td className="small muted">{humanise(event.source)}</td>
                      <td className="small muted">{event.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {confirming === 'disconnect' && (
        <ConfirmDialog
          title="Disconnect WhatsApp?"
          body={
            <>
              <p>
                This stops message processing for <strong>{account.phoneNumber ?? account.name}</strong>.
              </p>
              <p className="muted small">
                Existing conversations and history stay exactly as they are. The device link is kept, so you can start
                the session again without rescanning.
              </p>
            </>
          }
          confirmLabel="Disconnect"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void run('Disconnected.', () => whatsapp.disconnect(account.id))}
        />
      )}

      {confirming === 'handback' && (
        <ConfirmDialog
          title="Hand this account back?"
          body={
            <>
              <p>
                Support CRM will stop sending, syncing and processing inbound messages for{' '}
                <strong>{account.phoneNumber ?? account.name}</strong>.
              </p>
              <p className="muted small">
                Nothing is deleted — every conversation, message and group row is kept. You can take the account over
                again at any time.
              </p>
            </>
          }
          confirmLabel="Hand back"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void run('Account handed back.', () => whatsapp.setOwnership(account.id, false))}
        />
      )}
    </>
  );
}

function HealthRow({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone: Tone;
}) {
  return (
    <div className="rowlist-item">
      <div className="rowlist-body">
        <div className="rowlist-text">{label}</div>
        {sub && <div className="rowlist-sub">{sub}</div>}
      </div>
      <Badge tone={tone}>{value}</Badge>
    </div>
  );
}

function stateTone(state: string): Tone {
  if (state === 'CONNECTED') return 'ok';
  if (state === 'CONNECTING' || state === 'RECONNECTING' || state === 'DISCONNECTING') return 'busy';
  if (state === 'QR_REQUIRED') return 'warn';
  if (state === 'AUTH_FAILURE' || state === 'SESSION_ERROR' || state === 'RECOVERY_FAILED') return 'bad';
  return 'neutral';
}

/** WhatsApp reports a bare international number; a space or two makes it readable. */
function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10) return `+${digits}`;
  return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -7)} ${digits.slice(-7, -4)} ${digits.slice(-4)}`;
}
