import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../../../common/logging/app-logger';
import type {
  OpenWaAutomationRule,
  OpenWaGroupDetail,
  OpenWaGroupSummary,
  OpenWaQrResponse,
  OpenWaSendResult,
  OpenWaSession,
  OpenWaWebhook,
} from './openwa.contracts';

/**
 * The settings key the gateway API key USED to be readable from.
 *
 * It is exported only so `SettingsService` can refuse to write it. The key is infrastructure
 * credential, not application configuration: an administrator with `settings.manage` must not
 * be able to set it, and no API response, websocket payload, audit row or log line may carry it
 * (`docs/WHATSAPP_UX_ARCHITECTURE.md` §3).
 */
export const OPENWA_API_KEY_SETTING = 'openwa.api_key';

export class OpenWaError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`OpenWA ${status} on ${path}`);
    this.name = 'OpenWaError';
  }

  /** 5xx and 429 are worth retrying; a 4xx means the request itself is wrong and will stay wrong. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

/**
 * The HTTP client for the OpenWA gateway.
 *
 * **This is one of exactly two files in the application permitted to know the gateway exists** (the
 * other is the adapter that uses it). Everything else goes through `ChannelAdapter`
 * (`docs/adr/0001` §7, enforced by the ESLint boundary rule).
 *
 * Responsibilities kept deliberately narrow: URL construction, authentication, timeouts, error
 * shaping. No business logic, no database, no normalization — the adapter does that.
 */
/**
 * Timeouts, by what the call actually does.
 *
 * One timeout for every route was wrong, and real-gateway validation proved it: `POST /start`
 * launches a Chromium instance and drives WhatsApp Web to the point of producing a QR, which
 * takes tens of seconds on a healthy host and longer on a loaded one. A 15s cap aborted it every
 * time and surfaced as "the gateway is unreachable" — a misleading message for a gateway that was
 * working exactly as designed.
 *
 * The contract stub answered instantly, so nothing in the test suite could have caught this.
 */
const TIMEOUTS = {
  /** Reads and sends: fast paths where a slow response really does mean something is wrong. */
  default: 15_000,
  /** Session lifecycle: creates or tears down a browser session. Inherently slow. */
  sessionLifecycle: 120_000,
  /** Group listing over thousands of chats — slower than a read, faster than a session start. */
  bulkRead: 60_000,
} as const;

@Injectable()
export class OpenWaClient {
  private readonly logger = new AppLogger(OpenWaClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = OpenWaClient.validateBaseUrl(this.config.getOrThrow<string>('openwa.baseUrl'));
    this.timeoutMs = this.config.get<number>('openwa.timeoutMs', 15_000);
  }

