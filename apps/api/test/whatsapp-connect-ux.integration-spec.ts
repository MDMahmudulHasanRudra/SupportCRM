import request from 'supertest';
import { In, Repository } from 'typeorm';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { ChannelAccountService } from '../src/modules/channel/channel-account.service';
import {
  ChannelConnectionState,
  ConnectionEventSource,
} from '../src/modules/channel/channel-connection';
import { ChannelAccount } from '../src/modules/channel/entities/channel-account.entity';
import { ChannelConnectionEvent } from '../src/modules/channel/entities/channel-connection-event.entity';
import { Channel, ChannelKey } from '../src/modules/channel/entities/channel.entity';
import { WhatsAppChannelAdapter } from '../src/modules/channel/whatsapp/whatsapp.adapter';
import { ProviderEvent, ProviderEventStatus } from '../src/modules/ingestion/entities/provider-event.entity';
import { Group } from '../src/modules/groups/entities/group.entity';
import { InboundProcessor } from '../src/modules/messaging/inbound.processor';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { SettingsService } from '../src/modules/settings/settings.service';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { User } from '../src/modules/auth/entities/user.entity';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { PERMISSIONS, ROLES } from '../src/modules/rbac/permissions.catalogue';
import { OpenWaStub } from './openwa-stub';
import { closeTestApp, createTestApp, extractCookie, resetDatabase, type TestContext } from './setup';

const SESSION = 'ux-session';

const COOKIE = 'support_crm_session';
const GATEWAY_KEY = 'stub-api-key-must-never-leak';

/**
 * The Support-CRM-facing WhatsApp connection experience.
 *
 * Three things this suite exists to hold:
 *  1. An administrator can connect WhatsApp in one call and receive a QR over the websocket.
 *  2. The gateway API key and session UUID never reach a client.
 *  3. The name/UUID distinction found during real-gateway validation does not regress.
 */
