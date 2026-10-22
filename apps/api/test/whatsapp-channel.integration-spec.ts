import request from 'supertest';
import { Repository } from 'typeorm';
import { RedisService } from '../src/common/redis/redis.service';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { ChannelAccountService } from '../src/modules/channel/channel-account.service';
import { ChannelConnectionState } from '../src/modules/channel/channel-connection';
import { ChannelAccount } from '../src/modules/channel/entities/channel-account.entity';
import { ChannelConnectionEvent } from '../src/modules/channel/entities/channel-connection-event.entity';
import { Channel, ChannelKey } from '../src/modules/channel/entities/channel.entity';
import { WhatsAppAutomationGuard } from '../src/modules/channel/whatsapp/whatsapp-automation.guard';
import { WhatsAppChannelAdapter } from '../src/modules/channel/whatsapp/whatsapp.adapter';
import { ProviderEvent, ProviderEventStatus } from '../src/modules/ingestion/entities/provider-event.entity';
import { IngestionService } from '../src/modules/ingestion/ingestion.service';
import { Group } from '../src/modules/groups/entities/group.entity';
import { GroupParticipant } from '../src/modules/groups/entities/group-participant.entity';
import { GroupSyncService } from '../src/modules/groups/group-sync.service';
import { InboundProcessor } from '../src/modules/messaging/inbound.processor';
import { Message } from '../src/modules/messaging/entities/message.entity';
import { OutboundMessage } from '../src/modules/messaging/entities/outbound-message.entity';
import { MessageService } from '../src/modules/messaging/message.service';
import { OutboundProcessor } from '../src/modules/messaging/outbound.processor';
import { DeliveryService } from '../src/modules/messaging/delivery.service';
import {
  DeliveryStatus,
  MessageClassification,
  MessageDirection,
  ParticipantType,
} from '../src/modules/messaging/message-types';
import { MetricsService } from '../src/common/metrics/metrics.service';
import { TeamIdentityService } from '../src/modules/team/team-identity.service';
import { OpenWaStub } from './openwa-stub';
import { closeTestApp, createTestApp, resetDatabase, type TestContext } from './setup';

/** The operator-chosen session NAME — what POST /api/sessions is given. */
const SESSION = 'test-session';
/**
 * The gateway-assigned session UUID.
 *
 * Fixed rather than random so assertions can name it. The distinction from SESSION is the whole
 * point of this pair: the real gateway rejects the NAME on every `{sessionId}` route with
 * `400 "Validation failed (uuid is expected)"`, which is the Phase 2 defect real-gateway
 * validation exposed.
 */
const SESSION_UUID = '11111111-2222-4333-8444-555555555555';

/**
 * Phase 2 acceptance criteria, exercised end to end against a real Postgres, a real Redis, and a
 * stub gateway that speaks the contracts transcribed from `gateway/` source.
 *
 * No real WhatsApp account is involved (brief §22).
 */
