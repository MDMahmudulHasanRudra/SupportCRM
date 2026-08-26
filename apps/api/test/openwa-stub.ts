import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A stub OpenWA gateway for integration tests.
 *
 * **Why a stub and not the real gateway.** The real gateway drives WhatsApp Web through Chromium
 * and only becomes useful once a real WhatsApp account is paired by scanning a QR code. The Phase 2
 * brief (§22) is explicit that automated tests must not connect to a real customer account, and
 * `docs/adr/0001` §12 records that two systems on one account send customers duplicate replies.
 * There is no version of "run the real gateway in CI" that is both meaningful and safe.
 *
 * **What makes this stub trustworthy.** It is not a hand-waved mock: every route, request shape,
 * response shape and header below was transcribed from the vendored source at `gateway/` and is
 * recorded in `docs/adr/0001` §2. It signs webhooks with the same algorithm the gateway uses —
 * `sha256=` + HMAC-SHA256 over the exact serialized body — so the signature verification under test
 * is verifying against a genuinely-produced signature, not one our own code generated.
 *
 * The remaining risk is honest and stated in the Phase 2 report: this proves Support CRM speaks the
 * gateway's documented contract correctly. It does not prove the running gateway matches its own
 * source. That check belongs to a manual pairing against a dedicated test number.
 *
 * ## Corrected after real-gateway validation
 *
 * The first version of this stub keyed sessions by NAME and answered to either the name or the
 * id. That hid a real defect: every `/api/sessions/{sessionId}/…` route on the real gateway
 * validates its parameter as a **UUID**, and answers `400 "Validation failed (uuid is expected)"`
 * for a name. Support CRM was passing the name everywhere, and the whole session lifecycle was
 * broken against the real gateway while every test passed.
 *
 * The stub now enforces the same rule: sessions are keyed by a generated UUID, `name` is a
 * separate lookup used only by `POST /api/sessions`, and a non-UUID path parameter gets the same
 * 400 the real gateway returns. A stub that is more permissive than the system it stands in for
 * is worse than no stub at all.
 */
export interface StubSession {
  /** A UUID, exactly as the real gateway assigns. NOT the name. */
  id: string;
  name: string;
  status: 'created' | 'initializing' | 'qr_ready' | 'authenticating' | 'ready' | 'disconnected' | 'action_required' | 'failed';
  /** A device pairing is stored, so starting this session needs no new QR scan. */
  paired?: boolean;
  phone?: string | null;
  pushName?: string | null;
  lastError?: string | null;
}

export interface StubCall {
  method: string;
  path: string;
  body: unknown;
  apiKey: string | undefined;
}

export class OpenWaStub {
  private server?: Server;
  private port = 0;

  /** Every request the stub received, for asserting what the adapter actually sent. */
  readonly calls: StubCall[] = [];

  /** Keyed by session UUID — the same key the real gateway's routes use. */
  readonly sessions = new Map<string, StubSession>();

  /** Registers a session the way the real gateway does: a caller-chosen name, a generated id. */
  addSession(name: string, id: string, overrides: Partial<StubSession> = {}): StubSession {
    const session: StubSession = { id, name, status: 'created', ...overrides };
    this.sessions.set(id, session);
    return session;
  }

  findByName(name: string): StubSession | undefined {
    return [...this.sessions.values()].find((s) => s.name === name);
  }
  readonly webhooks = new Map<string, { id: string; url: string; secret: string; events: string[] }>();
  /** Gateway-side autoreply rules, so the §13 safety diagnostic can be tested against real data. */
  readonly automationRules = new Map<string, Array<{ id: string; name: string; enabled: boolean }>>();
  readonly groups = new Map<string, Array<{ id: string; name: string }>>();
  readonly groupDetails = new Map<string, Record<string, unknown>>();

  /** Set to make the next N requests fail, to test transport error handling. */
  failNextRequests = 0;
  /** Set to a status to make every send return that HTTP status. */
  sendFailureStatus: number | null = null;

