import { Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AppLogger } from '../../common/logging/app-logger';
import { AuthService } from '../auth/auth.service';
import type { JobStatus } from '../jobs/entities/job.entity';

/**
 * The normalized channel event vocabulary exposed to the admin UI.
 *
 * A closed union so a typo becomes a compile error rather than an event nobody receives.
 */
export type WhatsAppEventName =
  | 'whatsapp.account.status_changed'
  | 'whatsapp.account.connected'
  | 'whatsapp.account.qr_expired'
  | 'whatsapp.message.received'
  | 'whatsapp.message.sent'
  | 'whatsapp.message.delivery_updated'
  | 'whatsapp.group.updated'
  | 'whatsapp.sync.started'
  | 'whatsapp.sync.completed'
  | 'whatsapp.error';

/**
 * Normalized conversation events (Phase 3 brief §12).
 *
 * Ours, not a provider's. A frontend coded against these keeps working when a second channel
 * arrives, which is the point of the whole abstraction.
 */
export type ConversationEventName =
  | 'conversation.created'
  | 'conversation.updated'
  | 'conversation.message_received'
  | 'conversation.message_sent'
  | 'conversation.assigned'
  | 'conversation.takeover_started'
  | 'conversation.takeover_ended'
  | 'conversation.resolved'
  | 'conversation.reopened';

/**
 * Knowledge pipeline events (Phase 4).
 *
 * Identifiers and outcomes only — never chunk text or article bodies. The same rule the other two
 * unions follow: a fan-out channel is the wrong place for content that belongs behind an
 * authorised fetch.
 */
export type KnowledgeEventName =
  | 'knowledge.document.indexing'
  | 'knowledge.document.indexed'
  | 'knowledge.document.failed'
  | 'knowledge.article.published';

/**
 * Decision Engine events (Phase 5).
 *
 * Identifiers, outcomes and reason codes only — never a customer's message, never a generated
 * answer, never a prompt. The same rule the other unions follow: this fans out to every subscribed
 * operator socket, and content belongs behind an authorised fetch.
 */
export type DecisionEventName =
  | 'decision.started'
  | 'decision.completed'
  | 'decision.escalated'
  | 'decision.escalation_resolved'
  | 'decision.failed'
  | 'decision.takeover_expired'
  // Phase 7: the dashboard is the notification channel that cannot fail for an external reason,
  // so it is the one an operator can rely on when WhatsApp is down.
  | 'escalation.raised'
  | 'escalation.executive_notified';

export interface JobProgressEvent {
  jobId: string;
  status: JobStatus;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  progressPercent: number;
}

/**
 * Real-time transport (`PROJECT_SPEC.md` §102, §118).
 *
 * Exists in Phase 1 because §102 forbids aggressive polling, and retrofitting push onto a UI built
 * around polling is a rewrite of the UI. Phase 1 emits job progress; conversation, message,
 * escalation and session events plug into the same gateway in later phases.
 *
 * Authentication uses the same session cookie as the REST API — not a second token scheme. An
 * unauthenticated socket is disconnected immediately rather than left connected but idle, so an
 * anonymous client cannot hold a connection open.
 *
 * Rooms scope delivery. A client subscribing to `job:<id>` receives only that job's events, so a
 * support executive watching one job is not streamed every other job in the system.
 */