  /**
   * SSRF guard on the configured gateway URL (Phase 2 brief §21).
   *
   * The base URL is operator configuration rather than user input, so this is defence in depth
   * rather than the primary control — but a mistyped or injected value here would make the server
   * issue authenticated requests to somewhere else entirely, and cloud metadata endpoints
   * (169.254.169.254) are the classic target. Rejecting non-HTTP schemes also blocks `file:` and
   * `gopher:` style tricks.
   */
  static validateBaseUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`OPENWA_BASE_URL is not a valid URL: ${raw}`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`OPENWA_BASE_URL must be http or https, got "${url.protocol}"`);
    }
    if (url.hostname === '169.254.169.254' || url.hostname.endsWith('.metadata.internal')) {
      throw new Error('OPENWA_BASE_URL must not point at a cloud metadata endpoint');
    }
    return url.origin + url.pathname.replace(/\/$/, '');
  }

  /**
   * Resolves the API key — from the environment, and only from the environment.
   *
   * It previously also honoured an `openwa.api_key` settings row, which made an infrastructure
   * credential writable by anyone holding `settings.manage`. That path is gone: the key is a
   * deployment concern, `SettingsService` refuses to store it, and this is the one method in the
   * application that can read it.
   *
   * The removal also fixed a real operational trap — a stale settings row silently overriding a
   * correct environment variable, producing 401s with nothing to indicate why.
   */
  private apiKey(): string {
    const key = this.config.get<string>('openwa.apiKey');
    if (!key) {
      // Deliberately says nothing about the gateway itself: this message can reach an operator.
      throw new ServiceUnavailableException(
        'WhatsApp service is not configured on this server. Contact your system administrator.',
      );
    }
    return key;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<T> {
    const apiKey = this.apiKey();
    // AbortSignal.timeout, not a manual race: it actually cancels the socket, where a race would
    // leave the request running and the connection held.
    const signal = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          'X-API-Key': apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The API key is in scope here. It is never included in the log or the thrown message —
      // the path and the transport error are all that is useful anyway (PROJECT_SPEC.md §129).
      this.logger.warn('OpenWA request failed at the transport layer', {
        path,
        method,
        timeoutMs,
        error: message,
      });
      // A timeout and a refused connection are different problems and deserve different messages:
      // "unreachable" sent an operator hunting a network fault when the gateway was simply slow.
      const timedOut = /abort|timeout/i.test(message);
      throw new ServiceUnavailableException(
        timedOut
          ? `The WhatsApp gateway did not respond within ${timeoutMs}ms on ${method} ${path}. ` +
            'It may still be working — check the session status before retrying.'
          : `The WhatsApp gateway is unreachable (${message})`,
      );
    }

    if (!response.ok) {
      // Bounded read: an error body is diagnostic, and an unbounded one from a misbehaving upstream
      // should not be pulled into memory or into a log line.
      const text = (await response.text().catch(() => '')).slice(0, 2000);
      this.logger.warn('OpenWA returned an error', { path, method, status: response.status });
      throw new OpenWaError(response.status, path, text);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OpenWaError(response.status, path, 'gateway returned a non-JSON body');
    }
  }

  // --- sessions ----------------------------------------------------------------------------
  listSessions(): Promise<OpenWaSession[]> {
    return this.request('GET', '/api/sessions');
  }

  getSession(sessionId: string): Promise<OpenWaSession> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  createSession(name: string): Promise<OpenWaSession> {
    return this.request('POST', '/api/sessions', { name }, TIMEOUTS.sessionLifecycle);
  }

  /** Launches a browser session. Minutes, not seconds — see TIMEOUTS. */
  startSession(sessionId: string): Promise<OpenWaSession> {
    return this.request(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/start`,
      undefined,
      TIMEOUTS.sessionLifecycle,
    );
  }

  stopSession(sessionId: string): Promise<OpenWaSession> {
    return this.request(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      undefined,
      TIMEOUTS.sessionLifecycle,
    );
  }

  logoutSession(sessionId: string): Promise<OpenWaSession> {
    return this.request(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/logout`,
      undefined,
      TIMEOUTS.sessionLifecycle,
    );
  }

  /** The returned `qrCode` is credential-equivalent: never log it, never audit it, never store it. */
  getQr(sessionId: string): Promise<OpenWaQrResponse> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/qr`);
  }

  // --- groups ------------------------------------------------------------------------------
  /** Paginated listing. Cheap — returns id and name only, no participants. */
  listGroups(sessionId: string, limit: number, offset: number): Promise<OpenWaGroupSummary[]> {
    const query = `?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
    return this.request(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/groups${query}`,
      undefined,
      TIMEOUTS.bulkRead,
    );
  }

  /** The only call that returns participants — one request per group, hence a batched job. */
  getGroup(sessionId: string, groupId: string): Promise<OpenWaGroupDetail> {
    return this.request(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupId)}`,
      undefined,
      TIMEOUTS.bulkRead,
    );
  }

  // --- messages ----------------------------------------------------------------------------
  sendText(
    sessionId: string,
    payload: { chatId: string; text: string; quotedMessageId?: string; mentions?: string[] },
  ): Promise<OpenWaSendResult> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, payload);
  }

  reply(
    sessionId: string,
    payload: { chatId: string; quotedMessageId: string; text: string; mentions?: string[] },
  ): Promise<OpenWaSendResult> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/messages/reply`, payload);
  }

  sendImage(
    sessionId: string,
    payload: { chatId: string; url?: string; base64?: string; mimetype?: string; filename?: string; caption?: string; quotedMessageId?: string },
  ): Promise<OpenWaSendResult> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-image`, payload);
  }

  sendDocument(
    sessionId: string,
    payload: { chatId: string; url?: string; base64?: string; mimetype?: string; filename?: string; caption?: string; quotedMessageId?: string },
  ): Promise<OpenWaSendResult> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-document`, payload);
  }

  // --- webhooks ----------------------------------------------------------------------------
  listWebhooks(sessionId: string): Promise<OpenWaWebhook[]> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`);
  }

  createWebhook(
    sessionId: string,
    payload: { url: string; events: string[]; secret: string; retryCount?: number },
  ): Promise<OpenWaWebhook> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`, payload);
  }

  deleteWebhook(sessionId: string, webhookId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/sessions/${encodeURIComponent(sessionId)}/webhooks/${encodeURIComponent(webhookId)}`,
    );
  }

  // --- automation rules (READ ONLY) ---------------------------------------------------------
  /**
   * Reads the gateway's own autoreply rules.
   *
   * Support CRM has no method to create, update or enable one, and that omission is deliberate
   * rather than incidental — the gateway's automation engine replies directly to inbound messages,
   * which would bypass the Message Decision Engine and send customers a second, contradictory
   * answer (`docs/adr/0001` §6). This read exists purely so `WhatsAppAutomationGuard` can detect
   * and refuse that configuration.
   */
  listAutomationRules(sessionId: string): Promise<OpenWaAutomationRule[]> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/automation-rules`);
  }
}