  sentMessages: Array<{ sessionId: string; path: string; body: Record<string, unknown> }> = [];

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body: unknown = undefined;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            body = raw.toString('utf8');
          }
        }

        const url = new URL(req.url ?? '/', 'http://stub');
        this.calls.push({
          method: req.method ?? 'GET',
          path: url.pathname,
          body,
          apiKey: req.headers['x-api-key'] as string | undefined,
        });

        if (this.failNextRequests > 0) {
          this.failNextRequests--;
          res.writeHead(503).end(JSON.stringify({ message: 'gateway unavailable' }));
          return;
        }

        // The real gateway authenticates with X-API-Key on every route.
        if (!req.headers['x-api-key']) {
          res.writeHead(401).end(JSON.stringify({ message: 'missing api key' }));
          return;
        }

        this.route(req.method ?? 'GET', url, body, res);
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  reset(): void {
    this.calls.length = 0;
    this.sentMessages.length = 0;
    this.sessions.clear();
    this.webhooks.clear();
    this.automationRules.clear();
    this.groups.clear();
    this.groupDetails.clear();
    this.failNextRequests = 0;
    this.sendFailureStatus = null;
  }

  /**
   * Signs a payload exactly as the gateway does, and returns the headers it sets.
   * See `gateway/src/modules/webhook/webhook-delivery.service.ts:385-390, 784`.
   */
  static signWebhook(
    payload: Record<string, unknown>,
    secret: string,
    options: { retryCount?: number; deliveryId?: string } = {},
  ): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(payload);
    return {
      body,
      headers: {
        'content-type': 'application/json',
        'x-openwa-event': String(payload.event),
        'x-openwa-idempotency-key': String(payload.idempotencyKey),
        'x-openwa-delivery-id': options.deliveryId ?? String(payload.deliveryId),
        'x-openwa-retry-count': String(options.retryCount ?? 0),
        'x-openwa-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
    };
  }

  /** Builds the envelope shape the gateway wraps every event in (`WebhookPayload`). */
  static envelope(
    event: string,
    sessionId: string,
    data: Record<string, unknown>,
    idempotencyKey?: string,
  ): Record<string, unknown> {
    return {
      event,
      timestamp: new Date().toISOString(),
      sessionId,
      idempotencyKey: idempotencyKey ?? `${event}_${sessionId}_${String(data.id ?? data.messageId ?? 'x')}`,
      deliveryId: `del_${Math.random().toString(36).slice(2)}`,
      data,
    };
  }

  private route(method: string, url: URL, body: unknown, res: import('node:http').ServerResponse): void {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    };

    const segments = url.pathname.split('/').filter(Boolean); // api, sessions, {id}, ...

    if (segments[0] !== 'api') return json(404, { message: 'not found' });

    // POST /api/sessions — the ONLY route that takes a name. Returns a generated UUID.
    if (segments[1] === 'sessions' && segments.length === 2 && method === 'POST') {
      const name = (body as { name: string }).name;
      const clash = this.findByName(name);
      // The real gateway answers 409 on a duplicate name — verified against it.
      if (clash) return json(409, { message: 'session name already exists' });

      const id = randomUUID();
      return json(201, this.addSession(name, id));
    }

    if (segments[1] === 'sessions' && segments.length === 2 && method === 'GET') {
      return json(200, [...this.sessions.values()]);
    }

    const sessionId = segments[2];

    // Every /api/sessions/{sessionId}/… route validates the parameter as a UUID. Passing a NAME
    // yields 400, not 404 — the exact behaviour that exposed the Phase 2 defect.
    if (sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return json(400, { message: 'Validation failed (uuid is expected)', error: 'Bad Request', statusCode: 400 });
    }

    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    // GET /api/sessions/{id}
    if (segments.length === 3 && method === 'GET') {
      return session ? json(200, session) : json(404, { message: 'session not found' });
    }

    if (segments.length === 3 && method === 'DELETE') {
      this.sessions.delete(sessionId);
      return json(204, undefined);
    }

    if (!session) return json(404, { message: 'session not found' });

    const action = segments[3];

    if (action === 'start' && method === 'POST') {
      // A session whose device pairing is still stored comes straight back up — that is what makes
      // an unattended reconnect possible at all, and it is what the real gateway did when the
      // validation session was restarted without a rescan. `paired` models the stored credential.
      session.status = session.paired ? 'ready' : 'qr_ready';
      return json(200, session);
    }
    if (action === 'stop' && method === 'POST') {
      session.status = 'disconnected';
      return json(200, session);
    }
    if (action === 'qr' && method === 'GET') {
      // What the real gateway does once a phone has paired — verbatim, including the status code.
      // Discovered during the real-WhatsApp validation run.
      if (session.status === 'ready' || session.status === 'authenticating') {
        return json(400, {
          message: 'Session is already authenticated, no QR code needed',
          error: 'Bad Request',
          statusCode: 400,
        });
      }
      return json(200, { qrCode: '2@stubQrPayload', status: session.status });
    }

    if (action === 'webhooks') {
      if (method === 'POST') {
        const payload = body as { url: string; secret: string; events: string[] };
        const webhook = {
          id: `wh_${sessionId}`,
          url: payload.url,
          secret: payload.secret,
          events: payload.events,
        };
        this.webhooks.set(sessionId, webhook);
        return json(201, { ...webhook, sessionId, active: true, retryCount: 3, createdAt: '', updatedAt: '' });
      }
      if (method === 'GET') {
        const webhook = this.webhooks.get(sessionId);
        return json(200, webhook ? [{ ...webhook, sessionId, active: true, retryCount: 3 }] : []);
      }
      if (method === 'DELETE') {
        this.webhooks.delete(sessionId);
        return json(204, undefined);
      }
    }

    if (action === 'automation-rules' && method === 'GET') {
      return json(200, this.automationRules.get(sessionId) ?? []);
    }

    if (action === 'groups') {
      if (segments.length === 4 && method === 'GET') {
        const all = this.groups.get(sessionId) ?? [];
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return json(200, all.slice(offset, offset + limit));
      }
      if (segments.length === 5 && method === 'GET') {
        const detail = this.groupDetails.get(`${sessionId}:${decodeURIComponent(segments[4])}`);
        return detail ? json(200, detail) : json(404, { message: 'group not found' });
      }
    }

    if (action === 'messages' && method === 'POST') {
      if (this.sendFailureStatus) {
        return json(this.sendFailureStatus, { message: 'send rejected by gateway' });
      }
      this.sentMessages.push({
        sessionId,
        path: segments.slice(4).join('/'),
        body: body as Record<string, unknown>,
      });
      return json(200, {
        messageId: `WA_${this.sentMessages.length}_${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }

    return json(404, { message: `stub has no route for ${method} ${url.pathname}` });
  }
}
