import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  conversations as conversationsApi,
  customers as customersApi,
  decisions as decisionsApi,
  groups as groupsApi,
  messages as messagesApi,
  settings as settingsApi,
  whatsapp,
  type Conversation,
  type ConversationMessage,
  type ConversationStatusValue,
  type ConversationWithTags,
  type Customer,
  type CustomerIdentity,
  type DecisionLog,
  type GroupParticipant,
  type WhatsAppAccount,
  type WhatsAppGroup,
} from '../api/client';
import { onConversationEvent } from '../api/realtime';
import { useAuth } from '../auth-context';
import { AutomationStack, type AutomationLayers } from '../components/automation-stack';
import { buildDirectory, type Destination } from './conversation-directory';
import { IconMessageCircle, IconRefresh, IconSend, IconUsers } from '../components/icons';
import {
  Badge,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
  errorMessage,
  humanise,
  useToast,
  type Tone,
} from '../components/ui';

const STATUS_OPTIONS: ConversationStatusValue[] = [
  'OPEN',
  'PENDING',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_HUMAN',
  'RESOLVED',
  'CLOSED',
];

function statusTone(status: ConversationStatusValue): Tone {
  switch (status) {
    case 'WAITING_FOR_HUMAN':
      return 'warn';
    case 'RESOLVED':
    case 'CLOSED':
      return 'neutral';
    default:
      return 'ok';
  }
}

/** A message the operator sent from here, while it is still in flight or after it failed. */
interface PendingSend {
  id: number;
  body: string;
  state: 'sending' | 'failed';
  error?: string;
}

/**
 * The operator inbox.
 *
 * Three panes, because that is the shape the work has: who to talk to, what was said, and the
 * context you need while answering. The left pane deliberately lists *destinations* rather than
 * only existing conversations — an operator needs to message a group nobody has written to yet,
 * and an inbox that only shows history cannot do that.
 *
 * Sending goes through `POST /messages`, which queues and returns; the worker performs the send. So
 * a message is only drawn in the timeline once the conversation is refetched and the real row
 * exists. Nothing is invented locally to look responsive — an operator must never see a message as
 * sent that WhatsApp never accepted.
 */
