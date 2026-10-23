import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { workspace, type SavedReply } from '../api/workspace';
import { WhatsAppChatTool,WhatsAppComposerExtras,WhatsAppMessageContent } from '../components/whatsapp-chat';
import { WhatsAppIcon } from '../components/whatsapp-icons';
import { inbox, type InboxAction } from '../api/inbox';
import { useVisibleMessages } from '../components/use-visible-messages';
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
import { onConversationEvent,onWhatsAppPresence } from '../api/realtime';
import { useAuth } from '../auth-context';
import { AutomationStack, type AutomationLayers } from '../components/automation-stack';
import { buildDirectory, type Destination } from './conversation-directory';
import {
  IconAlertCircle,
  IconInbox,
  IconMessageCircle,
  IconPlug,
  IconRefresh,
  IconSend,
  IconUsers,
} from '../components/icons';
import {
  Badge,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
  Skeleton,
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
  idempotencyKey: string;
  quotedExternalId?: string;
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
export function ConversationsPage({embedded=false,externalAccount}:{embedded?:boolean;externalAccount?:string}={}) {
  const { can } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedConversation = searchParams.get('conversation');
  const deepLinkDone = useRef<string | null>(null);
  const toast = useToast();
  const canManage = can('conversations.manage');
  const canTakeover = can('conversations.takeover');
  const canSend = can('messages.send');
  const canReadGroups = can('groups.read');
  const canReadCustomers = can('customers.read');
  const canReadMessages = can('messages.read');

  // --- directory -----------------------------------------------------------------------------
  const [accounts, setAccounts] = useState<WhatsAppAccount[] | null>(null);
  const [accountFilter, setAccountFilter] = useState(externalAccount??'');
  const [showContext,setShowContext]=useState(false);
  const [showSearch,setShowSearch]=useState(false);
  
  const [tab, setTab] = useState<'all' | 'users' | 'groups'>('all');
  const [search, setSearch] = useState('');

  const [groupRows, setGroupRows] = useState<WhatsAppGroup[]>([]);
  const [identityRows, setIdentityRows] = useState<CustomerIdentity[]>([]);
  const [conversationRows, setConversationRows] = useState<Conversation[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const directoryEpoch = useRef(0);
  const [inboxView,setInboxView] = useState<'active'|'unread'|'archived'>('active');
  const [checked,setChecked] = useState<Set<string>>(new Set());
  const [organizing,setOrganizing] = useState(false);
  const organizeLock = useRef(false);
  const readsInFlight = useRef(new Map<string,Promise<unknown>>());
  const [unreadAnchor,setUnreadAnchor] = useState<string|null>(null);
  const [readError,setReadError] = useState(false);

  // --- selection -----------------------------------------------------------------------------
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [chatTool,setChatTool]=useState<{operation:string;message?:ConversationMessage}|null>(null);
  useEffect(()=>{if(externalAccount!==undefined){setAccountFilter(externalAccount);setSelectedKey(null);setChatTool(null);}},[externalAccount]);
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
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [threadSearch, setThreadSearch] = useState('');
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderCursorId, setOlderCursorId] = useState<string | null>(null);
  const [quoted, setQuoted] = useState<ConversationMessage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const draftCache = useRef<Record<string, string>>({});
  const activeDraftKey = useRef<string | null>(null);
  const draftTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const sendInFlight = useRef(new Set<string>());
  const skipScroll = useRef(false);
  const threadEpoch = useRef(0);
  const loadedConversation = useRef<string | null>(null);

  useEffect(() => {
    if (!canSend) return;
    let active = true;
    void workspace.replies().then(p => { if (active) setSavedReplies(p.items); }).catch(() => undefined);
    void workspace.drafts().then(p => {
      for (const item of p.items) if (!(item.destinationKey in draftCache.current)) draftCache.current[item.destinationKey] = item.body;
      const key = activeDraftKey.current;
      if (active && key && draftCache.current[key]) setDraft(draftCache.current[key]);
    }).catch(() => undefined);
    return () => { active = false; };
    // Drafts are hydrated once. Subsequent typing owns the cached value.
  }, [canSend]);

  useEffect(() => {
    activeDraftKey.current = selectedKey;
    setPending([]);
    setDraft(selectedKey ? draftCache.current[selectedKey] || '' : '');
    setThreadSearch('');
    setQuoted(null);
  }, [selectedKey]);

  function updateDraft(body: string) {
    setDraft(body);
    if (!selectedKey) return;
    draftCache.current[selectedKey] = body;
    clearTimeout(draftTimers.current[selectedKey]);
    const key = selectedKey;
    draftTimers.current[key] = setTimeout(() => { void workspace.draft(key, body).catch(() => toast.error('Your draft could not be saved. Keep this tab open and try again.')); }, 600);
  }

  useEffect(() => {
    void whatsapp
      .overview()
      .then((page) => setAccounts(page.items))
      .catch(() => setAccounts([]));
  }, []);

  const loadDirectory = useCallback(async () => {
    const epoch=++directoryEpoch.current;
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

      if(epoch!==directoryEpoch.current) return;
      setGroupRows(groupPage.items);
      setIdentityRows(identityPage.items);
      setConversationRows(conversationPage.items);
      setListError(null);
    } catch (failure) {
      if(epoch!==directoryEpoch.current) return;
      setListError(errorMessage(failure, 'The inbox could not be loaded.'));
    } finally {
      if(epoch===directoryEpoch.current) setListLoading(false);
    }
  }, [accountFilter, search, canReadGroups, canReadCustomers]);
  const reloadDirectory=useRef(loadDirectory);
  reloadDirectory.current=loadDirectory;

  useEffect(() => {
    ++directoryEpoch.current;
    setChecked(new Set());
    const timer = window.setTimeout(() => void loadDirectory(), 250);
    return () => window.clearTimeout(timer);
  }, [loadDirectory]);

  useEffect(() => onConversationEvent(null, () => void loadDirectory()), [loadDirectory]);

  const destinations = useMemo(
    () => buildDirectory(groupRows, identityRows, conversationRows),
    [groupRows, identityRows, conversationRows],
  );
  const visibleDestinations=destinations.filter(item=>
    (tab==='all'||(tab==='users'?item.kind==='USER':item.kind==='GROUP')) &&
    (inboxView==='archived'?Boolean(item.conversation?.isArchived):!item.conversation?.isArchived &&
      (inboxView!=='unread'||Boolean(item.conversation?.unreadCount||item.conversation?.markedUnread))));

  const destination = useMemo(
    () => destinations.find((item) => item.key === selectedKey) ?? null,
    [destinations, selectedKey],
  );

  useEffect(() => {
    if (!requestedConversation || deepLinkDone.current === requestedConversation) return;
    const found = destinations.find(d => d.conversation?.id === requestedConversation);
    if (found) { deepLinkDone.current = requestedConversation; setSelectedKey(found.key); return; }
    if (!listLoading) {
      void conversationsApi.get(requestedConversation).then(c => setConversationRows(rows => rows.some(r => r.id === c.id) ? rows : [c, ...rows])).catch(e => {
        deepLinkDone.current = requestedConversation; toast.error(errorMessage(e, 'Conversation could not be opened.'));
      });
    }
  }, [requestedConversation, destinations, listLoading, toast]);

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
    const epoch = ++threadEpoch.current;
    setThreadError(null);

    if (!target.conversation) {
      loadedConversation.current = null;
      setOlderCursor(null); setOlderCursorId(null);
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

        if (epoch !== threadEpoch.current) return;

        setSelected(conversation);
        const same = loadedConversation.current === conversation.id;
        if(!same) {setUnreadAnchor(conversation.firstUnreadMessageId??null);setReadError(false);}
        loadedConversation.current = conversation.id;
        setThread(current => same && current ? [...new Map([...current, ...messagePage.items].map(m => [m.id, m])).values()].sort((a,b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id)) : [...messagePage.items].reverse());
        if (!same) { setOlderCursor(messagePage.nextCursor); setOlderCursorId(messagePage.nextCursorId); }

        // Which replies the decision engine produced, so an automated answer is never shown as if a
        // person wrote it.
        setAutomatedIds(
          new Set((decisionPage?.items ?? []).map((d) => d.responseMessageId).filter((id): id is string => Boolean(id))),
        );
        setDecision(decisionPage?.items?.[0] ?? null);

        const [customerRow, flags] = await Promise.all([
          conversation.customerId ? customersApi.get(conversation.customerId).catch(() => null) : Promise.resolve(null),
          conversation.groupId ? groupsApi.get(conversation.groupId).catch(() => null) : Promise.resolve(null),
        ]);
        if (epoch !== threadEpoch.current) return;
        setCustomer(customerRow); setGroupFlags(flags);
      } catch (failure) {
        if (epoch !== threadEpoch.current) return;
        setThreadError(errorMessage(failure, 'This conversation could not be loaded.'));
      }
    }

    const [participantPage, flags] = await Promise.all([
      target.groupId ? groupsApi.participants(target.groupId).catch(() => null) : Promise.resolve(null),
      settingsApi.featureFlags().catch(() => null),
    ]);
    if (epoch !== threadEpoch.current) return;
    setParticipants(participantPage?.items ?? null);
    setStops(flags?.emergencyStops ?? null);
  }, []);

  const [presence,setPresence]=useState('');
  useEffect(()=>{setPresence('');let expiry:ReturnType<typeof setTimeout>|undefined;const off=onWhatsAppPresence(event=>{if(event.channelAccountId!==sendingAccountId||event.externalConversationId!==destination?.externalId)return;if(expiry)clearTimeout(expiry);setPresence(event.state==='composing'?(event.recording?'recording audio...':'typing...'):'');expiry=setTimeout(()=>setPresence(''),10000);});return()=>{off();if(expiry)clearTimeout(expiry);};},[sendingAccountId,destination?.externalId]);
  const destinationKey = destination?.key;
  const conversationId = destination?.conversation?.id;
  const activeReadConversation=useRef(conversationId);
  activeReadConversation.current=conversationId;

  useEffect(() => {
    if (destination) {
      if (destination.conversation?.id !== loadedConversation.current) {
        setSelected(null); setThread(null); setCustomer(null); setParticipants(null);
        setOlderCursor(null); setOlderCursorId(null);
      }
      void loadThread(destination);
    } else {
      ++threadEpoch.current; loadedConversation.current=null;
      setSelected(null);setThread(null);setUnreadAnchor(null);
    }
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
  const recordRead=useCallback(async(ids:string[])=>{
    if(!conversationId||organizeLock.current) return;
    const previous=readsInFlight.current.get(conversationId);
    const request=(async()=>{await previous?.catch(()=>undefined);return inbox.read(conversationId,ids);})();
    readsInFlight.current.set(conversationId,request);
    try {
      const result=await request;
      setSelected(current=>current?.id===conversationId?{...current,...result}:current);
      setConversationRows(rows=>rows.map(row=>row.id===conversationId?{...row,...result}:row));
      if(activeReadConversation.current===conversationId)setReadError(false);
      void reloadDirectory.current();
    } catch(failure) {if(activeReadConversation.current===conversationId)setReadError(true);throw failure;}
    finally {if(readsInFlight.current.get(conversationId)===request)readsInFlight.current.delete(conversationId);}
  },[conversationId]);
  useVisibleMessages(scrollRef,thread,Boolean(destination&&selected&&canReadMessages&&!organizing),recordRead);

  async function organize(action:InboxAction,ids:string[]) {
    if(!ids.length||organizeLock.current) return;
    organizeLock.current=true;setOrganizing(true);
    try {
      await Promise.all(ids.map(id=>readsInFlight.current.get(id)?.catch(()=>undefined)));
      await inbox.organize(ids,action);
      setChecked(new Set());
      if(selected&&ids.includes(selected.id)&&action==='MARK_UNREAD') setSelectedKey(null);
      const patch=action==='PIN'||action==='UNPIN'?{isPinned:action==='PIN'}:action==='MARK_UNREAD'?{markedUnread:true}:{isArchived:action==='ARCHIVE'};
      setConversationRows(rows=>rows.map(row=>ids.includes(row.id)?{...row,...patch}:row));
      setSelected(current=>current&&ids.includes(current.id)?{...current,...patch}:current);
      toast.success(`${ids.length} conversation${ids.length===1?'':'s'} updated.`);
      void reloadDirectory.current();
    } catch(failure) {toast.error(errorMessage(failure,'Inbox could not be updated. Your selection is retained.'));}
    finally {organizeLock.current=false;setOrganizing(false);}
  }
  async function markLoadedRead() {
    const ids=(thread??[]).filter(m=>m.direction==='INBOUND'&&m.contentType!=='SYSTEM_EVENT').map(m=>m.id);
    try {
      if(!ids.length) await recordRead([]);
      for(let offset=0;offset<ids.length;offset+=200) await recordRead(ids.slice(offset,offset+200));
    } catch { /* The retained read-status notice provides retry. */ }
  }
  useEffect(() => {
    if (skipScroll.current) { skipScroll.current = false; return; }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread, pending]);

  async function send(body: string, retryOf?: number) {
    if (!destination || !body.trim()) return;
    if (sendInFlight.current.has(destination.key)) return;
    if (!sendingAccountId) {
      toast.error('Choose which WhatsApp account this message should be sent from.');
      return;
    }

    sendInFlight.current.add(destination.key);
    const id = retryOf ?? Date.now();
    const idempotencyKey = (retryOf ? pending.find(p => p.id === retryOf)?.idempotencyKey : undefined) ?? crypto.randomUUID();
    const quotedExternalId = retryOf ? pending.find(p => p.id === retryOf)?.quotedExternalId : quoted?.externalId;
    setPending((current) =>
      retryOf
        ? current.map((item) => (item.id === retryOf ? { ...item, state: 'sending', error: undefined } : item))
        : [...current, { id, body, idempotencyKey, quotedExternalId, state: 'sending' }],
    );
    if (!retryOf) updateDraft('');
    setQuoted(null);

    try {
      await messagesApi.send({
        channelAccountId: sendingAccountId,
        externalConversationId: destination.externalId,
        body: body.trim(),
        idempotencyKey,
        quotedExternalId,
      });
      setPending((current) => current.filter((item) => item.id !== id));
      toast.success('Message queued for sending.');
      await loadDirectory();
      if (destination.conversation && activeDraftKey.current === destination.key) await loadThread(destination);
    } catch (failure) {
      const message = errorMessage(failure, 'The message could not be queued.');
      setPending((current) => current.map((item) => (item.id === id ? { ...item, state: 'failed', error: message } : item)));
    } finally {
      sendInFlight.current.delete(destination.key);
    }
  }

  async function loadOlder() {
    if (!selected || !olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const epoch = threadEpoch.current;
      const page = await conversationsApi.messages(selected.id, { before: olderCursor, beforeId: olderCursorId || undefined, limit: 80 });
      if (epoch !== threadEpoch.current) return;
      skipScroll.current = true;
      setThread(current => { const ids = new Set((current || []).map(m => m.id)); return [...page.items.filter(m => !ids.has(m.id)).reverse(), ...(current || [])]; });
      setOlderCursor(page.nextCursor);
      setOlderCursorId(page.nextCursorId);
    } catch (e) { toast.error(errorMessage(e, 'Could not load earlier messages.')); } finally { setLoadingOlder(false); }
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
            icon={<IconPlug size={20} />}
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
    <section className={embedded?'wa-chat':'conversation-page'}>
      {!embedded&&<PageHeader
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
      />} 

      <div className={`inbox${embedded?' wa-inbox':''}${destination?' has-chat':''}${showContext?' show-context':''}`}>
        {/* --- directory ---------------------------------------------------------------------- */}
        <div className="inbox-pane wa-chat-list">
          {embedded&&<header className="wa-list-head"><h1>Chats</h1>{canReadMessages&&<Link to={`/whatsapp/history?account=${externalAccount??accountFilter}`} aria-label="Browse WhatsApp history" title="Browse WhatsApp history"><WhatsAppIcon name="clock" size={20}/></Link>}{canSend&&<button aria-label="New chat" title="New chat" onClick={()=>setComposing(true)}>?</button>}<button aria-label="WhatsApp chat settings" title="WhatsApp chat settings" onClick={()=>setShowContext(v=>!v)}>?</button></header>}
          <div className="inbox-search">
            <input aria-label="Search conversations" placeholder="Search people or groups…" value={search} onChange={(e) => setSearch(e.target.value)} />
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

          <div className="inbox-organize">
            <select aria-label="Inbox view" value={inboxView} onChange={e=>{setInboxView(e.target.value as typeof inboxView);setChecked(new Set());}}>
              <option value="active">Active inbox</option><option value="unread">Unread</option><option value="archived">Archived</option>
            </select>
            <span className="muted small">Your view · latest 100 conversations</span>
            {checked.size>0&&<div className="inbox-bulk" aria-label="Selected conversation actions">
              <span className="small">{checked.size} selected</span>
              <button disabled={organizing} onClick={()=>void organize(inboxView==='archived'?'UNARCHIVE':'ARCHIVE',[...checked])}>{inboxView==='archived'?'Unarchive':'Archive'}</button>
              <button disabled={organizing} onClick={()=>void organize('MARK_UNREAD',[...checked])}>Mark unread</button>
              {canManage&&<><button disabled={organizing} onClick={()=>void organize('PIN',[...checked])}>Pin</button><button disabled={organizing} onClick={()=>void organize('UNPIN',[...checked])}>Unpin</button></>}
              <button disabled={organizing} onClick={()=>setChecked(new Set())}>Clear selection</button>
            </div>}
          </div>
          <div className="inbox-list">
            {listError && (
              <div style={{ padding: 14 }}>
                <ErrorState message={listError} onRetry={() => void loadDirectory()} icon={<IconAlertCircle size={20} />} />
              </div>
            )}
            {listLoading && visibleDestinations.length === 0 && !listError && (
              <div style={{ padding: 14 }}>
                <Skeleton lines={8} />
              </div>
            )}
            {!listLoading && visibleDestinations.length === 0 && !listError && (
              <Empty
                title={inboxView==='archived'?'No archived conversations':inboxView==='unread'?'No unread conversations':search ? 'Nothing matches' : 'No conversations yet'}
                hint={
                  search
                    ? 'Try a different name or number.'
                    : inboxView==='archived'?'Archived conversations remain available here until you unarchive them.'
                    : inboxView==='unread'?'No unread conversations in the loaded directory.'
                    : singleConnected.length === 0
                      ? 'Link a WhatsApp account, then sync its groups to message them.'
                      : 'Messages from your connected accounts appear here. Sync an account’s groups to message them first.'
                }
                icon={<IconInbox size={20} />}
              />
            )}

            {visibleDestinations.map((item) => (
              <div className="inbox-select-row" key={item.key}>
                {item.conversation&&<input type="checkbox" aria-label={`Select ${item.name}`} checked={checked.has(item.conversation.id)} disabled={organizing||(!checked.has(item.conversation.id)&&checked.size>=50)} onChange={e=>{const id=item.conversation!.id;setChecked(current=>{const next=new Set(current);if(e.target.checked)next.add(id);else next.delete(id);return next;});}}/>}
              <button
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
                      {item.conversation?.isPinned&&<Badge>Pinned</Badge>}
                      {Boolean(item.conversation?.unreadCount)&&<Badge tone="busy">{item.conversation?.unreadCount} unread</Badge>}
                      {!item.conversation?.unreadCount&&item.conversation?.markedUnread&&<Badge tone="busy">Unread</Badge>}
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
              </div>
            ))}
          </div>
        </div>

        {/* --- thread ------------------------------------------------------------------------- */}
        <div className="inbox-pane">
          {embedded&&<button className="wa-close-context" aria-label="Close conversation information" onClick={()=>setShowContext(false)}><WhatsAppIcon name="close"/></button>}
          {!destination ? (
            <Empty
              title="Select a contact or group"
              hint="Pick one from the list to read its history and reply."
              icon={<IconMessageCircle size={20} />}
            />
          ) : (
            <>
              <div className="thread-head" style={{ flexWrap: 'wrap' }}>
                {embedded&&<button className="wa-chat-back" aria-label="Back to chats" onClick={()=>setSelectedKey(null)}><WhatsAppIcon name="back"/></button>}
                <span className={destination.kind === 'GROUP' ? 'conv-avatar group' : 'conv-avatar'}>
                  {destination.kind === 'GROUP' ? <IconUsers size={16} /> : <IconMessageCircle size={16} />}
                </span>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div className="thread-head-title">{destination.name}</div>
                  <div className="muted small">
                    {presence||destination.subtitle}
                    {sendingAccount && ` · ${sendingAccount.name}`}
                  </div>
                </div>

                {embedded&&<button className="wa-chat-info-toggle" aria-label="Search and saved replies" onClick={()=>setShowSearch(v=>!v)}><WhatsAppIcon name="search"/></button>}
                {embedded&&<button className="wa-chat-info-toggle" onClick={()=>setShowContext(v=>!v)} aria-label="Conversation information"><WhatsAppIcon name="account"/></button>}
                {selected && (
                  <details className={embedded?"wa-thread-actions":"crm-thread-actions"} open={embedded?undefined:true}><summary aria-label="Chat actions"><WhatsAppIcon name="more"/></summary><div>
                    <Badge tone={selected.controlState === 'HUMAN_ACTIVE' ? 'warn' : 'ok'}>
                      {selected.controlState === 'HUMAN_ACTIVE' ? 'Human' : 'Automation'}
                    </Badge>
                    <button disabled={organizing} onClick={()=>void organize(selected.isArchived?'UNARCHIVE':'ARCHIVE',[selected.id])}>{selected.isArchived?'Unarchive':'Archive'}</button>
                    <button disabled={organizing} onClick={()=>void organize('MARK_UNREAD',[selected.id])}>Mark unread</button>
                    {canReadMessages&&<button disabled={organizing} onClick={()=>void markLoadedRead()}>Mark loaded read</button>}
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
                  </div></details>
                )}
              </div>

              {embedded&&showSearch&&<div className="wa-chat-utilities"><input autoFocus aria-label="Search loaded messages" placeholder="Search this chat" value={threadSearch} onChange={e=>setThreadSearch(e.target.value)}/><select aria-label="Insert a saved reply" value="" onChange={e=>{const reply=savedReplies.find(r=>r.id===e.target.value);if(reply)updateDraft(draft?`${draft}\n${reply.body}`:reply.body);}}><option value="">Quick replies</option>{savedReplies.map(reply=><option key={reply.id} value={reply.id}>{reply.title}</option>)}</select><button aria-label="Close chat search" onClick={()=>{setShowSearch(false);setThreadSearch('');}}><WhatsAppIcon name="close"/></button></div>}
              {threadError && (
                <div style={{ padding: 14 }}>
                  <ErrorState
                    message={threadError}
                    onRetry={() => void loadThread(destination)}
                    icon={<IconAlertCircle size={20} />}
                  />
                </div>
              )}
              {readError&&<div className="thread-notice" role="status">Read status could not be saved. Use Mark loaded read to retry.</div>}

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
                    icon={<IconMessageCircle size={20} />}
                  />
                )}

                {olderCursor && <button disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>}
                {thread?.filter(m => !threadSearch || (m.body || '').toLowerCase().includes(threadSearch.toLowerCase())).map((message, index) => {
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
                      {message.id===unreadAnchor&&<div className="thread-unread" role="separator" aria-label="First unread message">Unread messages</div>}
                      <div id={`message-${message.id}`} data-readable-message={message.direction==='INBOUND'?message.id:undefined} className={`msg-row ${message.direction === 'OUTBOUND' ? 'outbound' : 'inbound'}`}>
                        <div className={`msg-bubble${automated ? ' automated' : ''}`} style={{ overflowWrap: 'anywhere' }}>
                          {message.quotedExternalId && <div className="message-quote"><span>Quoted message</span>{(() => { const original = thread?.find(m => m.externalId === message.quotedExternalId||m.id===message.quotedMessageId); return original ? <a href={`#message-${original.id}`}>{original.body?.slice(0, 150) || humanise(original.contentType)}</a> : <small>Original message is outside the loaded history.</small>; })()}</div>}
                          <WhatsAppMessageContent message={message} accountId={sendingAccount?.id??destination.channelAccountId??''}/>
                          <div className="msg-meta">
                            {message.direction === 'INBOUND'
                              ? (message.senderDisplayName ?? 'Customer')
                              : automated
                                ? 'Automated'
                                : 'Support CRM'}
                            {' · '}
                            <RelativeTime value={message.sentAt} />
                            {message.deliveryStatus ? ` · ${humanise(message.deliveryStatus)}` : ''}
                            {canSend && message.externalId && <button className="message-reply" onClick={() => setQuoted(message)} aria-label={`Reply to message from ${message.senderDisplayName || 'sender'}`}>Reply</button>}
                            {embedded&&canSend&&message.externalId&&<details className="wa-message-menu"><summary aria-label="Message actions"><WhatsAppIcon name="more" size={16}/></summary><div>{[['reactMessage','React'],['forwardMessage','Forward'],[message.presentation?.starred?'unstarMessage':'starMessage',message.presentation?.starred?'Unstar':'Star'],...(message.fromAccount?[['updateMessage','Edit'],['revokeMessage','Delete for everyone']]:[]),['deleteMessage','Delete for me'],['readMessage','Mark read'],...(message.contentType==='AUDIO'?[['markMessagePlayed','Mark played']]:[])].map(([operation,label])=><button key={operation} onClick={e=>{e.currentTarget.closest('details')?.removeAttribute('open');setChatTool({operation,message});}}>{label}</button>)}</div></details>}
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
                    <div
                      className={item.state === 'failed' ? 'msg-bubble failed' : 'msg-bubble sending'}
                      style={{ overflowWrap: 'anywhere' }}
                    >
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
                quoted && <div className="composer-quote"><div><strong>Replying to {quoted.senderDisplayName || 'message'}</strong><p>{quoted.body?.slice(0,150) || humanise(quoted.contentType)}</p></div><button aria-label="Cancel quoted reply" onClick={() => setQuoted(null)}>×</button></div>
              )}
              {canSend && !embedded && (
                <div className="composer-tools"><select aria-label="Insert saved reply" value="" onChange={e => { const reply = savedReplies.find(r => r.id === e.target.value); if (reply) updateDraft(draft ? `${draft}\n${reply.body}` : reply.body); }}><option value="">Saved replies…</option>{savedReplies.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select><Link to="/saved-replies" className="small">Manage replies</Link><input aria-label="Search loaded messages" placeholder="Search loaded messages…" value={threadSearch} onChange={e => setThreadSearch(e.target.value)} /></div>
              )}
              {canSend && (
                <div className="thread-compose">
                  {embedded&&<WhatsAppComposerExtras disabled={!sendability.ready} accountId={sendingAccount?.id??destination.channelAccountId??''} phone={destination.externalId} onTool={operation=>setChatTool({operation,message:quoted??undefined})} onEmoji={emoji=>updateDraft(draft+emoji)} onQueued={()=>toast.success('Message queued.')} /> }
                  <textarea
                    rows={2}
                    placeholder={
                      sendability.ready
                        ? 'Type a message…  (Enter to send, Shift+Enter for a new line)'
                        : sendability.reason
                    }
                    value={draft}
                    disabled={!sendability.ready}
                    onChange={(e) => updateDraft(e.target.value)}
                    maxLength={8000}
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
          {embedded&&<button className="wa-close-context" aria-label="Close conversation information" onClick={()=>setShowContext(false)}><WhatsAppIcon name="close"/></button>}
          {!destination ? (
            <div className="info-pane-section">
              <div className="muted small">Select a conversation to see its context.</div>
            </div>
          ) : (
            <>
              <div className="info-pane-section">
                <div className="info-pane-label">{destination.kind === 'GROUP' ? 'Group' : 'Contact'}</div>
                <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{customer?.displayName ?? destination.name}</div>
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
                        <div key={participant.id} className="small" style={{ overflowWrap: 'anywhere' }}>
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

      {chatTool&&destination&&sendingAccount&&<WhatsAppChatTool key={`${destination.key}:${chatTool.operation}:${chatTool.message?.id??''}`} accountId={sendingAccount.id} phone={destination.externalId} operation={chatTool.operation} message={chatTool.message} draft={draft} onClose={()=>setChatTool(null)} onQueued={()=>toast.success('WhatsApp action queued.')}/>}
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
    </section>
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
              icon={<IconInbox size={20} />}
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
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
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
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
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
