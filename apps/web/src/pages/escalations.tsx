import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { escalationConfig, escalations, type Escalation } from '../api/client';
import { useAuth } from '../auth-context';
import { IconAlertCircle, IconInbox } from '../components/icons';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
  errorMessage,
  humanise,
  useToast,
} from '../components/ui';

/**
 * Conversations waiting for a person (`PROJECT_SPEC.md` §28–§36).
 *
 * An escalation exists because the system decided **not** to answer — no rule matched and the AI
 * either had no grounds, asked for a human, or was not confident enough. Nothing was sent to the
 * customer in the meantime, so this queue is their only route to an answer and the age of a row
 * matters. That is why it is ordered by urgency and why the wait time is on every card.
 *
 * Resolving asks one extra question on purpose: hand the conversation back to automation, or leave
 * it with the person. An agent who has just calmed an angry customer usually does not want the
 * machine replying next.
 */
export function EscalationsPage() {
  const { can, user } = useAuth();
  const toast = useToast();

  const [items, setItems] = useState<Escalation[] | null>(null);
  const [status, setStatus] = useState('OPEN');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [release, setRelease] = useState<Record<string, boolean>>({});
  const [events, setEvents] = useState<Record<string, Array<{ id: string; kind: string; status: string; detail: string | null }>>>({});

  const canManage = can('conversations.manage');

  const load = useCallback(async () => {
    try {
      const result = await escalations.list(status || undefined);
      setItems(result.items);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'The escalation queue could not be loaded.'));
      setItems([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function showNotifications(escalation: Escalation) {
    if (events[escalation.id]) return;
    try {
      const result = await escalationConfig.events(escalation.id);
      setEvents((current) => ({ ...current, [escalation.id]: result.items }));
    } catch {
      setEvents((current) => ({ ...current, [escalation.id]: [] }));
    }
  }

  async function claim(escalation: Escalation) {
    if (!user) return;
    setBusy(escalation.id);
    try {
      await escalations.assign(escalation.id, { userId: user.id });
      toast.success('Taken. Automation stays silent in this conversation until you hand it back.');
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That escalation could not be claimed.'));
    } finally {
      setBusy(null);
    }
  }

  async function resolve(escalation: Escalation, dismiss: boolean) {
    setBusy(escalation.id);
    try {
      await escalations.resolve(escalation.id, {
        note: note[escalation.id] || undefined,
        releaseToAutomation: release[escalation.id] ?? false,
        dismiss,
      });
      toast.success(
        release[escalation.id]
          ? 'Closed, and handed back to automation.'
          : 'Closed. This conversation stays with a person.',
      );
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That escalation could not be closed.'));
    } finally {
      setBusy(null);
    }
  }

  const priorityTone = (priority: string | undefined) =>
    priority === 'URGENT' ? 'bad' : priority === 'HIGH' ? 'warn' : 'neutral';

  return (
    <>
      <PageHeader
        title="Waiting for a human"
        description="Each of these is a customer who has had no automatic answer, on purpose. Claiming one takes the conversation over; automation stays silent until it is handed back."
        actions={
          can('conversations.read') ? (
            <Link to="/escalations/config" className="small">
              Escalation settings →
            </Link>
          ) : null
        }
      />

      {error && <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />}

      <div className="toolbar">
        <Field label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="OPEN">Open</option>
            <option value="ASSIGNED">Assigned</option>
            <option value="RESOLVED">Resolved</option>
            <option value="DISMISSED">Dismissed</option>
            <option value="">All</option>
          </select>
        </Field>
      </div>

      {items === null ? (
        <Loading label="Loading the queue…" />
      ) : items.length === 0 ? (
        <Empty
          title={status === 'OPEN' ? 'Nothing is waiting' : 'Nothing here'}
          hint={
            status === 'OPEN'
              ? 'Every conversation is either being handled automatically or has been dealt with.'
              : 'Try a different status.'
          }
          icon={<IconInbox size={20} />}
        />
      ) : (
        <div className="stack">
          {items.map((escalation) => {
            const priority = (escalation as Escalation & { priority?: string }).priority;
            const notifications = events[escalation.id];

            return (
              <div key={escalation.id} className="card card-pad stack">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="row">
                    <strong>{humanise(escalation.reason)}</strong>
                    {priority && <Badge tone={priorityTone(priority)}>{humanise(priority)}</Badge>}
                  </div>
                  <div className="row">
                    <Badge
                      tone={
                        escalation.status === 'OPEN' ? 'warn' : escalation.status === 'ASSIGNED' ? 'busy' : 'ok'
                      }
                    >
                      {humanise(escalation.status)}
                    </Badge>
                    <span className="muted small">
                      raised <RelativeTime value={escalation.createdAt} />
                    </span>
                  </div>
                </div>

                {escalation.detail && <div className="small">{escalation.detail}</div>}

                <div className="row">
                  <button type="button" className="link" style={{ padding: 0 }} onClick={() => void showNotifications(escalation)}>
                    Who was told?
                  </button>
                </div>

                {notifications && (
                  <div className="chip-row">
                    {notifications.length === 0 ? (
                      <span className="muted small">No notification was recorded.</span>
                    ) : (
                      notifications.map((event) => (
                        <Badge
                          key={event.id}
                          tone={event.status === 'SENT' ? 'ok' : event.status === 'FAILED' ? 'bad' : 'neutral'}
                          title={event.detail ?? undefined}
                        >
                          {humanise(event.kind)}: {humanise(event.status)}
                        </Badge>
                      ))
                    )}
                  </div>
                )}

                {canManage && escalation.status !== 'RESOLVED' && escalation.status !== 'DISMISSED' && (
                  <>
                    <div className="row">
                      {escalation.assignedToUserId === null && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy === escalation.id}
                          onClick={() => void claim(escalation)}
                        >
                          Take it
                        </button>
                      )}
                      <input
                        placeholder="What happened? (optional)"
                        value={note[escalation.id] ?? ''}
                        onChange={(event) => setNote({ ...note, [escalation.id]: event.target.value })}
                      />
                    </div>
                    <div className="row">
                      <label className="small" style={{ marginBottom: 0 }}>
                        <input
                          type="checkbox"
                          checked={release[escalation.id] ?? false}
                          onChange={(event) => setRelease({ ...release, [escalation.id]: event.target.checked })}
                        />{' '}
                        hand back to automation
                      </label>
                      <button type="button" disabled={busy === escalation.id} onClick={() => void resolve(escalation, false)}>
                        Resolve
                      </button>
                      <button type="button" disabled={busy === escalation.id} onClick={() => void resolve(escalation, true)}>
                        Dismiss
                      </button>
                    </div>
                    <div className="muted small">
                      Leave the box unticked and this conversation stays with a person — automation
                      will not answer in it again until somebody releases it.
                    </div>
                  </>
                )}

                {escalation.resolutionNote && (
                  <div className="muted small">Closed: {escalation.resolutionNote}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {items !== null && items.length > 0 && status === 'OPEN' && (
        <Card>
          <p className="muted small">
            Ordered newest first. An escalation nobody claims stays here — there is no timer that
            quietly closes one, because a customer who gave up is not a customer who was helped.
          </p>
        </Card>
      )}
    </>
  );
}
