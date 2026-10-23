import { io, type Socket } from 'socket.io-client';
import { API_URL } from './client';

/**
 * The single realtime connection.
 *
 * One socket for the whole application, shared by every page — the Phase 1 realtime gateway is the
 * only push channel and there is not a second one (`docs/WHATSAPP_UX_ARCHITECTURE.md` §2).
 * Authentication is the same `httpOnly` session cookie the REST calls use, which is why
 * `withCredentials` is set: the handshake carries the cookie and the server authorises the socket
 * from it. No token is passed in a query string, where it would land in logs.
 */

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    // The `/realtime` namespace, not the default one: connecting to `/` succeeds at the transport
    // level and then silently receives nothing, because the gateway's handlers live here.
    socket = io(`${API_URL}/realtime`, {
      withCredentials: true,
      // The default order — poll first, then upgrade. Forcing websocket first fails outright behind
      // proxies that do not pass an upgrade through, and the failure is silent to the operator.
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
  }
  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}

export interface StatusChangedEvent {
  channelAccountId: string;
  previousState: string | null;
  state: string;
}

export interface QrReadyEvent {
  channelAccountId: string;
  qr: string;
  format: 'image' | 'text';
  expiresAt: string;
}

/**
 * Subscribes to channel status for every account and calls back on each change.
 *
 * The payload carries identifiers and states only — never a QR, never an error detail — so the
 * page refetches the affected row rather than trusting the push to be complete.
 */
export function onChannelStatus(handler: (event: StatusChangedEvent) => void): () => void {
  const client = getSocket();

  const subscribe = () => client.emit('subscribe:channel', {});
  const forward = (payload: StatusChangedEvent) => handler(payload);

  subscribe();
  client.on('connect', subscribe); // rooms are per-connection: rejoin after every reconnect
  client.on('whatsapp.account.status_changed', forward);
  client.on('whatsapp.account.connected', forward);

  return () => {
    client.off('connect', subscribe);
    client.off('whatsapp.account.status_changed', forward);
    client.off('whatsapp.account.connected', forward);
  };
}

export function onWhatsAppPresence(handler:(event:{channelAccountId:string;externalConversationId:string;state:string;recording:boolean})=>void){const client=getSocket();const subscribe=()=>client.emit('subscribe:channel',{});subscribe();client.on('connect',subscribe);client.on('whatsapp.chat.presence',handler);return()=>{client.off('connect',subscribe);client.off('whatsapp.chat.presence',handler);};}

export interface ConversationEvent {
  event: string;
  at: string;
  conversationId?: string;
  [key: string]: unknown;
}

/**
 * Subscribes to conversation activity.
 *
 * Pass a `conversationId` to watch one thread (new messages, takeover, status changes) or omit it
 * to watch the whole inbox (for bumping the list when anything happens anywhere). The payload never
 * carries message content — just identifiers and state — so the handler's job is to refetch, the
 * same pattern `onChannelStatus` uses.
 */
export function onConversationEvent(conversationId: string | null, handler: (event: ConversationEvent) => void): () => void {
  const client = getSocket();
  const events = [
    'conversation.created',
    'conversation.updated',
    'conversation.message_received',
    'conversation.message_sent',
    'conversation.assigned',
    'conversation.takeover_started',
    'conversation.takeover_ended',
    'conversation.resolved',
    'conversation.reopened',
  ];

  const subscribe = () => client.emit('subscribe:conversation', conversationId ? { conversationId } : {});
  let timer:ReturnType<typeof setTimeout>|undefined;
  const forward=(payload:ConversationEvent)=>{if(conversationId&&payload.conversationId!==conversationId)return;if(timer)clearTimeout(timer);timer=setTimeout(()=>handler(payload),120);};

  subscribe();
  client.on('connect', subscribe);
  events.forEach((event) => client.on(event, forward));

  return () => {
    client.off('connect', subscribe);
    if(timer)clearTimeout(timer);
    events.forEach((event) => client.off(event, forward));
  };
}

/**
 * Subscribes to the pairing code for ONE account.
 *
 * A QR is a credential — whoever scans it pairs a device to the customer's WhatsApp — so the server
 * delivers it to a private per-account room that requires `channels.manage` to join, rather than to
 * the channel fan-out. The subscription is re-sent on reconnect because room membership does not
 * survive a dropped socket, and it is torn down as soon as the dialog closes.
 */
export function onPairingCode(
  channelAccountId: string,
  handlers: { onQr: (event: QrReadyEvent) => void; onCleared: () => void },
): () => void {
  const client = getSocket();

  const subscribe = () => client.emit('subscribe:qr', { channelAccountId });
  const onQr = (payload: QrReadyEvent) => {
    if (payload.channelAccountId === channelAccountId) handlers.onQr(payload);
  };
  const onCleared = (payload: { channelAccountId: string }) => {
    if (payload.channelAccountId === channelAccountId) handlers.onCleared();
  };

  subscribe();
  client.on('connect', subscribe);
  client.on('whatsapp.account.qr_ready', onQr);
  client.on('whatsapp.account.qr_cleared', onCleared);

  return () => {
    client.off('connect', subscribe);
    client.off('whatsapp.account.qr_ready', onQr);
    client.off('whatsapp.account.qr_cleared', onCleared);
  };
}