@Injectable()
@WebSocketGateway({
  namespace: '/realtime',
  // Origins are restricted by the same config the REST CORS uses; `credentials` is required for
  // the session cookie to be sent with the handshake.
  cors: { origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','), credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new AppLogger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly auth: AuthService) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const secret = this.readSessionCookie(client);
      const user = secret ? await this.auth.resolveSession(secret) : null;

      if (!user) {
        client.emit('error', { message: 'Authentication required' });
        client.disconnect(true);
        return;
      }

      // Stored on the socket so a later subscribe can be authorised without re-reading the cookie.
      client.data.user = { id: user.id, username: user.username, permissions: [...user.permissions] };
      client.join(`user:${user.id}`);
      client.emit('connected', { userId: user.id });
    } catch (error) {
      this.logger.warn('Rejected websocket connection', { error: (error as Error).message });
      client.disconnect(true);
    }
  }

  @SubscribeMessage('subscribe:job')
  handleSubscribeJob(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { jobId?: string },
  ): { subscribed: boolean; jobId?: string } {
    // handleConnection disconnects anonymous sockets, so a message from one should be impossible —
    // check anyway rather than trusting connection-time state to still hold.
    if (!client.data.user) {
      client.disconnect(true);
      return { subscribed: false };
    }
    if (!body?.jobId) return { subscribed: false };

    client.join(`job:${body.jobId}`);
    return { subscribed: true, jobId: body.jobId };
  }

  @SubscribeMessage('unsubscribe:job')
  handleUnsubscribeJob(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { jobId?: string },
  ): { subscribed: boolean } {
    if (body?.jobId) client.leave(`job:${body.jobId}`);
    return { subscribed: false };
  }

  /** Called by the job processor. Safe to call before any client connects. */
  emitJobProgress(event: JobProgressEvent): void {
    this.server?.to(`job:${event.jobId}`).emit('job:progress', event);
  }

  /**
   * Emits a normalized channel event (Phase 2 brief §17).
   *
   * The event NAMES are ours — `whatsapp.message.received`, not the gateway's `message.received`.
   * A frontend coded against a vendor's event vocabulary would have to be rewritten the day the
   * vendor is replaced, which is the coupling the whole channel abstraction exists to avoid.
   *
   * Delivered to the `channel:<id>` room and to a firehose room, so a dashboard can watch one
   * account or all of them. Payloads carry identifiers and state only — never message bodies, QR
   * codes or gateway error internals, because this is a fan-out to every subscribed admin socket
   * and content belongs behind an authorised fetch (`PROJECT_SPEC.md` §110).
   */
  emitWhatsAppEvent(event: WhatsAppEventName, payload: Record<string, unknown>): void {
    if (!this.server) return;
    const body = { event, at: new Date().toISOString(), ...payload };

    const channelAccountId = payload.channelAccountId;
    if (typeof channelAccountId === 'string') {
      this.server.to(`channel:${channelAccountId}`).emit(event, body);
    }
    this.server.to('channel:all').emit(event, body);
  }

  /**
   * Emits a normalized conversation event.
   *
   * Identifiers and state only — never a message body, a customer note or a phone number. This
   * fans out to every subscribed operator socket, and content belongs behind an authorised
   * fetch (`PROJECT_SPEC.md` §110).
   */
  emitConversationEvent(event: ConversationEventName, payload: Record<string, unknown>): void {
    if (!this.server) return;
    const body = { event, at: new Date().toISOString(), ...payload };

    const conversationId = payload.conversationId;
    if (typeof conversationId === 'string') {
      this.server.to(`conversation:${conversationId}`).emit(event, body);
    }
    this.server.to('conversation:all').emit(event, body);
  }

  @SubscribeMessage('subscribe:conversation')
  handleSubscribeConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string },
  ): { subscribed: boolean; room: string | null } {
    if (!client.data.user) {
      client.disconnect(true);
      return { subscribed: false, room: null };
    }

    // Reuses the REST permission the conversation endpoints require, rather than inventing a
    // second authorisation model for the socket (`PROJECT_SPEC.md` §108).
    const permissions: string[] = client.data.user.permissions ?? [];
    if (!permissions.includes('conversations.read')) return { subscribed: false, room: null };

    const room = body?.conversationId ? `conversation:${body.conversationId}` : 'conversation:all';
    client.join(room);
    return { subscribed: true, room };
  }

  /**
   * Emits a Decision Engine event.
   *
   * Broadcast to every operator socket: an escalation is something the whole support team benefits
   * from seeing immediately, and the payload carries ids and reasons rather than content.
   */
  emitDecisionEvent(event: DecisionEventName, payload: Record<string, unknown>): void {
    this.server?.emit(event, { event, at: new Date().toISOString(), ...payload });
  }

  /**
   * Emits a knowledge pipeline event.
   *
   * Broadcast to every operator socket: knowledge is not scoped to a conversation or an account,
   * and an indexing outcome is something the whole team benefits from seeing. Payloads carry ids,
   * counts and statuses only.
   */
  emitKnowledgeEvent(event: KnowledgeEventName, payload: Record<string, unknown>): void {
    this.server?.emit(event, { event, at: new Date().toISOString(), ...payload });
  }

  /**
   * Delivers a pairing QR to the operators watching ONE account.
   *
   * Deliberately not `emitWhatsAppEvent`: that fans out to `channel:all`, and a QR is a
   * credential — anyone holding it can pair a device to the customer's WhatsApp. This goes only
   * to `channel-qr:<id>`, a room that requires `channels.manage` to join, which is the same
   * permission the REST QR endpoint demands.
   *
   * The payload is never persisted, logged or audited (`docs/WHATSAPP_UX_ARCHITECTURE.md` §5).
   */
  emitPairingPayload(
    channelAccountId: string,
    qr: string,
    expiresAt: Date,
    format: 'image' | 'text',
  ): void {
    this.server?.to(`channel-qr:${channelAccountId}`).emit('whatsapp.account.qr_ready', {
      event: 'whatsapp.account.qr_ready',
      at: new Date().toISOString(),
      channelAccountId,
      qr,
      format,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /** Closes the QR room once pairing succeeds, so no stale code lingers in a client. */
  closePairingRoom(channelAccountId: string): void {
    const room = `channel-qr:${channelAccountId}`;
    this.server?.to(room).emit('whatsapp.account.qr_cleared', { channelAccountId });
    this.server?.socketsLeave(room);
  }

  /**
   * Joins the QR room for one account.
   *
   * Gated on `channels.manage`, not `channels.read`: a read-only operator sees the status change
   * to QR_REQUIRED and never receives the payload.
   */
  @SubscribeMessage('subscribe:qr')
  handleSubscribeQr(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelAccountId?: string },
  ): { subscribed: boolean; reason?: string } {
    if (!client.data.user) {
      client.disconnect(true);
      return { subscribed: false };
    }
    if (!body?.channelAccountId) return { subscribed: false, reason: 'channelAccountId is required' };

    const permissions: string[] = client.data.user.permissions ?? [];
    if (!permissions.includes('channels.manage')) {
      return { subscribed: false, reason: 'channels.manage is required to view a pairing code' };
    }

    client.join(`channel-qr:${body.channelAccountId}`);
    return { subscribed: true };
  }

  @SubscribeMessage('subscribe:channel')
  handleSubscribeChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelAccountId?: string },
  ): { subscribed: boolean; room: string | null } {
    if (!client.data.user) {
      client.disconnect(true);
      return { subscribed: false, room: null };
    }

    // Reuses the REST permission the channel endpoints require, rather than inventing a second
    // authorisation model for the socket (`PROJECT_SPEC.md` §108).
    const permissions: string[] = client.data.user.permissions ?? [];
    if (!permissions.includes('channels.read')) {
      return { subscribed: false, room: null };
    }

    const room = body?.channelAccountId ? `channel:${body.channelAccountId}` : 'channel:all';
    client.join(room);
    return { subscribed: true, room };
  }

  /** Parses the raw Cookie header — Socket.IO handshakes do not go through Express middleware. */
  private readSessionCookie(client: Socket): string | null {
    const name = process.env.SESSION_COOKIE_NAME ?? 'support_crm_session';
    const header = client.handshake.headers.cookie;
    if (!header) return null;

    for (const part of header.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) return decodeURIComponent(rest.join('='));
    }
    return null;
  }
}