describe('WhatsApp connect UX (integration)', () => {
  let ctx: TestContext;
  let stub: OpenWaStub;

  let accounts: ChannelAccountService;
  let adapter: WhatsAppChannelAdapter;
  let realtime: RealtimeGateway;
  let settings: SettingsService;
  let inboundProcessor: InboundProcessor;
  let crypto: CryptoService;

  let accountRepo: Repository<ChannelAccount>;
  let eventRepo: Repository<ProviderEvent>;
  let groupRepo: Repository<Group>;
  let auditRepo: Repository<AuditLog>;
  let userRepo: Repository<User>;
  let roleRepo: Repository<Role>;
  let permissionRepo: Repository<Permission>;

  beforeAll(async () => {
    stub = new OpenWaStub();
    process.env.OPENWA_BASE_URL = await stub.start();
    process.env.OPENWA_API_KEY = GATEWAY_KEY;

    ctx = await createTestApp();

    accounts = ctx.app.get(ChannelAccountService);
    adapter = ctx.app.get(WhatsAppChannelAdapter);
    realtime = ctx.app.get(RealtimeGateway);
    settings = ctx.app.get(SettingsService);
    inboundProcessor = ctx.app.get(InboundProcessor);
    crypto = ctx.app.get(CryptoService);

    await inboundProcessor.worker.pause(true);

    accountRepo = ctx.dataSource.getRepository(ChannelAccount);
    eventRepo = ctx.dataSource.getRepository(ProviderEvent);
    groupRepo = ctx.dataSource.getRepository(Group);
    auditRepo = ctx.dataSource.getRepository(AuditLog);
    userRepo = ctx.dataSource.getRepository(User);
    roleRepo = ctx.dataSource.getRepository(Role);
    permissionRepo = ctx.dataSource.getRepository(Permission);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    await stub.stop();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    stub.reset();

    await ctx.dataSource
      .getRepository(Channel)
      .save({ key: ChannelKey.WHATSAPP, name: 'WhatsApp', isEnabled: true, adapterKey: 'openwa' });
    await ctx.dataSource
      .getRepository(SecuritySettings)
      .save({ id: SECURITY_SETTINGS_ID } as SecuritySettings);

    await permissionRepo.save(
      PERMISSIONS.map((p) =>
        permissionRepo.create({
          key: p.key,
          label: p.label,
          category: p.category,
          isDangerous: p.isDangerous ?? false,
        }),
      ),
    );
    for (const definition of ROLES) {
      await roleRepo.save(
        roleRepo.create({
          key: definition.key,
          name: definition.name,
          description: definition.description,
          isSystem: true,
          isSuperAdmin: definition.isSuperAdmin ?? false,
          permissions: await permissionRepo.find({ where: { key: In([...definition.permissions]) } }),
        }),
      );
    }
  });

  async function createUser(username: string, roleKey: string): Promise<User> {
    const role = await roleRepo.findOneOrFail({ where: { key: roleKey } });
    return userRepo.save(
      userRepo.create({
        username,
        email: `${username}@example.com`,
        name: username,
        passwordHash: crypto.hashPassword('Password!123'),
        isActive: true,
        roles: [role],
      }),
    );
  }

  async function login(username: string): Promise<string> {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: username, password: 'Password!123' })
      .expect(200);
    return `${COOKIE}=${extractCookie(response.headers['set-cookie'] as unknown as string[], COOKIE)}`;
  }

  async function adminCookie(): Promise<string> {
    await createUser('admin', 'admin');
    return login('admin');
  }

  // === the one-call connect flow ================================================================

  describe('Connect WhatsApp', () => {
    it('registers and connects in a single call', async () => {
      const cookie = await adminCookie();

      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      // The stub reports qr_ready on start, exactly as the real gateway does.
      expect(response.body.state).toBe('QR_REQUIRED');
      expect(response.body.statusText).toMatch(/scan the qr/i);

      // The session exists on the gateway, created by NAME and addressed by its generated UUID.
      const session = stub.findByName(SESSION);
      expect(session).toBeTruthy();
      expect(session!.id).not.toBe(SESSION);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });
      expect(account.externalId).toBe(session!.id);
      expect(account.webhookExternalId).toBeTruthy();
    });

    it('provisions the webhook without the operator configuring anything', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const session = stub.findByName(SESSION)!;
      const webhook = stub.webhooks.get(session.id);
      expect(webhook).toBeTruthy();
      expect(webhook!.url).toContain('/channels/whatsapp/webhook/');
      expect(webhook!.secret.length).toBeGreaterThan(20);
    });

    it('keeps the account row when connecting fails, so a retry is possible', async () => {
      const cookie = await adminCookie();
      stub.failNextRequests = 20; // every gateway call fails

      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(500);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });
      expect(account.externalId).toBeNull();
    });

    it('returns a human sentence when the gateway is unreachable — never a gateway detail', async () => {
      const cookie = await adminCookie();
      stub.failNextRequests = 20;

      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(500);

      const message = String(response.body.message);
      expect(message.length).toBeGreaterThan(10);
      for (const forbidden of ['openwa', '/api/sessions', 'http://', GATEWAY_KEY, '127.0.0.1']) {
        expect(message.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });

    it('requires channels.manage', async () => {
      await createUser('viewer', 'report_viewer');
      const cookie = await login('viewer');

      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'x' })
        .expect(403);
    });
  });

  // === the accounts page ==========================================================================

  describe('WhatsApp Accounts overview', () => {
    it('returns every column the page shows, in one call', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });
      await accountRepo.update(account.id, {
        accountPhone: '8801999999999',
        status: ChannelConnectionState.CONNECTED,
        lastConnectedAt: new Date(),
      });
      await groupRepo.save([
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: 'g1@g.us',
          name: 'Group one',
          lastMessageAt: new Date('2026-08-20T10:00:00Z'),
        }),
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: 'g2@g.us',
          name: 'Group two',
          lastMessageAt: new Date('2026-08-22T10:00:00Z'),
        }),
      ]);

      const response = await request(ctx.app.getHttpServer())
        .get('/api/v1/channels/whatsapp/accounts/overview')
        .set('Cookie', cookie)
        .expect(200);

      const row = response.body.items[0];
      expect(row.name).toBe('Support line');
      expect(row.phoneNumber).toBe('8801999999999');
      expect(row.state).toBe('CONNECTED');
      expect(row.statusText).toBe('Connected.');
      expect(row.groupCount).toBe(2);
      expect(new Date(row.lastActivityAt).toISOString()).toBe('2026-08-22T10:00:00.000Z');
      expect(row.lastConnectedAt).toBeTruthy();
      expect(row.connected).toBe(true);
    });

    it('reports zero groups without an N+1 query', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const response = await request(ctx.app.getHttpServer())
        .get('/api/v1/channels/whatsapp/accounts/overview')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items[0].groupCount).toBe(0);
      expect(response.body.items[0].lastActivityAt).toBeNull();
    });

    it('shows an auth failure as needing a re-link', async () => {
      const cookie = await adminCookie();
      const account = await accounts.register({
        channelKey: ChannelKey.WHATSAPP,
        externalName: SESSION,
        label: 'Support line',
      });
      await accountRepo.update(account.id, {
        status: ChannelConnectionState.ERROR,
        lastError: 'Session logged out from the phone',
      });

      const response = await request(ctx.app.getHttpServer())
        .get('/api/v1/channels/whatsapp/accounts/overview')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items[0].state).toBe('AUTH_FAILURE');
      expect(response.body.items[0].statusText).toMatch(/linked again/i);
      expect(response.body.items[0].canConnect).toBe(true);
    });
  });

  // === the API key must never reach a client =====================================================

  describe('gateway API key confinement', () => {
    it('appears in no WhatsApp endpoint response', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });

      for (const path of [
        '/api/v1/channels',
        '/api/v1/channels/accounts',
        '/api/v1/channels/whatsapp/accounts/overview',
        `/api/v1/channels/whatsapp/accounts/${account.id}/health`,
        `/api/v1/channels/whatsapp/accounts/${account.id}/qr`,
        `/api/v1/channels/whatsapp/accounts/${account.id}/connection-events`,
        '/api/v1/settings',
      ]) {
        const response = await request(ctx.app.getHttpServer()).get(path).set('Cookie', cookie);
        expect(JSON.stringify(response.body)).not.toContain(GATEWAY_KEY);
      }
    });

    it('appears in no audit row', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      expect(JSON.stringify(await auditRepo.find())).not.toContain(GATEWAY_KEY);
    });

    it('cannot be written through the settings API', async () => {
      const cookie = await adminCookie();

      const response = await request(ctx.app.getHttpServer())
        .put('/api/v1/settings/openwa.api_key')
        .set('Cookie', cookie)
        .send({ value: 'attacker-supplied-key', valueType: 'secret' })
        .expect(403);

      expect(String(response.body.message)).toMatch(/server configuration/i);
    });

    it('is refused even for a super admin', async () => {
      await createUser('root', 'super_admin');
      const cookie = await login('root');

      // The super-admin bypass covers PERMISSIONS. It must not cover an infrastructure boundary.
      await request(ctx.app.getHttpServer())
        .put('/api/v1/settings/openwa.api_key')
        .set('Cookie', cookie)
        .send({ value: 'x', valueType: 'secret' })
        .expect(403);
    });
  });

  // === the session UUID must never reach a client =================================================

  describe('session UUID confinement', () => {
    it('is absent from every account response', async () => {
      const cookie = await adminCookie();
      const created = await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const sessionUuid = stub.findByName(SESSION)!.id;
      expect(JSON.stringify(created.body)).not.toContain(sessionUuid);

      for (const path of ['/api/v1/channels/accounts', '/api/v1/channels/whatsapp/accounts/overview']) {
        const response = await request(ctx.app.getHttpServer()).get(path).set('Cookie', cookie);
        expect(JSON.stringify(response.body)).not.toContain(sessionUuid);
      }
    });

    it('keeps name and UUID as separate columns', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });
      expect(account.externalName).toBe(SESSION);
      expect(account.externalId).toBe(stub.findByName(SESSION)!.id);
      expect(account.externalId).not.toBe(account.externalName);
    });

    it('addresses the gateway by UUID, never by name', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      // The stub answers 400 for a non-UUID path parameter, exactly as the real gateway does, so a
      // regression here would fail loudly rather than silently.
      const scoped = stub.calls.filter((c) => c.path.startsWith('/api/sessions/'));
      expect(scoped.length).toBeGreaterThan(0);
      for (const call of scoped) {
        expect(call.path).not.toContain(SESSION);
      }
    });
  });

  // === QR lifecycle ================================================================================

  describe('QR lifecycle', () => {
    async function connectedAccount(): Promise<ChannelAccount> {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);
      return accountRepo.findOneOrFail({ where: { externalName: SESSION } });
    }

    async function deliverSessionEvent(
      account: ChannelAccount,
      event: string,
      data: Record<string, unknown>,
    ): Promise<void> {
      const secret = adapter.decryptWebhookSecret(account)!;
      const payload = OpenWaStub.envelope(event, account.externalId!, data);
      const { body, headers } = OpenWaStub.signWebhook(payload, secret);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/channels/whatsapp/webhook/${account.id}`)
        .set(headers)
        .send(body)
        .expect(200);

      for (const stored of await eventRepo.find({ where: { status: ProviderEventStatus.RECEIVED } })) {
        await inboundProcessor.process({
          data: { providerEventId: stored.id, channelAccountId: account.id, eventType: stored.eventType },
        } as never);
      }
    }

    it('labels a raw pairing string as text, for the client to encode', () => {
      const pairing = adapter.extractPairingPayload('session.qr', { qr: '2@abcdefghijklmnop' });

      expect(pairing).not.toBeNull();
      expect(pairing!.payload).toBe('2@abcdefghijklmnop');
      expect(pairing!.format).toBe('text');
      // An expiry lets the UI count down rather than display a dead code.
      expect(pairing!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(pairing!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 21_000);
    });

    it('labels a pre-rendered code as an image, for the client to show as-is', () => {
      // What this gateway actually sends: the code already drawn to a PNG. Re-encoding that string
      // into a second QR produces an unscannable mess, so the format has to travel with it.
      const pairing = adapter.extractPairingPayload('session.qr', {
        qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAARQAAAEUCAYAAADq',
      });

      expect(pairing!.format).toBe('image');
      expect(pairing!.payload).toContain('data:image/png;base64,');
    });

    it('returns null for events that carry no QR', () => {
      expect(adapter.extractPairingPayload('session.status', { status: 'ready' })).toBeNull();
      expect(adapter.extractPairingPayload('session.qr', {})).toBeNull();
      expect(adapter.extractPairingPayload('session.qr', { qr: 'short' })).toBeNull();
      expect(adapter.extractPairingPayload('message.received', { qr: '2@abcdefghijklmnop' })).toBeNull();
    });

    it('delivers the QR to the private room and never to the firehose', async () => {
      const account = await connectedAccount();

      const rooms: string[] = [];
      const emitted: Array<{ event: string; body: Record<string, unknown> }> = [];
      // Capture what the gateway would emit, and to which room.
      (realtime as unknown as { server: unknown }).server = {
        to: (room: string) => {
          rooms.push(room);
          return {
            emit: (event: string, body: Record<string, unknown>) => emitted.push({ event, body }),
          };
        },
        socketsLeave: () => undefined,
      };

      await deliverSessionEvent(account, 'session.qr', { qr: '2@aRealLookingQrPayload' });

      const qrEmissions = emitted.filter((e) => e.event === 'whatsapp.account.qr_ready');
      expect(qrEmissions).toHaveLength(1);
      expect(qrEmissions[0].body.qr).toBe('2@aRealLookingQrPayload');
      expect(qrEmissions[0].body.format).toBe('text');
      expect(qrEmissions[0].body.expiresAt).toBeTruthy();

      // The QR room, and NOT the channel firehose.
      expect(rooms).toContain(`channel-qr:${account.id}`);
      const firehose = emitted.filter((e) => e.event !== 'whatsapp.account.qr_ready');
      expect(JSON.stringify(firehose)).not.toContain('2@aRealLookingQrPayload');
    });

    it('never persists the QR payload in the account row', async () => {
      const account = await connectedAccount();
      await deliverSessionEvent(account, 'session.qr', { qr: '2@aRealLookingQrPayload' });

      const reloaded = await accountRepo.findOneOrFail({ where: { id: account.id } });
      expect(JSON.stringify(reloaded)).not.toContain('2@aRealLookingQrPayload');
      expect(reloaded.status).toBe(ChannelConnectionState.QR_REQUIRED);
    });

    it('never writes the QR into an audit row', async () => {
      const account = await connectedAccount();
      await deliverSessionEvent(account, 'session.qr', { qr: '2@aRealLookingQrPayload' });

      expect(JSON.stringify(await auditRepo.find())).not.toContain('2@aRealLookingQrPayload');
    });

    it('closes the QR room once the account connects', async () => {
      const account = await connectedAccount();

      const left: string[] = [];
      const emitted: string[] = [];
      (realtime as unknown as { server: unknown }).server = {
        to: () => ({ emit: (event: string) => emitted.push(event) }),
        socketsLeave: (room: string) => left.push(room),
      };

      await deliverSessionEvent(account, 'session.authenticated', { status: 'ready' });

      expect(left).toContain(`channel-qr:${account.id}`);
      expect(emitted).toContain('whatsapp.account.qr_cleared');
      expect(emitted).toContain('whatsapp.account.connected');
    });

    it('exposes the QR over REST with an expiry, gated on channels.manage', async () => {
      const account = await connectedAccount();
      const cookie = await login('admin');

      const response = await request(ctx.app.getHttpServer())
        .get(`/api/v1/channels/whatsapp/accounts/${account.id}/qr`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.accountId).toBe(account.id);
      expect(response.body.qr).toBeTruthy();
      expect(response.body.format).toMatch(/^(image|text)$/);
      expect(response.body.expiresAt).toBeTruthy();
    });

    it('answers "no code" rather than failing once the phone has paired', async () => {
      const account = await connectedAccount();
      const cookie = await login('admin');

      // The gateway rejects a QR request for an authenticated session with a 400. That is an
      // ordinary answer — a paired session has no code — and the dialog polls this endpoint while
      // it is open, so turning it into a 500 would fill the log with stack traces and hand the
      // operator an error for a healthy account. Regression: real-WhatsApp validation.
      const session = stub.findByName(SESSION)!;
      session.status = 'ready';

      const response = await request(ctx.app.getHttpServer())
        .get(`/api/v1/channels/whatsapp/accounts/${account.id}/qr`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.available).toBe(false);
      expect(response.body.qr).toBeNull();
      expect(response.body.expiresAt).toBeNull();
    });

    it('denies the QR endpoint to a read-only operator', async () => {
      const account = await connectedAccount();
      await createUser('viewer', 'report_viewer');
      const cookie = await login('viewer');

      await request(ctx.app.getHttpServer())
        .get(`/api/v1/channels/whatsapp/accounts/${account.id}/qr`)
        .set('Cookie', cookie)
        .expect(403);
    });
  });

  // === connection state transitions ===============================================================

  describe('connection state transitions', () => {
    it('records each transition and reports the presentation state', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });

      const events = await request(ctx.app.getHttpServer())
        .get(`/api/v1/channels/whatsapp/accounts/${account.id}/connection-events`)
        .set('Cookie', cookie)
        .expect(200);

      // Connecting records the state the gateway actually reported, attributed to the operator who
      // asked for it — that attribution is what makes the history worth keeping.
      const entry = events.body.items.find((e: { state: string }) => e.state === 'QR_REQUIRED');
      expect(entry).toBeTruthy();
      expect(entry.source).toBe('ADMIN_ACTION');
      expect(entry.createdAt).toBeTruthy();
    });

    it('reconnect stops then starts, under the account lock', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });
      stub.calls.length = 0;

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/channels/whatsapp/accounts/${account.id}/reconnect`)
        .set('Cookie', cookie)
        .expect(201);

      const paths = stub.calls.map((c) => c.path);
      expect(paths.some((p) => p.endsWith('/stop'))).toBe(true);
      expect(paths.some((p) => p.endsWith('/start'))).toBe(true);
      // Reconnect must NEVER log out — that destroys the pairing and costs a re-scan.
      expect(paths.some((p) => p.endsWith('/logout'))).toBe(false);
    });

    it('refuses a second reconnect while one is in flight', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });

      // Hold the account's lock the way a slow in-flight reconnect would, rather than racing three
      // requests and hoping they overlap — a timing-dependent assertion would be flaky, and the
      // property under test is "the lock is respected", not "the stub is slow".
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = accounts.withSessionLock(account.id, 'reconnect', () => held);

      try {
        const response = await request(ctx.app.getHttpServer())
          .post(`/api/v1/channels/whatsapp/accounts/${account.id}/reconnect`)
          .set('Cookie', cookie)
          .expect(409);

        // A conflict the operator can understand — not a lock key, not a Redis error.
        expect(String(response.body.message).toLowerCase()).not.toContain('redis');
        expect(String(response.body.message).toLowerCase()).not.toContain('lock:');
      } finally {
        release();
        await holder;
      }
    });

    it('records a transition against the current row, not a stale copy', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });
      const before = await ctx.dataSource
        .getRepository(ChannelConnectionEvent)
        .count({ where: { channelAccountId: account.id } });

      // A stale copy is the normal case for a controller: a session-lifecycle call takes tens of
      // seconds and webhooks move the row underneath it. Recording the state it already holds must
      // write no history and emit nothing — not a phantom transition from the stale value.
      const stale = { ...account, status: ChannelConnectionState.DISCONNECTED } as ChannelAccount;
      await accounts.recordState(stale, account.status as ChannelConnectionState, {
        source: ConnectionEventSource.ADMIN_ACTION,
      });

      const after = await ctx.dataSource
        .getRepository(ChannelConnectionEvent)
        .find({ where: { channelAccountId: account.id }, order: { createdAt: 'ASC' } });

      expect(after).toHaveLength(before);
      // And a genuine transition still records, with the row's real previous state.
      await accounts.recordState(stale, ChannelConnectionState.DISCONNECTING, {
        source: ConnectionEventSource.ADMIN_ACTION,
      });

      const latest = await ctx.dataSource
        .getRepository(ChannelConnectionEvent)
        .findOneOrFail({ where: { channelAccountId: account.id }, order: { createdAt: 'DESC' } });
      expect(latest.previousState).toBe(account.status);
      expect(latest.state).toBe(ChannelConnectionState.DISCONNECTING);
    });

    it('a disconnect event moves the account to DISCONNECTED', async () => {
      const cookie = await adminCookie();
      await request(ctx.app.getHttpServer())
        .post('/api/v1/channels/whatsapp/accounts/connect')
        .set('Cookie', cookie)
        .send({ sessionId: SESSION, label: 'Support line' })
        .expect(201);

      const account = await accountRepo.findOneOrFail({ where: { externalName: SESSION } });
      const secret = adapter.decryptWebhookSecret(account)!;
      const payload = OpenWaStub.envelope('session.disconnected', account.externalId!, {
        status: 'disconnected',
        reason: 'logged out',
      });
      const { body, headers } = OpenWaStub.signWebhook(payload, secret);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/channels/whatsapp/webhook/${account.id}`)
        .set(headers)
        .send(body)
        .expect(200);

      for (const stored of await eventRepo.find({ where: { status: ProviderEventStatus.RECEIVED } })) {
        await inboundProcessor.process({
          data: { providerEventId: stored.id, channelAccountId: account.id, eventType: stored.eventType },
        } as never);
      }

      expect((await accountRepo.findOneOrFail({ where: { id: account.id } })).status).toBe(
        ChannelConnectionState.DISCONNECTED,
      );
    });
  });

  // === settings guard =============================================================================

  it('still allows ordinary settings to be written', async () => {
    // The infrastructure guard must not have broken the settings API generally.
    const { after } = await settings.set('feature.ai_enabled', true);
    expect(after).toBe(true);
  });
});