export function ConversationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can('conversations.manage');
  const canTakeover = can('conversations.takeover');
  const canSend = can('messages.send');
  const canReadGroups = can('groups.read');
  const canReadCustomers = can('customers.read');

  // --- directory -----------------------------------------------------------------------------
  const [accounts, setAccounts] = useState<WhatsAppAccount[] | null>(null);
  const [accountFilter, setAccountFilter] = useState('');
  const [tab, setTab] = useState<'all' | 'users' | 'groups'>('all');
  const [search, setSearch] = useState('');

  const [groupRows, setGroupRows] = useState<WhatsAppGroup[]>([]);
  const [identityRows, setIdentityRows] = useState<CustomerIdentity[]>([]);
  const [conversationRows, setConversationRows] = useState<Conversation[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  // --- selection -----------------------------------------------------------------------------
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<ConversationWithTags | null>(null);
  const [thread, setThread] = useState<ConversationMessage[] | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [decision, setDecision] = useState<DecisionLog | null>(null);
  const [automatedIds, setAutomatedIds] = useState<Set<string>>(new Set());
  const [participants, setParticipants] = useState<GroupParticipant[] | null>(null);
  const [groupFlags, setGroupFlags] = useState<{ automationEnabled: boolean; aiEnabled: boolean } | null>(null);
  const [stops, setStops] = useState<Record<string, boolean> | null>(null);

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [working, setWorking] = useState(false);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    void whatsapp
      .overview()
      .then((page) => setAccounts(page.items))
      .catch(() => setAccounts([]));
  }, []);

  const loadDirectory = useCallback(async () => {
    setListLoading(true);
    try {
      const accountId = accountFilter || undefined;
      const term = search.trim() || undefined;

      const [groupPage, identityPage, conversationPage] = await Promise.all([
        canReadGroups
          ? groupsApi.directory({ channelAccountId: accountId, search: term, limit: 100 })
          : Promise.resolve({ items: [] as WhatsAppGroup[], total: 0 }),
        canReadCustomers
          ? customersApi.allIdentities({ search: term, limit: 100 })
          : Promise.resolve({ items: [] as CustomerIdentity[], total: 0 }),
        conversationsApi.list({ search: term, channelAccountId: accountId, limit: 100 }),
      ]);

      setGroupRows(groupPage.items);
      setIdentityRows(identityPage.items);
      setConversationRows(conversationPage.items);
      setListError(null);
    } catch (failure) {
      setListError(errorMessage(failure, 'The inbox could not be loaded.'));
    } finally {
      setListLoading(false);
    }
  }, [accountFilter, search, canReadGroups, canReadCustomers]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDirectory(), 250);
    return () => window.clearTimeout(timer);
  }, [loadDirectory]);

  useEffect(() => onConversationEvent(null, () => void loadDirectory()), [loadDirectory]);

  const destinations = useMemo(
    () => buildDirectory(groupRows, identityRows, conversationRows, tab),
    [groupRows, identityRows, conversationRows, tab],
  );

  const destination = useMemo(
    () => destinations.find((item) => item.key === selectedKey) ?? null,
    [destinations, selectedKey],
  );

  /**
   * Which account a message to this destination leaves from.
   *
   * A group belongs to exactly one account, so it decides. A contact identity is channel-wide and
   * does not, so it falls back to the filter, then to the single connected account if there is only
   * one. If none of those resolve, sending is blocked rather than guessed.
   */
  const singleConnected = accounts?.filter((a) => a.connected) ?? [];
  const sendingAccountId =
    destination?.channelAccountId ?? (accountFilter || (singleConnected.length === 1 ? singleConnected[0].id : null));
  const sendingAccount = accounts?.find((a) => a.id === sendingAccountId) ?? null;

  /**
   * Whether a message can actually leave right now, and if not, why.
   *
   * A session is not ready the moment its container is: after a deploy or a reconnect the gateway
   * restores the session by starting a browser and loading WhatsApp Web, which takes up to a minute.
   * Sending into that window fails with "Session is not active", so the composer says what is
   * happening and waits rather than letting an operator type into something that cannot deliver.
   */
  const sendability: { ready: boolean; reason: string } = !sendingAccountId
    ? { ready: false, reason: 'Choose which WhatsApp account to send from.' }
    : !sendingAccount
      ? { ready: false, reason: 'That WhatsApp account is no longer available.' }
      : sendingAccount.connected
        ? { ready: true, reason: '' }
        : sendingAccount.state === 'CONNECTING' || sendingAccount.state === 'RECONNECTING'
          ? { ready: false, reason: `WhatsApp session is restoring on ${sendingAccount.name}. Sending is disabled until it is ready.` }
          : sendingAccount.state === 'QR_REQUIRED'
            ? { ready: false, reason: `${sendingAccount.name} needs pairing. Scan its QR code on the WhatsApp screen.` }
            : { ready: false, reason: `${sendingAccount.name} is not connected — ${sendingAccount.statusText}` };

  const loadThread = useCallback(async (target: Destination) => {
    setThreadError(null);
    setPending([]);

    if (!target.conversation) {
      // Nothing has been said yet. That is a real state, not a failure.
      setSelected(null);
      setThread([]);
      setCustomer(null);
      setDecision(null);
      setGroupFlags(null);
      setAutomatedIds(new Set());
    } else {
      try {
        const [conversation, messagePage, decisionPage] = await Promise.all([
          conversationsApi.get(target.conversation.id),
          conversationsApi.messages(target.conversation.id, { limit: 80 }),
          decisionsApi.list({ conversationId: target.conversation.id, limit: 100 }).catch(() => null),
        ]);

        setSelected(conversation);
        setThread([...messagePage.items].reverse());

        // Which replies the decision engine produced, so an automated answer is never shown as if a
        // person wrote it.
        setAutomatedIds(
          new Set((decisionPage?.items ?? []).map((d) => d.responseMessageId).filter((id): id is string => Boolean(id))),
        );
        setDecision(decisionPage?.items?.[0] ?? null);

        setCustomer(conversation.customerId ? await customersApi.get(conversation.customerId).catch(() => null) : null);
        setGroupFlags(conversation.groupId ? await groupsApi.get(conversation.groupId).catch(() => null) : null);
      } catch (failure) {
        setThreadError(errorMessage(failure, 'This conversation could not be loaded.'));
      }
    }

    setParticipants(
      target.groupId ? ((await groupsApi.participants(target.groupId).catch(() => null))?.items ?? null) : null,
    );
    setStops((await settingsApi.featureFlags().catch(() => null))?.emergencyStops ?? null);
  }, []);

  const destinationKey = destination?.key;
  const conversationId = destination?.conversation?.id;

  useEffect(() => {
    if (destination) void loadThread(destination);
    // Keyed on the destination identity, not the object: the merge rebuilds it on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationKey, loadThread]);

  useEffect(() => {
    if (!conversationId) return undefined;
    return onConversationEvent(conversationId, () => {
      if (destination) void loadThread(destination);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, loadThread]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread, pending]);

  async function send(body: string, retryOf?: number) {
    if (!destination || !body.trim()) return;
    if (!sendingAccountId) {
      toast.error('Choose which WhatsApp account this message should be sent from.');
      return;
    }

    const id = retryOf ?? Date.now();
    setPending((current) =>
      retryOf
        ? current.map((item) => (item.id === retryOf ? { ...item, state: 'sending', error: undefined } : item))
        : [...current, { id, body, state: 'sending' }],
    );
    if (!retryOf) setDraft('');

    try {
      await messagesApi.send({
        channelAccountId: sendingAccountId,
        externalConversationId: destination.externalId,
        body: body.trim(),
      });
      setPending((current) => current.filter((item) => item.id !== id));
      toast.success('Message queued for sending.');
      await loadDirectory();
      if (destination.conversation) await loadThread(destination);
    } catch (failure) {
      const message = errorMessage(failure, 'The message could not be queued.');
      setPending((current) => current.map((item) => (item.id === id ? { ...item, state: 'failed', error: message } : item)));
    }
  }

  async function changeStatus(status: ConversationStatusValue) {
    if (!selected || !destination) return;
    setWorking(true);
    try {
      await conversationsApi.setStatus(selected.id, status);
      toast.success(`Marked ${humanise(status).toLowerCase()}.`);
      await loadThread(destination);
      void loadDirectory();
    } catch (failure) {
      toast.error(errorMessage(failure, 'The status could not be changed.'));
    } finally {
      setWorking(false);
    }
  }

  async function toggleTakeover() {
    if (!selected || !destination) return;
    const releasing = selected.controlState === 'HUMAN_ACTIVE';
    setWorking(true);
    try {
      if (releasing) await conversationsApi.release(selected.id);
      else await conversationsApi.takeover(selected.id);
      toast.success(releasing ? 'Released back to automation.' : 'You have taken this conversation over.');
      await loadThread(destination);
    } catch (failure) {
      toast.error(errorMessage(failure, 'That could not be done.'));
    } finally {
      setWorking(false);
    }
  }

  if (accounts !== null && accounts.length === 0) {
    return (
      <>
        <PageHeader title="Conversations" description="Messages from your connected WhatsApp accounts." />
        <div className="card card-pad">
          <Empty
            title="No WhatsApp account connected"
            hint="Connect a WhatsApp account to start receiving conversations and messaging customers or groups."
            action={
              <Link to="/channels/whatsapp" className="button-link">
                Connect WhatsApp
              </Link>
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Conversations"
        description="Every WhatsApp contact and group Support CRM knows about."
        actions={
          <>
            {accounts && accounts.length > 1 && (
              <select
                value={accountFilter}
                onChange={(event) => setAccountFilter(event.target.value)}
                style={{ width: 'auto' }}
                aria-label="WhatsApp account"
              >
                <option value="">All accounts</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            )}
            {canSend && (
              <button type="button" className="primary" onClick={() => setComposing(true)}>
                + New message
              </button>
            )}
          </>
        }
      />

      <div className="inbox">
        {/* --- directory ---------------------------------------------------------------------- */}
        <div className="inbox-pane">
          <div className="inbox-search">
            <input placeholder="Search people or groups…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="inbox-tabs">
            {(['all', 'users', 'groups'] as const).map((name) => (
              <button
                key={name}
                type="button"
                className={tab === name ? 'inbox-tab active' : 'inbox-tab'}
                onClick={() => setTab(name)}
              >
                {name === 'all' ? 'All' : name === 'users' ? 'Users' : 'Groups'}
              </button>
            ))}
          </div>

          <div className="inbox-list">
            {listError && (
              <div style={{ padding: 14 }}>
                <ErrorState message={listError} onRetry={() => void loadDirectory()} />
              </div>
            )}
            {listLoading && destinations.length === 0 && !listError && (
              <div style={{ padding: 14 }}>
                <Loading label="Loading contacts and groups…" />
              </div>
            )}
            {!listLoading && destinations.length === 0 && !listError && (
              <Empty
                title={search ? 'Nothing matches' : 'No conversations yet'}
                hint={
                  search
                    ? 'Try a different name or number.'
                    : singleConnected.length === 0
                      ? 'Link a WhatsApp account, then sync its groups to message them.'
                      : 'Messages from your connected accounts appear here. Sync an account’s groups to message them first.'
                }
              />
            )}

            {destinations.map((item) => (
              <button
                key={item.key}
                type="button"
                className={item.key === selectedKey ? 'conv-item active' : 'conv-item'}
                onClick={() => setSelectedKey(item.key)}
              >
                <div className="conv-row">
                  <span className={item.kind === 'GROUP' ? 'conv-avatar group' : 'conv-avatar'}>
                    {item.kind === 'GROUP' ? <IconUsers size={15} /> : <IconMessageCircle size={15} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="conv-item-top">
                      <span className="conv-item-subject">{item.name}</span>
                      <span className="conv-item-time">
                        {item.lastActivityAt ? <RelativeTime value={item.lastActivityAt} /> : null}
                      </span>
                    </div>
                    <div className="conv-item-preview">{item.conversation?.lastMessagePreview ?? item.subtitle}</div>
                    <div className="conv-item-tags">
                      {item.conversation && (
                        <Badge tone={statusTone(item.conversation.status)}>{humanise(item.conversation.status)}</Badge>
                      )}
                      {accounts && accounts.length > 1 && item.channelAccountId && (
                        <span className="conv-account">
                          {accounts.find((a) => a.id === item.channelAccountId)?.name ?? 'account'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* --- thread ------------------------------------------------------------------------- */}
        <div className="inbox-pane">
          {!destination ? (
            <Empty title="Select a contact or group" hint="Pick one from the list to read its history and reply." />
          ) : (
            <>
              <div className="thread-head">
                <span className={destination.kind === 'GROUP' ? 'conv-avatar group' : 'conv-avatar'}>
                  {destination.kind === 'GROUP' ? <IconUsers size={16} /> : <IconMessageCircle size={16} />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="thread-head-title">{destination.name}</div>
                  <div className="muted small">
                    {destination.subtitle}
                    {sendingAccount && ` · ${sendingAccount.name}`}
                  </div>
                </div>

                {selected && (
                  <>
                    <Badge tone={selected.controlState === 'HUMAN_ACTIVE' ? 'warn' : 'ok'}>
                      {selected.controlState === 'HUMAN_ACTIVE' ? 'Human' : 'Automation'}
                    </Badge>
                    {canManage && (
                      <select
                        value={selected.status}
                        disabled={working}
                        onChange={(e) => void changeStatus(e.target.value as ConversationStatusValue)}
                        style={{ width: 'auto' }}
                        aria-label="Conversation status"
                      >
                        {STATUS_OPTIONS.map((status) => (
                          <option key={status} value={status}>
                            {humanise(status)}
                          </option>
                        ))}
                      </select>
                    )}
                    {canTakeover && (
                      <button type="button" disabled={working} onClick={() => void toggleTakeover()}>
                        {selected.controlState === 'HUMAN_ACTIVE' ? 'Release' : 'Take over'}
                      </button>
                    )}
                  </>
                )}
              </div>

              {threadError && (
                <div style={{ padding: 14 }}>
                  <ErrorState message={threadError} onRetry={() => void loadThread(destination)} />
                </div>
              )}

              <div className="thread-messages" ref={scrollRef}>
                {thread === null && <Loading label="Loading messages…" />}
                {thread?.length === 0 && pending.length === 0 && (
                  <Empty
                    title="No messages yet"
                    hint={
                      destination.conversation
                        ? 'This conversation has no messages recorded.'
                        : 'Nothing has been said here yet. Send the first message below.'
                    }
                  />
                )}

                {thread?.map((message, index) => {
                  const previous = thread[index - 1];
                  const showDay =
                    !previous || new Date(previous.sentAt).toDateString() !== new Date(message.sentAt).toDateString();
                  const automated = automatedIds.has(message.id);

                  if (message.contentType === 'SYSTEM_EVENT') {
                    return (
                      <div key={message.id}>
                        {showDay && <div className="thread-day">{dayLabel(message.sentAt)}</div>}
                        <div className="msg-system">
                          {message.body ?? 'System event'} · <RelativeTime value={message.sentAt} />
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={message.id}>
                      {showDay && <div className="thread-day">{dayLabel(message.sentAt)}</div>}
                      <div className={`msg-row ${message.direction === 'OUTBOUND' ? 'outbound' : 'inbound'}`}>
                        <div className={`msg-bubble${automated ? ' automated' : ''}`}>
                          {message.contentType === 'TEXT' ? (message.body ?? '') : `[${humanise(message.contentType)}]`}
                          <div className="msg-meta">
                            {message.direction === 'INBOUND'
                              ? (message.senderDisplayName ?? 'Customer')
                              : automated
                                ? 'Automated'
                                : 'Support CRM'}
                            {' · '}
                            <RelativeTime value={message.sentAt} />
                            {message.deliveryStatus ? ` · ${humanise(message.deliveryStatus)}` : ''}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Messages this operator just sent, while in flight or after a failure. A failed one
                    stays put with its reason and a retry — never silently dropped. */}
                {pending.map((item) => (
                  <div key={item.id} className="msg-row outbound">
                    <div className={item.state === 'failed' ? 'msg-bubble failed' : 'msg-bubble sending'}>
                      {item.body}
                      <div className="msg-meta">
                        {item.state === 'sending' ? (
                          'Sending…'
                        ) : (
                          <>
                            {item.error ?? 'Failed'}{' '}
                            <button type="button" className="msg-retry" onClick={() => void send(item.body, item.id)}>
                              <IconRefresh size={12} /> Retry
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {canSend && !sendability.ready && (
                <div className="thread-notice">{sendability.reason}</div>
              )}

              {canSend && destination.kind === 'GROUP' && (
                // The destination said out loud, right above the composer. A message meant for one
                // person that lands in a group of ninety cannot be taken back.
                <div className="thread-destination">
                  Sending to <strong>{destination.name}</strong> · {destination.subtitle}
                  {sendingAccount ? ` · via ${sendingAccount.name}` : ''}
                </div>
              )}

              {canSend && (
                <div className="thread-compose">
                  <textarea
                    rows={2}
                    placeholder={
                      sendability.ready
                        ? 'Type a message…  (Enter to send, Shift+Enter for a new line)'
                        : sendability.reason
                    }
                    value={draft}
                    disabled={!sendability.ready}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void send(draft);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={!draft.trim() || !sendability.ready}
                    title={sendability.ready ? 'Send' : sendability.reason}
                    onClick={() => void send(draft)}
                  >
                    <IconSend size={15} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* --- context ------------------------------------------------------------------------ */}
        <div className="inbox-pane">
          {!destination ? (
            <div className="info-pane-section">
              <div className="muted small">Select a conversation to see its context.</div>
            </div>
          ) : (
            <>
              <div className="info-pane-section">
                <div className="info-pane-label">{destination.kind === 'GROUP' ? 'Group' : 'Contact'}</div>
                <div style={{ fontWeight: 600 }}>{customer?.displayName ?? destination.name}</div>
                <div className="muted small">{destination.subtitle}</div>
                {customer ? (
                  <div className="small" style={{ marginTop: 4 }}>
                    <Link to="/customers">Customer record →</Link>
                  </div>
                ) : destination.kind === 'USER' ? (
                  <div className="muted small" style={{ marginTop: 4 }}>
                    Not linked to a customer yet.
                  </div>
                ) : null}
                {sendingAccount && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Account: {sendingAccount.name} ·{' '}
                    {sendingAccount.connected ? 'connected' : sendingAccount.statusText}
                  </div>
                )}
              </div>

              {selected ? (
                <>
                  <div className="info-pane-section">
                    <div className="info-pane-label">Conversation</div>
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="stack-row">
                        <span className="stack-row-name">Status</span>
                        <Badge tone={statusTone(selected.status)}>{humanise(selected.status)}</Badge>
                      </div>
                      <div className="stack-row">
                        <span className="stack-row-name">Messages</span>
                        <span className="small">{selected.messageCount}</span>
                      </div>
                      <div className="stack-row">
                        <span className="stack-row-name">Human takeover</span>
                        <Badge tone={selected.controlState === 'HUMAN_ACTIVE' ? 'warn' : 'neutral'}>
                          {selected.controlState === 'HUMAN_ACTIVE' ? 'Active' : 'Not active'}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  <div className="info-pane-section">
                    <div className="info-pane-label">Automation</div>
                    <AutomationStack
                      layers={
                        {
                          globallyStopped: stops ? Boolean(stops['emergency.all_automation_paused']) : null,
                          group: groupFlags ? groupFlags.automationEnabled : null,
                          conversation: selected.automationEnabled,
                          controlState: selected.controlState,
                          pausedUntil: selected.pausedUntil,
                        } satisfies AutomationLayers
                      }
                    />
                  </div>

                  <div className="info-pane-section">
                    <div className="info-pane-label">AI</div>
                    <AutomationStack
                      label="AI"
                      layers={
                        {
                          globallyStopped: stops ? Boolean(stops['emergency.all_ai_paused']) : null,
                          group: groupFlags ? groupFlags.aiEnabled : null,
                          conversation: selected.aiEnabled,
                          controlState: selected.controlState,
                          pausedUntil: selected.pausedUntil,
                        } satisfies AutomationLayers
                      }
                    />
                  </div>

                  {decision && (
                    <div className="info-pane-section">
                      <div className="info-pane-label">Last decision</div>
                      <div className="stack" style={{ gap: 8 }}>
                        <div className="stack-row">
                          <span className="stack-row-name">Outcome</span>
                          <Badge tone={decision.outcome === 'FAILED' ? 'bad' : 'ok'}>
                            {humanise(decision.outcome ?? 'IN_PROGRESS')}
                          </Badge>
                        </div>
                        {decision.reason && <div className="muted small">{decision.reason}</div>}
                        {/* Never a bare percentage: it is a provider's self-report, uncalibrated. */}
                        {decision.confidence !== null && decision.confidence !== undefined && (
                          <div className="muted small">
                            Confidence {Number(decision.confidence).toFixed(2)}{' '}
                            {decision.confidenceCalibrated ? '(measured)' : '(self-reported, uncalibrated)'}
                          </div>
                        )}
                        <Link to="/decisions" className="small">
                          Decision trace →
                        </Link>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="info-pane-section">
                  <div className="muted small">
                    No conversation exists yet. One is created when the first message is sent or received.
                  </div>
                </div>
              )}

              {destination.kind === 'GROUP' && (
                <div className="info-pane-section">
                  <div className="info-pane-label">Members</div>
                  {participants === null || participants.length === 0 ? (
                    <div className="muted small">
                      Participants have not been synced for this group.{' '}
                      {destination.channelAccountId && (
                        <Link to={`/channels/whatsapp/${destination.channelAccountId}/groups`}>Sync participants →</Link>
                      )}
                    </div>
                  ) : (
                    <div className="stack" style={{ gap: 4 }}>
                      {participants.slice(0, 8).map((participant) => (
                        <div key={participant.id} className="small">
                          {participant.displayName ?? participant.phone ?? participant.externalId}
                          {participant.isAdmin && <span className="muted"> · admin</span>}
                        </div>
                      ))}
                      {participants.length > 8 && (
                        <Link to={`/channels/whatsapp/${destination.channelAccountId}/groups`} className="small">
                          All {participants.length} members →
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {composing && (
        <NewMessageDialog
          destinations={destinations}
          accounts={accounts ?? []}
          onClose={() => setComposing(false)}
          onPick={(key) => {
            setSelectedKey(key);
            setComposing(false);
          }}
        />
      )}
    </>
  );
}

/** "Today", "Yesterday", or the date — the divider a message timeline needs to stay readable. */
function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Choosing who to message.
 *
 * Picks a destination and hands it back to the inbox rather than sending from inside the dialog —
 * so the operator always composes in the thread, with the history and the destination banner in
 * front of them. Only contacts and groups Support CRM already knows can be chosen: addressing an
 * arbitrary number would be sending into something with no record behind it.
 */
function NewMessageDialog({
  destinations,
  accounts,
  onClose,
  onPick,
}: {
  destinations: Destination[];
  accounts: WhatsAppAccount[];
  onClose: () => void;
  onPick: (key: string) => void;
}) {
  const [term, setTerm] = useState('');

  const matches = destinations.filter((item) =>
    term.trim() ? `${item.name} ${item.subtitle}`.toLowerCase().includes(term.trim().toLowerCase()) : true,
  );
  const users = matches.filter((item) => item.kind === 'USER').slice(0, 20);
  const groups = matches.filter((item) => item.kind === 'GROUP').slice(0, 20);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (matches.length === 1) onPick(matches[0].key);
  }

  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-label="New message">
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-head">
          <h2>New message</h2>
        </div>
        <div className="dialog-body stack">
          <Field label="Choose destination" hint="Search the contacts and groups Support CRM knows about.">
            <input value={term} autoFocus placeholder="Search users or groups…" onChange={(e) => setTerm(e.target.value)} />
          </Field>

          {matches.length === 0 && (
            <Empty
              title="Nothing matches"
              hint="Only contacts and groups already known to Support CRM can be messaged. Sync an account’s groups to add more."
            />
          )}

          {users.length > 0 && (
            <div>
              <div className="info-pane-label">Users</div>
              <div className="stack" style={{ gap: 2 }}>
                {users.map((item) => (
                  <button key={item.key} type="button" className="picker-row" onClick={() => onPick(item.key)}>
                    <span className="conv-avatar">
                      <IconMessageCircle size={14} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="picker-name">{item.name}</span>
                      <span className="picker-sub">{item.subtitle}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {groups.length > 0 && (
            <div>
              <div className="info-pane-label">Groups</div>
              <div className="stack" style={{ gap: 2 }}>
                {groups.map((item) => (
                  <button key={item.key} type="button" className="picker-row" onClick={() => onPick(item.key)}>
                    <span className="conv-avatar group">
                      <IconUsers size={14} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="picker-name">{item.name}</span>
                      <span className="picker-sub">
                        {item.subtitle}
                        {accounts.length > 1 && item.channelAccountId
                          ? ` · ${accounts.find((a) => a.id === item.channelAccountId)?.name ?? ''}`
                          : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
