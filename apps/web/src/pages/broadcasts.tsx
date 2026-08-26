import { useCallback, useEffect, useState } from 'react';
import {
  broadcastExtras,
  broadcasts,
  groups as groupsApi,
  whatsapp,
  type Broadcast,
  type BroadcastRecipient,
  type WhatsAppAccount,
  type WhatsAppGroup,
} from '../api/client';
import { useAuth } from '../auth-context';
import {
  Badge,
  Card,
  ConfirmDialog,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
  TableWrap,
  errorMessage,
  humanise,
  useToast,
} from '../components/ui';

/**
 * Campaigns (`PROJECT_SPEC.md` §94–§97, §195–§197).
 *
 * Writing the message and deciding to send it are separate permissions and separate clicks, because
 * they are separate decisions: a draft that reaches two thousand customers by accident is not a
 * recoverable mistake.
 *
 * Three things this screen insists on before a send:
 *
 *  * **A preview**, listing who it reaches and naming anyone excluded — twenty missing recipients
 *    should be explained, not silently absorbed.
 *  * **A test send** to one address, so somebody reads it on a real phone first.
 *  * **A typed confirmation**, stating the number out loud.
 *
 * Afterwards, outcomes are per recipient: which twenty of two thousand failed, and why.
 */
export function BroadcastsPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [items, setItems] = useState<Broadcast[] | null>(null);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [groups, setGroups] = useState<WhatsAppGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [accountId, setAccountId] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [groupFilter, setGroupFilter] = useState('');

  const [confirming, setConfirming] = useState<Broadcast | null>(null);
  const [cancelling, setCancelling] = useState<Broadcast | null>(null);
  const [inspecting, setInspecting] = useState<Broadcast | null>(null);
  const [preview, setPreview] = useState<{
    total: number;
    sample: Array<{ externalConversationId: string; displayName: string | null }>;
    exclusions: Array<{ reason: string; count: number }>;
  } | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [testTarget, setTestTarget] = useState('');

  const canCreate = can('broadcast.create');
  const canSend = can('broadcast.send');

  const load = useCallback(async () => {
    try {
      const [list, accountList] = await Promise.all([broadcasts.list(), whatsapp.overview()]);
      setItems(list.items);
      setAccounts(accountList.items);
      if (!accountId && accountList.items[0]) setAccountId(accountList.items[0].id);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'Broadcasts could not be loaded.'));
      setItems([]);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!accountId) return;
    void (async () => {
      try {
        const result = await groupsApi.list(accountId);
        setGroups(result.items.filter((group) => group.isActive));
      } catch {
        setGroups([]);
      }
    })();
  }, [accountId]);

  async function create() {
    setBusy(true);
    try {
      await broadcasts.create({
        name: name.trim(),
        body: body.trim(),
        channelAccountId: accountId,
        target: { groupIds: selected },
      });
      toast.success('Saved as a draft. Nothing has been sent.');
      setName('');
      setBody('');
      setSelected([]);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That broadcast could not be created.'));
    } finally {
      setBusy(false);
    }
  }

  async function openInspector(broadcast: Broadcast) {
    setInspecting(broadcast);
    setPreview(null);
    setRecipients([]);
    setTestTarget('');

    try {
      if (broadcast.status === 'DRAFT') {
        setPreview(await broadcastExtras.preview(broadcast.id));
      } else {
        const result = await broadcastExtras.recipients(broadcast.id);
        setRecipients(result.items);
      }
    } catch (failure) {
      toast.error(errorMessage(failure, 'Those details could not be loaded.'));
    }
  }

  async function sendTest() {
    if (!inspecting || !testTarget.trim()) return;
    setBusy(true);
    try {
      await broadcastExtras.test(inspecting.id, testTarget.trim());
      toast.success('Test sent. Check the phone before sending to everyone.');
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'The test could not be sent.'));
    } finally {
      setBusy(false);
    }
  }

  async function start(broadcast: Broadcast) {
    setBusy(true);
    try {
      await broadcasts.start(broadcast.id);
      toast.success('Sending. Progress appears as each recipient is written to.');
      setConfirming(null);
      setInspecting(null);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That broadcast could not be started.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!cancelling) return;
    setBusy(true);
    try {
      await broadcasts.cancel(cancelling.id);
      toast.info('Cancelled. Messages already handed to WhatsApp cannot be recalled.');
      setCancelling(null);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That broadcast could not be cancelled.'));
    } finally {
      setBusy(false);
    }
  }

  const visibleGroups = groups.filter((group) =>
    groupFilter ? (group.name ?? '').toLowerCase().includes(groupFilter.toLowerCase()) : true,
  );

  return (
    <>
      <PageHeader
        title="Broadcasts"
        description="One message to many recipients. Replies come back through the normal inbox and are decided on like any other message."
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {canCreate && (
        <Card title="New broadcast">
          <div className="form-grid">
            <Field label="Name" hint="For your reference. Customers never see it.">
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Account">
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Message">
            <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} />
          </Field>

          <div className="stack">
            <div className="row">
              <strong>Recipients</strong>
              {selected.length > 0 && <Badge tone="ok">{selected.length} selected</Badge>}
              <div className="spacer" />
              <input
                placeholder="Filter groups…"
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
                style={{ maxWidth: 220 }}
              />
            </div>

            {groups.length === 0 ? (
              <p className="muted small">No active groups on this account.</p>
            ) : visibleGroups.length === 0 ? (
              <p className="muted small">No group matches that filter.</p>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                <table>
                  <tbody>
                    {visibleGroups.map((group) => (
                      <tr key={group.id}>
                        <td>
                          <label className="small" style={{ marginBottom: 0 }}>
                            <input
                              type="checkbox"
                              checked={selected.includes(group.id)}
                              onChange={(event) =>
                                setSelected(
                                  event.target.checked
                                    ? [...selected, group.id]
                                    : selected.filter((id) => id !== group.id),
                                )
                              }
                            />{' '}
                            {group.name ?? group.id}
                          </label>
                        </td>
                        <td className="muted small" style={{ textAlign: 'right' }}>
                          {group.participantCount ?? '—'} members
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !name.trim() || !body.trim() || selected.length === 0}
              onClick={() => void create()}
            >
              Save as draft
            </button>
            <span className="muted small">Saving does not send. Starting is a separate action.</span>
          </div>
        </Card>
      )}

      {items === null ? (
        <Loading label="Loading campaigns…" />
      ) : items.length === 0 ? (
        <Empty title="No broadcasts yet" hint="A saved draft appears here, with a preview and a test send before anything goes out." />
      ) : (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Sent</th>
                <th>Failed</th>
                <th>Started</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((broadcast) => (
                <tr key={broadcast.id}>
                  <td>
                    {broadcast.name}
                    <div className="muted small">{recipientSummary(broadcast)}</div>
                  </td>
                  <td>
                    <Badge
                      tone={
                        broadcast.status === 'COMPLETED'
                          ? 'ok'
                          : broadcast.status === 'FAILED'
                            ? 'bad'
                            : broadcast.status === 'RUNNING'
                              ? 'busy'
                              : 'neutral'
                      }
                    >
                      {humanise(broadcast.status)}
                    </Badge>
                  </td>
                  <td>{broadcast.successCount}</td>
                  <td>{broadcast.failureCount > 0 ? <span className="stat-bad">{broadcast.failureCount}</span> : 0}</td>
                  <td className="small">
                    <RelativeTime value={broadcast.startedAt} />
                  </td>
                  <td>
                    <div className="row">
                      <button type="button" onClick={() => void openInspector(broadcast)}>
                        {broadcast.status === 'DRAFT' ? 'Review' : 'Details'}
                      </button>
                      {canSend && (broadcast.status === 'RUNNING' || broadcast.status === 'SCHEDULED') && (
                        <button type="button" onClick={() => setCancelling(broadcast)}>
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {inspecting && (
        <div className="backdrop" role="dialog" aria-modal="true" aria-label="Broadcast details">
          <div className="dialog" style={{ width: 'min(680px, 100%)' }}>
            <div className="dialog-head">
              <h2>{inspecting.name}</h2>
            </div>
            <div className="dialog-body stack">
              <Card title="The message">{inspecting.body}</Card>

              {inspecting.status === 'DRAFT' ? (
                <>
                  <Card title="Who this reaches">
                    {!preview ? (
                      <Loading label="Working out the audience…" />
                    ) : preview.total === 0 ? (
                      <Empty title="Nobody" hint="Every selected group is inactive or unreachable on this account." />
                    ) : (
                      <div className="stack">
                        <strong>
                          {preview.total} recipient{preview.total === 1 ? '' : 's'}
                        </strong>
                        <ul className="steps">
                          {preview.sample.map((entry) => (
                            <li key={entry.externalConversationId}>
                              {entry.displayName ?? entry.externalConversationId}
                            </li>
                          ))}
                        </ul>
                        {preview.total > preview.sample.length && (
                          <span className="muted small">…and {preview.total - preview.sample.length} more.</span>
                        )}
                        {preview.exclusions.map((exclusion) => (
                          <div key={exclusion.reason} className="hint">
                            {exclusion.count} excluded — {exclusion.reason}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  {canSend && (
                    <Card title="Send yourself a test first">
                      <div className="row">
                        <input
                          placeholder="chat id, e.g. 8801XXXXXXXXX@c.us"
                          value={testTarget}
                          onChange={(event) => setTestTarget(event.target.value)}
                        />
                        <button type="button" disabled={busy || !testTarget.trim()} onClick={() => void sendTest()}>
                          Send test
                        </button>
                      </div>
                      {inspecting.testSentAt && (
                        <div className="muted small">
                          Last test sent <RelativeTime value={inspecting.testSentAt} />.
                        </div>
                      )}
                    </Card>
                  )}
                </>
              ) : (
                <Card title="Per-recipient outcome">
                  {recipients.length === 0 ? (
                    <Loading label="Loading recipients…" />
                  ) : (
                    <TableWrap>
                      <table>
                        <thead>
                          <tr>
                            <th>Recipient</th>
                            <th>Status</th>
                            <th>Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recipients.map((recipient) => (
                            <tr key={recipient.id}>
                              <td className="small">{recipient.displayName ?? recipient.externalConversationId}</td>
                              <td>
                                <Badge
                                  tone={
                                    recipient.status === 'SENT' || recipient.status === 'DELIVERED'
                                      ? 'ok'
                                      : recipient.status === 'FAILED'
                                        ? 'bad'
                                        : recipient.status === 'SKIPPED'
                                          ? 'warn'
                                          : 'busy'
                                  }
                                >
                                  {humanise(recipient.status)}
                                </Badge>
                              </td>
                              <td className="small muted">
                                {recipient.failureReason ?? recipient.skippedReason ?? ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  )}
                </Card>
              )}
            </div>
            <div className="dialog-foot">
              <button type="button" onClick={() => setInspecting(null)}>
                Close
              </button>
              {canSend && inspecting.status === 'DRAFT' && (
                <button
                  type="button"
                  className="primary"
                  disabled={!preview || preview.total === 0}
                  onClick={() => setConfirming(inspecting)}
                >
                  Send to {preview?.total ?? 0}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Send this to everyone?"
          confirmLabel="Send it"
          confirmWord="SEND"
          busy={busy}
          body={
            <div className="stack">
              <p>
                <strong>{confirming.name}</strong> goes to <strong>{preview?.total ?? 0}</strong> recipients, once
                each. This cannot be unsent.
              </p>
              {!confirming.testSentAt && (
                <div className="alert">You have not sent yourself a test of this message.</div>
              )}
              <div className="card card-pad">{confirming.body}</div>
            </div>
          }
          onConfirm={() => void start(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}

      {cancelling && (
        <ConfirmDialog
          title="Cancel this broadcast?"
          confirmLabel="Cancel it"
          busy={busy}
          body="Pending recipients will not be written to. Messages already handed to WhatsApp have left and cannot be recalled."
          onConfirm={() => void cancel()}
          onCancel={() => setCancelling(null)}
        />
      )}
    </>
  );
}

/**
 * How many people this reaches.
 *
 * A draft has no `totalCount` yet — recipients are resolved when it starts, so the set cannot go
 * stale between writing and sending. Showing the stored zero would read as "this will reach
 * nobody", which is the opposite of true.
 */
function recipientSummary(broadcast: Broadcast): string {
  if (broadcast.totalCount > 0) return `${broadcast.totalCount} recipients`;

  const groups = broadcast.target?.groupIds?.length ?? 0;
  const conversations = broadcast.target?.conversationIds?.length ?? 0;
  const parts: string[] = [];
  if (groups) parts.push(`${groups} group${groups === 1 ? '' : 's'}`);
  if (conversations) parts.push(`${conversations} conversation${conversations === 1 ? '' : 's'}`);

  return parts.length ? `${parts.join(', ')} selected — counted when it starts` : 'No recipients selected';
}