describe('WhatsApp channel (integration)', () => {
  let ctx: TestContext;
  let stub: OpenWaStub;

  let accounts: ChannelAccountService;
  let adapter: WhatsAppChannelAdapter;
  let ingestion: IngestionService;
  let messageService: MessageService;
  let delivery: DeliveryService;
  let groupSync: GroupSyncService;
  let teamIdentities: TeamIdentityService;
  let inboundProcessor: InboundProcessor;
  let outboundProcessor: OutboundProcessor;
  let crypto: CryptoService;

  let accountRepo: Repository<ChannelAccount>;
  let eventRepo: Repository<ProviderEvent>;
  let messageRepo: Repository<Message>;
  let outboundRepo: Repository<OutboundMessage>;
  let groupRepo: Repository<Group>;
  let participantRepo: Repository<GroupParticipant>;
  let connectionEvents: Repository<ChannelConnectionEvent>;

  let account: ChannelAccount;
  let webhookSecret: string;

  beforeAll(async () => {
    stub = new OpenWaStub();
    const baseUrl = await stub.start();
    // Set before the app is built — OpenWaClient reads and validates it at construction.
    process.env.OPENWA_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = 'stub-api-key';

    ctx = await createTestApp();

    accounts = ctx.app.get(ChannelAccountService);
    adapter = ctx.app.get(WhatsAppChannelAdapter);
    ingestion = ctx.app.get(IngestionService);
    messageService = ctx.app.get(MessageService);
    delivery = ctx.app.get(DeliveryService);
    groupSync = ctx.app.get(GroupSyncService);
    teamIdentities = ctx.app.get(TeamIdentityService);
    inboundProcessor = ctx.app.get(InboundProcessor);
    outboundProcessor = ctx.app.get(OutboundProcessor);
    crypto = ctx.app.get(CryptoService);

    // The harness boots in worker mode, so the REAL BullMQ consumers are live. Pausing them lets
    // each test drive `process()` deterministically; without this the live worker and the manual
    // call both handle the same job and the message goes out twice — which would look like a
    // duplicate-send bug in the product rather than a race in the test.
    await inboundProcessor.worker.pause(true);
    await outboundProcessor.worker.pause(true);

    accountRepo = ctx.dataSource.getRepository(ChannelAccount);
    eventRepo = ctx.dataSource.getRepository(ProviderEvent);
    messageRepo = ctx.dataSource.getRepository(Message);
    outboundRepo = ctx.dataSource.getRepository(OutboundMessage);
    groupRepo = ctx.dataSource.getRepository(Group);
    participantRepo = ctx.dataSource.getRepository(GroupParticipant);
    connectionEvents = ctx.dataSource.getRepository(ChannelConnectionEvent);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    await stub.stop();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    // These tests reuse one recipient across cases. Database truncation does not reset Redis quotas.
    const redis = ctx.app.get(RedisService);
    if (process.env.REDIS_KEY_PREFIX !== 'support-crm-test') throw new Error('Refusing to clear non-test rate limits.');
    let cursor = '0';
    do {
      const page = await redis.getClient().scan(cursor, 'MATCH', redis.key('ratelimit', '*'), 'COUNT', 100);
      cursor = page[0];
      if (page[1].length) await redis.getClient().del(...page[1]);
    } while (cursor !== '0');
    stub.reset();
    ctx.app.get(MetricsService).reset();

    await ctx.dataSource
      .getRepository(Channel)
      .save({ key: ChannelKey.WHATSAPP, name: 'WhatsApp', isEnabled: true, adapterKey: 'openwa' });

    account = await accounts.register({
      channelKey: ChannelKey.WHATSAPP,
      externalName: SESSION,
      label: 'Test account',
    });
    // The gateway assigns the session id; the stub models the same name→uuid split the real
    // gateway uses, which is what the Phase 2 stub failed to do.
    await accountRepo.update(account.id, { externalId: SESSION_UUID });
    account = await accounts.findOne(account.id);

    // Provision a webhook secret the way `connect` does, so signature verification is exercised.
    webhookSecret = crypto.generateToken(32);
    await accounts.setWebhook(account.id, 'wh_1', adapter.encryptWebhookSecret(account.id, webhookSecret));
    account = await accounts.findOne(account.id);
  });

  /** Delivers a signed webhook exactly as the gateway would. */
  async function deliverWebhook(
    payload: Record<string, unknown>,
    options: { secret?: string; retryCount?: number } = {},
  ) {
    const { body, headers } = OpenWaStub.signWebhook(payload, options.secret ?? webhookSecret, {
      retryCount: options.retryCount,
    });
    return request(ctx.app.getHttpServer())
      .post(`/api/v1/channels/whatsapp/webhook/${account.id}`)
      .set(headers)
      .send(body);
  }

  const incomingMessage = (overrides: Record<string, unknown> = {}) => ({
    id: 'WA_MSG_1',
    from: '8801711223344@c.us',
    to: `${SESSION}@c.us`,
    chatId: '8801711223344@c.us',
    body: 'MikroTik unreachable',
    type: 'chat',
    timestamp: Math.floor(Date.now() / 1000),
    fromMe: false,
    isGroup: false,
    ...overrides,
  });

  /** Runs the inbound worker for whatever is currently RECEIVED, without needing a live BullMQ tick. */
  async function drainInbound(): Promise<void> {
    const pending = await eventRepo.find({ where: { status: ProviderEventStatus.RECEIVED } });
    for (const event of pending) {
      await inboundProcessor.process({
        data: { providerEventId: event.id, channelAccountId: event.channelAccountId, eventType: event.eventType },
      } as never);
    }
  }

  // === criterion 1, 3: account representation and normalized state ==========================

  describe('account and connection state', () => {
    it('represents a WhatsApp account in Support CRM', async () => {
      expect(account.channelKey).toBe(ChannelKey.WHATSAPP);
      expect(account.externalName).toBe(SESSION);
      expect(account.externalId).toBe(SESSION_UUID);
      expect(account.status).toBe(ChannelConnectionState.DISCONNECTED);
      expect(account.ownershipEnabled).toBe(true);
    });

    it('rejects a session id that could traverse gateway URL paths', async () => {
      for (const bad of ['../admin', 'a b', 'x', 'sess/../../etc']) {
        await expect(
          accounts.register({ channelKey: ChannelKey.WHATSAPP, externalName: bad, label: 'x' }),
        ).rejects.toThrow();
      }
    });

    it('maps the gateway lifecycle into our normalized states and persists each transition', async () => {
      stub.addSession(SESSION, SESSION_UUID, { status: 'created' });

      const state = await adapter.connect(account.id);
      // The stub's start() reports qr_ready, exactly as the real gateway does for a fresh session.
      expect(state.status).toBe(ChannelConnectionState.QR_REQUIRED);

      await accounts.recordState(account, state.status, { source: 'ADMIN_ACTION' as never });
      const updated = await accounts.findOne(account.id);
      expect(updated.status).toBe(ChannelConnectionState.QR_REQUIRED);

      const history = await connectionEvents.find({ where: { channelAccountId: account.id } });
      expect(history.some((e) => e.state === ChannelConnectionState.QR_REQUIRED)).toBe(true);
    });

    it('records no history row when a poll re-observes the same state', async () => {
      // Health polling runs every minute; a row per poll would bury the real transitions.
      const before = await connectionEvents.count({ where: { channelAccountId: account.id } });
      await accounts.recordState(account, ChannelConnectionState.DISCONNECTED, { source: 'GATEWAY_POLL' as never });
      await accounts.recordState(account, ChannelConnectionState.DISCONNECTED, { source: 'GATEWAY_POLL' as never });
      expect(await connectionEvents.count({ where: { channelAccountId: account.id } })).toBe(before);
    });

    it('reports UNKNOWN rather than guessing when the gateway is unreachable', async () => {
      stub.addSession(SESSION, SESSION_UUID, { status: 'ready' });
      stub.failNextRequests = 5;
      await expect(adapter.getAccountState(account.id)).rejects.toThrow();
    });
  });

  // === criterion 13: distributed locking =====================================================

  it('serialises concurrent session-lifecycle operations', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const op = () =>
      accounts
        .withSessionLock(account.id, 'connect', async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 150));
          concurrent--;
          return 'ok';
        })
        .catch((error: Error) => error.message);

    const results = await Promise.all([op(), op(), op()]);

    expect(maxConcurrent).toBe(1);
    // The losers get a clear conflict rather than silently queueing behind the winner.
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => typeof r === 'string' && r.includes('already running'))).toHaveLength(2);
  });

  // === criterion 4, 5: secure webhook ingestion and idempotency ==============================

  describe('webhook ingestion', () => {
    it('accepts a correctly signed delivery and queues it', async () => {
      const response = await deliverWebhook(
        OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, duplicate: false });

      const events = await eventRepo.find();
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe(ProviderEventStatus.RECEIVED);
      expect(events[0].eventType).toBe('message.received');
    });

    it('rejects a forged signature and creates nothing', async () => {
      const response = await deliverWebhook(
        OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()),
        { secret: 'not-the-real-secret' },
      );

      expect(response.status).toBe(401);
      expect(await eventRepo.count()).toBe(0);
      expect(await messageRepo.count()).toBe(0);
    });

    it('rejects an unsigned delivery', async () => {
      const payload = OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage());
      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/channels/whatsapp/webhook/${account.id}`)
        .set('content-type', 'application/json')
        .send(JSON.stringify(payload));

      expect(response.status).toBe(401);
      expect(await eventRepo.count()).toBe(0);
    });

    it('rejects a body altered after signing', async () => {
      const payload = OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage());
      const { body, headers } = OpenWaStub.signWebhook(payload, webhookSecret);
      const tampered = body.replace('MikroTik unreachable', 'Send money to attacker');

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/channels/whatsapp/webhook/${account.id}`)
        .set(headers)
        .send(tampered);

      expect(response.status).toBe(401);
      expect(await messageRepo.count()).toBe(0);
    });

    it('rejects a replayed delivery from outside the freshness window', async () => {
      const payload = OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage());
      payload.timestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Signed correctly over the old timestamp — the signature is valid, the delivery is stale.
      expect((await deliverWebhook(payload)).status).toBe(401);
      expect(await eventRepo.count()).toBe(0);
    });

    it('rejects an envelope whose sessionId does not match the verifying account', async () => {
      const payload = OpenWaStub.envelope('message.received', 'some-other-session', incomingMessage());
      expect((await deliverWebhook(payload)).status).toBe(401);
    });

    it('rejects a delivery for an unknown account without revealing that it is unknown', async () => {
      const payload = OpenWaStub.envelope('message.received', 'never-registered', incomingMessage());
      const { body, headers } = OpenWaStub.signWebhook(payload, webhookSecret);

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/channels/whatsapp/webhook/${account.id}`)
        .set(headers)
        .send(body);

      expect(response.status).toBe(401);
      // Identical to a bad-signature response — no enumeration oracle.
      expect(response.body.message).toBe('Webhook verification failed');
    });

    it('refuses to verify when no webhook secret is provisioned', async () => {
      await accountRepo.update(account.id, { webhookSecretEncrypted: null });
      expect(
        (await deliverWebhook(OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()))).status,
      ).toBe(401);
    });

    it('is idempotent — the same event delivered five times yields one message', async () => {
      // The gateway's own docs warn a queue failure can double-POST with the same idempotency key.
      const payload = OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage());

      const responses = [];
      for (let i = 0; i < 5; i++) responses.push(await deliverWebhook(payload, { retryCount: i }));

      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(responses.filter((r) => r.body.duplicate)).toHaveLength(4);
      expect(await eventRepo.count()).toBe(1);

      await drainInbound();
      expect(await messageRepo.count()).toBe(1);
    });

    it('is idempotent under a concurrent burst', async () => {
      const payload = OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage());
      const results = await Promise.all(Array.from({ length: 8 }, () => deliverWebhook(payload)));

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await eventRepo.count()).toBe(1);
    });

    it('enforces idempotency at the database level, not only in the service', async () => {
      await deliverWebhook(OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()));
      const existing = await eventRepo.findOneOrFail({ where: {} });

      await expect(
        ctx.dataSource.query(
          `INSERT INTO provider_events ("channelAccountId", "providerIdempotencyKey", "eventType")
           VALUES ($1, $2, $3)`,
          [account.id, existing.providerIdempotencyKey, 'message.received'],
        ),
      ).rejects.toThrow();
    });

    it('records but does not process events for an unowned account', async () => {
      await accounts.setOwnership(account.id, false, null);

      const response = await deliverWebhook(
        OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()),
      );
      expect(response.status).toBe(200);

      const event = await eventRepo.findOneOrFail({ where: {} });
      expect(event.status).toBe(ProviderEventStatus.IGNORED);

      await drainInbound();
      expect(await messageRepo.count()).toBe(0);
    });

    it('records an event we do not subscribe to as IGNORED', async () => {
      const response = await deliverWebhook(
        OpenWaStub.envelope('presence.update', SESSION_UUID, { id: 'p1' }),
      );
      expect(response.status).toBe(200);
      expect((await eventRepo.findOneOrFail({ where: {} })).status).toBe(ProviderEventStatus.IGNORED);
    });

    it('nulls the raw payload once its retention window passes, keeping the row', async () => {
      await deliverWebhook(OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()));
      const stored = await eventRepo.findOneOrFail({ where: {} });
      await eventRepo.update(stored.id, { payloadRetainedUntil: new Date(Date.now() - 1000) });

      expect(await ingestion.purgeExpiredPayloads()).toBe(1);

      const event = await eventRepo.findOneOrFail({ where: {} });
      expect(event.rawPayload).toBeNull();
      // The row survives — deleting it would let an old redelivery be processed again.
      expect(event.providerIdempotencyKey).toBeTruthy();
    });
  });

  // === criterion 6: normalized inbound messages ==============================================

  describe('inbound message normalization', () => {
    it('persists a normalized direct message', async () => {
      await deliverWebhook(OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()));
      await drainInbound();

      const message = await messageRepo.findOneOrFail({ where: {} });
      expect(message.externalId).toBe('WA_MSG_1');
      expect(message.direction).toBe(MessageDirection.INBOUND);
      expect(message.senderPhone).toBe('8801711223344');
      expect(message.body).toBe('MikroTik unreachable');
      expect(message.externalGroupId).toBeNull();
      expect(message.providerEventId).toBeTruthy();
    });

    it('classifies an unknown sender as UNKNOWN, never as a customer by default', async () => {
      // Brief §8: a participant is not automatically a customer.
      await deliverWebhook(OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()));
      await drainInbound();
      expect((await messageRepo.findOneOrFail({ where: {} })).classification).toBe(
        MessageClassification.UNKNOWN,
      );
    });

    it('classifies a registered team member’s message as TEAM_MESSAGE', async () => {
      await teamIdentities.create({
        channelKey: ChannelKey.WHATSAPP,
        phone: '+880 1711-223344',
        displayName: 'Support Exec',
      });

      await deliverWebhook(OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()));
      await drainInbound();

      expect((await messageRepo.findOneOrFail({ where: {} })).classification).toBe(
        MessageClassification.TEAM_MESSAGE,
      );
    });

    it('classifies the account’s own message as BOT_MESSAGE — the loop guard', async () => {
      await deliverWebhook(
        OpenWaStub.envelope('message.sent', SESSION_UUID, incomingMessage({ id: 'WA_OUT_1', fromMe: true })),
      );
      await drainInbound();

      const message = await messageRepo.findOneOrFail({ where: {} });
      expect(message.classification).toBe(MessageClassification.BOT_MESSAGE);
      expect(message.direction).toBe(MessageDirection.OUTBOUND);
      expect(message.fromAccount).toBe(true);
    });

    it('classifies a monitored group’s unknown sender as a customer', async () => {
      const group = await groupRepo.save(
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: '1203630432-1609459200@g.us',
          name: 'ABC ISP Support',
          monitoringState: 'MONITORED' as never,
        }),
      );

      await deliverWebhook(
        OpenWaStub.envelope(
          'message.received',
          SESSION_UUID,
          incomingMessage({
            id: 'WA_GRP_1',
            from: group.externalId,
            chatId: group.externalId,
            author: '8801711223344@c.us',
            isGroup: true,
          }),
        ),
      );
      await drainInbound();

      const message = await messageRepo.findOneOrFail({ where: {} });
      expect(message.classification).toBe(MessageClassification.CUSTOMER_MESSAGE);
      // Attributed to the author, not the group.
      expect(message.senderExternalId).toBe('8801711223344@c.us');
      expect(message.groupId).toBe(group.id);
    });

    it('persists media metadata without downloading the media', async () => {
      await deliverWebhook(
        OpenWaStub.envelope(
          'message.received',
          SESSION_UUID,
          incomingMessage({
            id: 'WA_IMG_1',
            type: 'image',
            body: 'see attached',
            media: { mimetype: 'image/jpeg', filename: '../../../etc/passwd', sizeBytes: 4096 },
          }),
        ),
      );
      await drainInbound();

      const message = await messageRepo.findOneOrFail({ where: {}, relations: ['attachments'] });
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0].mimeType).toBe('image/jpeg');
      // Path traversal stripped.
      expect(message.attachments[0].filename).toBe('passwd');
      expect(message.attachments[0].storageRef).toBeNull();
    });

    it('links a reply to the quoted message when it is known', async () => {
      await deliverWebhook(OpenWaStub.envelope('message.received', SESSION_UUID, incomingMessage()));
      await drainInbound();
      const first = await messageRepo.findOneOrFail({ where: { externalId: 'WA_MSG_1' } });

      await deliverWebhook(
        OpenWaStub.envelope(
          'message.received',
          SESSION_UUID,
          incomingMessage({ id: 'WA_MSG_2', body: 'still broken', quotedMessage: { id: 'WA_MSG_1', body: '' } }),
        ),
      );
      await drainInbound();

      const reply = await messageRepo.findOneOrFail({ where: { externalId: 'WA_MSG_2' } });
      expect(reply.quotedMessageId).toBe(first.id);
    });

    it('persists a reply whose quoted message predates tracking', async () => {
      await deliverWebhook(
        OpenWaStub.envelope(
          'message.received',
          SESSION_UUID,
          incomingMessage({ id: 'WA_MSG_3', quotedMessage: { id: 'NEVER_SEEN', body: '' } }),
        ),
      );
      await drainInbound();

      const message = await messageRepo.findOneOrFail({ where: {} });
      expect(message.quotedExternalId).toBe('NEVER_SEEN');
      expect(message.quotedMessageId).toBeNull();
    });
  });

  // === criterion 7, 8: group and participant synchronization =================================

  describe('group synchronization', () => {
    beforeEach(() => {
      // The stub 404s on an unknown session, exactly as the real gateway does. `phone` is what the
      // account uses to recognise itself among participants — the session NAME is not its identity.
      stub.addSession(SESSION, SESSION_UUID, {
        status: 'ready',
        phone: '8801999999999',
        pushName: 'Support Bot',
      });
      stub.groups.set(SESSION_UUID, [
        { id: 'g1@g.us', name: 'ABC ISP Support' },
        { id: 'g2@g.us', name: 'XYZ Networks' },
      ]);
      stub.groupDetails.set(`${SESSION_UUID}:g1@g.us`, {
        id: 'g1@g.us',
        name: 'ABC ISP Support',
        description: 'Support group',
        owner: '8801999999999@c.us',
        isAnnounce: false,
        participants: [
          { id: '8801711223344@c.us', number: '8801711223344', name: 'Customer A', isAdmin: false, isSuperAdmin: false },
          { id: '8801888888888@c.us', number: '8801888888888', name: 'Support Exec', isAdmin: true, isSuperAdmin: false },
          { id: '8801999999999@c.us', number: '8801999999999', name: 'Bot', isAdmin: false, isSuperAdmin: false },
        ],
      });
    });

    it('synchronizes the group list', async () => {
      const result = await groupSync.syncGroups(account);

      expect(result.discovered).toBe(2);
      expect(result.created).toBe(2);
      expect(await groupRepo.count()).toBe(2);
    });

    it('creates groups unmonitored with AI and automation off', async () => {
      // A newly discovered group must take no part in support until an operator says so.
      await groupSync.syncGroups(account);
      const group = await groupRepo.findOneOrFail({ where: { externalId: 'g1@g.us' } });

      expect(group.monitoringState).toBe('UNMONITORED');
      expect(group.aiEnabled).toBe(false);
      expect(group.automationEnabled).toBe(false);
    });

    it('never resets operator configuration on a resync', async () => {
      await groupSync.syncGroups(account);
      const group = await groupRepo.findOneOrFail({ where: { externalId: 'g1@g.us' } });
      await groupRepo.update(group.id, { monitoringState: 'MONITORED' as never, aiEnabled: true });

      await groupSync.syncGroups(account);

      const after = await groupRepo.findOneOrFail({ where: { id: group.id } });
      expect(after.monitoringState).toBe('MONITORED');
      expect(after.aiEnabled).toBe(true);
    });

    it('deactivates a group that disappears, rather than deleting it', async () => {
      await groupSync.syncGroups(account);
      stub.groups.set(SESSION_UUID, [{ id: 'g1@g.us', name: 'ABC ISP Support' }]);

      const result = await groupSync.syncGroups(account);

      expect(result.deactivated).toBe(1);
      const gone = await groupRepo.findOneOrFail({ where: { externalId: 'g2@g.us' } });
      expect(gone.isActive).toBe(false);
    });

    it('pages through the gateway rather than requesting everything at once', async () => {
      stub.groups.set(
        SESSION_UUID,
        Array.from({ length: 450 }, (_, i) => ({ id: `bulk${i}@g.us`, name: `Group ${i}` })),
      );

      const result = await groupSync.syncGroups(account);
      expect(result.discovered).toBe(450);

      const listCalls = stub.calls.filter((c) => c.path.endsWith('/groups') && c.method === 'GET');
      expect(listCalls.length).toBeGreaterThan(1);
    });

    it('synchronizes participants and marks team members and the account', async () => {
      // Establish the account's own identity the way connect() does, from the gateway session.
      const state = await adapter.getAccountState(account.id);
      await accounts.recordState(account, state.status, {
        source: 'GATEWAY_POLL' as never,
        accountPhone: state.accountPhone,
      });
      account = await accounts.findOne(account.id);

      await groupSync.syncGroups(account);
      await teamIdentities.create({
        channelKey: ChannelKey.WHATSAPP,
        phone: '8801888888888',
        displayName: 'Support Exec',
      });

      const group = await groupRepo.findOneOrFail({ where: { externalId: 'g1@g.us' } });
      await groupSync.syncParticipants(account, group.id, 'g1@g.us');

      const participants = await participantRepo.find({ where: { groupId: group.id } });
      expect(participants).toHaveLength(3);

      const team = participants.find((p) => p.phone === '8801888888888')!;
      expect(team.participantType).toBe(ParticipantType.TEAM_MEMBER);
      expect(team.role).toBe('ADMIN');
      expect(team.teamMemberIdentityId).toBeTruthy();

      const self = participants.find((p) => p.phone === '8801999999999')!;
      expect(self.participantType).toBe(ParticipantType.ACCOUNT);

      // The critical negative: an unrecognised participant is UNKNOWN, never CUSTOMER (brief §8).
      const unknown = participants.find((p) => p.phone === '8801711223344')!;
      expect(unknown.participantType).toBe(ParticipantType.UNKNOWN);
    });

    it('deactivates a departed participant but keeps the row for attribution', async () => {
      await groupSync.syncGroups(account);
      const group = await groupRepo.findOneOrFail({ where: { externalId: 'g1@g.us' } });
      await groupSync.syncParticipants(account, group.id, 'g1@g.us');

      const detail = stub.groupDetails.get(`${SESSION_UUID}:g1@g.us`)!;
      detail.participants = (detail.participants as unknown[]).slice(0, 1);
      await groupSync.syncParticipants(account, group.id, 'g1@g.us');

      const all = await participantRepo.find({ where: { groupId: group.id } });
      expect(all).toHaveLength(3);
      expect(all.filter((p) => p.isActive)).toHaveLength(1);
    });
  });

  // === criterion 10, 11, 12: outbound through the abstraction ================================

  describe('outbound messaging', () => {
    beforeEach(async () => {
      stub.addSession(SESSION, SESSION_UUID, { status: 'ready' });
      await accounts.recordState(account, ChannelConnectionState.CONNECTED, {
        source: 'ADMIN_ACTION' as never,
        capabilities: {
          canSendText: true,
          canSendMedia: true,
          canSendDocument: true,
          canReply: true,
          canReact: true,
          canEdit: true,
          canDelete: true,
          canPin: true,
          canReadGroupMembers: true,
          canAddGroupMember: true,
          canRemoveGroupMember: true,
          canPromoteGroupMember: true,
          canBroadcast: false,
          canReceiveDeliveryStatus: true,
          canReceiveReadStatus: true,
        },
      });
      account = await accounts.findOne(account.id);
    });

    it('queues rather than sending inline', async () => {
      const row = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'Hello from Support CRM',
      });

      expect(row.status).toBe(DeliveryStatus.QUEUED);
      // Nothing reached the gateway during the request.
      expect(stub.sentMessages).toHaveLength(0);
    });

    it('sends through the adapter when the worker processes it', async () => {
      const row = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'Hello from Support CRM',
      });

      await outboundProcessor.process({ data: { outboundMessageId: row.id } } as never);

      expect(stub.sentMessages).toHaveLength(1);
      expect(stub.sentMessages[0].path).toBe('send-text');
      expect(stub.sentMessages[0].body.text).toBe('Hello from Support CRM');

      const after = await outboundRepo.findOneOrFail({ where: { id: row.id } });
      expect(after.status).toBe(DeliveryStatus.SENT);
      expect(after.externalMessageId).toBeTruthy();
      expect(after.messageId).toBeTruthy();
    });

    it('uses the reply endpoint when quoting', async () => {
      const row = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'Try this',
        quotedExternalId: 'WA_MSG_1',
      });
      await outboundProcessor.process({ data: { outboundMessageId: row.id } } as never);

      expect(stub.sentMessages[0].path).toBe('reply');
      expect(stub.sentMessages[0].body.quotedMessageId).toBe('WA_MSG_1');
    });

    it('is idempotent on the supplied key', async () => {
      const first = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'Once only',
        idempotencyKey: 'reply-42',
      });
      const second = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'Once only',
        idempotencyKey: 'reply-42',
      });

      expect(second.id).toBe(first.id);
      expect(await outboundRepo.count()).toBe(1);
    });

    it('does not resend when a queue job is redelivered', async () => {
      const row = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'At most once',
      });

      await outboundProcessor.process({ data: { outboundMessageId: row.id } } as never);
      await outboundProcessor.process({ data: { outboundMessageId: row.id } } as never);

      // The "only QUEUED may send" guard — otherwise at-least-once delivery becomes twice-sent.
      expect(stub.sentMessages).toHaveLength(1);
    });

    it('refuses to queue while the account is not connected', async () => {
      await accounts.recordState(account, ChannelConnectionState.DISCONNECTED, { source: 'SYSTEM' as never });
      await expect(
        messageService.send({
          channelAccountId: account.id,
          externalConversationId: '8801711223344@c.us',
          body: 'nope',
        }),
      ).rejects.toThrow(/CONNECTED/);
    });

    it('refuses to queue for an unowned account', async () => {
      await accounts.setOwnership(account.id, false, null);
      await expect(
        messageService.send({
          channelAccountId: account.id,
          externalConversationId: '8801711223344@c.us',
          body: 'nope',
        }),
      ).rejects.toThrow(/not owned/i);
    });

    it('cancels a queued message when the emergency stop engages before dispatch', async () => {
      const row = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'queued before the stop',
      });

      await ctx.app
        .get(require('../src/modules/settings/settings.service').SettingsService)
        .set('emergency.outgoing_messages_stopped', true, { valueType: 'boolean' as never });

      await outboundProcessor.process({ data: { outboundMessageId: row.id } } as never);

      const after = await outboundRepo.findOneOrFail({ where: { id: row.id } });
      expect(after.status).toBe(DeliveryStatus.CANCELLED);
      expect(stub.sentMessages).toHaveLength(0);
    });

    it('records a gateway rejection as a failure with its reason', async () => {
      stub.sendFailureStatus = 400;
      const row = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'will be rejected',
      });

      await outboundProcessor.process({ data: { outboundMessageId: row.id } } as never);

      const after = await outboundRepo.findOneOrFail({ where: { id: row.id } });
      expect(after.status).toBe(DeliveryStatus.FAILED);
      expect(after.failureReason).toMatch(/Gateway rejected/);
    });

    it('enforces the outbound rate limit by deferring, not failing', async () => {
      const settings = ctx.app.get(require('../src/modules/settings/settings.service').SettingsService);
      await settings.set('channel.rate_limit.conversation_per_minute', 1, { valueType: 'number' as never });

      const first = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'first',
      });
      await outboundProcessor.process({ data: { outboundMessageId: first.id } } as never);

      const second = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'second',
      });
      await expect(
        outboundProcessor.process({ data: { outboundMessageId: second.id } } as never),
      ).rejects.toThrow(/Deferred/);

      const after = await outboundRepo.findOneOrFail({ where: { id: second.id } });
      // Deferred, not failed — the message is still wanted, just not yet.
      expect(after.status).toBe(DeliveryStatus.QUEUED);
      expect(after.scheduledAt.getTime()).toBeGreaterThan(Date.now());
      expect(stub.sentMessages).toHaveLength(1);
    });
  });

  // === criterion 12: normalized delivery status ==============================================

  describe('delivery status', () => {
    async function sentMessage(): Promise<OutboundMessage> {
      stub.addSession(SESSION, SESSION_UUID, { status: 'ready' });
      await accounts.recordState(account, ChannelConnectionState.CONNECTED, {
        source: 'ADMIN_ACTION' as never,
        capabilities: { canSendText: true } as never,
      });

      const row = await messageService.send({
        channelAccountId: account.id,
        externalConversationId: '8801711223344@c.us',
        body: 'track me',
      });
      await outboundProcessor.process({ data: { outboundMessageId: row.id } } as never);
      return outboundRepo.findOneOrFail({ where: { id: row.id } });
    }

    it('advances through the normalized delivery states', async () => {
      const row = await sentMessage();

      await delivery.applyReceipt(account.id, row.externalMessageId!, DeliveryStatus.DELIVERED);
      expect((await outboundRepo.findOneOrFail({ where: { id: row.id } })).status).toBe(
        DeliveryStatus.DELIVERED,
      );

      await delivery.applyReceipt(account.id, row.externalMessageId!, DeliveryStatus.READ);
      expect((await outboundRepo.findOneOrFail({ where: { id: row.id } })).status).toBe(DeliveryStatus.READ);
    });

    it('ignores an out-of-order receipt rather than regressing', async () => {
      const row = await sentMessage();
      await delivery.applyReceipt(account.id, row.externalMessageId!, DeliveryStatus.READ);

      const applied = await delivery.applyReceipt(
        account.id,
        row.externalMessageId!,
        DeliveryStatus.DELIVERED,
      );

      expect(applied).toBe(false);
      expect((await outboundRepo.findOneOrFail({ where: { id: row.id } })).status).toBe(DeliveryStatus.READ);
    });

    it('applies a receipt arriving over the webhook', async () => {
      const row = await sentMessage();

      await deliverWebhook(
        OpenWaStub.envelope('message.ack', SESSION_UUID, {
          id: row.externalMessageId,
          messageId: row.externalMessageId,
          status: 'delivered',
        }),
      );
      await drainInbound();

      expect((await outboundRepo.findOneOrFail({ where: { id: row.id } })).status).toBe(
        DeliveryStatus.DELIVERED,
      );
    });

    it('ignores a receipt for a message we did not send', async () => {
      // The account also sends messages from a phone; those receipts are not ours to apply.
      expect(await delivery.applyReceipt(account.id, 'NEVER_SENT', DeliveryStatus.READ)).toBe(false);
    });

    it('fails a send that was never acknowledged', async () => {
      const row = await sentMessage();
      await outboundRepo.update(row.id, {
        status: DeliveryStatus.SENDING,
        lastAttemptAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      expect(await delivery.reconcileStalledSends()).toBe(1);

      const after = await outboundRepo.findOneOrFail({ where: { id: row.id } });
      expect(after.status).toBe(DeliveryStatus.FAILED);
      expect(after.failureReason).toMatch(/may or may not have been delivered/);
    });
  });

  // === criterion 16: gateway automation is never used ========================================

  describe('gateway automation safety', () => {
    it('reports safe when the gateway holds no enabled rules', async () => {
      stub.addSession(SESSION, SESSION_UUID, { status: 'ready' });
      const guard = await ctx.app.get(WhatsAppAutomationGuard).check(SESSION_UUID);

      expect(guard.safe).toBe(true);
      expect(guard.activeRuleCount).toBe(0);
    });

    it('detects an enabled gateway autoreply rule and refuses', async () => {
      stub.addSession(SESSION, SESSION_UUID, { status: 'ready' });
      stub.automationRules.set(SESSION_UUID, [{ id: 'r1', name: 'Auto greeting', enabled: true }]);

      const guard = await ctx.app.get(WhatsAppAutomationGuard).check(SESSION_UUID);

      expect(guard.safe).toBe(false);
      expect(guard.activeRuleCount).toBe(1);
      expect(guard.ruleNames).toEqual(['Auto greeting']);
      expect(guard.detail).toMatch(/duplicate and contradictory/);
    });

    it('ignores a disabled rule', async () => {
      stub.addSession(SESSION, SESSION_UUID, { status: 'ready' });
      stub.automationRules.set(SESSION_UUID, [{ id: 'r1', name: 'Disabled rule', enabled: false }]);

      expect((await ctx.app.get(WhatsAppAutomationGuard).check(SESSION_UUID)).safe).toBe(true);
    });

    it('treats an unverifiable gateway as unsafe, never as safe', async () => {
      stub.addSession(SESSION, SESSION_UUID, { status: 'ready' });
      stub.failNextRequests = 10;

      const guard = await ctx.app.get(WhatsAppAutomationGuard).check(SESSION_UUID);
      expect(guard.safe).toBe(false);
      expect(guard.activeRuleCount).toBeNull();
    });

    it('never creates a gateway automation rule during any operation', async () => {
      stub.addSession(SESSION, SESSION_UUID, { status: 'created' });
      await adapter.connect(account.id);
      await adapter.provisionWebhook(account, 'http://localhost/webhook');
      stub.groups.set(SESSION_UUID, [{ id: 'g1@g.us', name: 'G' }]);
      await groupSync.syncGroups(account);

      const writes = stub.calls.filter(
        (c) => c.path.includes('automation-rules') && c.method !== 'GET',
      );
      expect(writes).toEqual([]);
    });
  });

  // === criterion 19: secrets stay encrypted ==================================================

  it('stores the webhook secret encrypted and never returns it', async () => {
    const row = await accountRepo.findOneOrFail({ where: { id: account.id } });

    expect(row.webhookSecretEncrypted).toBeTruthy();
    expect(row.webhookSecretEncrypted).not.toContain(webhookSecret);
    expect(row.webhookSecretEncrypted!.startsWith('v1:')).toBe(true);
    // Decryptable only with the right AAD context — a row copied to another account will not open.
    expect(adapter.decryptWebhookSecret(row)).toBe(webhookSecret);
    expect(adapter.decryptWebhookSecret({ ...row, id: 'another-account' } as never)).toBeNull();
  });
});
