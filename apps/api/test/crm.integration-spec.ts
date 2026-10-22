import request from 'supertest';
import { Repository } from 'typeorm';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { ChannelAccountService } from '../src/modules/channel/channel-account.service';
import { ChannelConnectionState } from '../src/modules/channel/channel-connection';
import { ChannelAccount } from '../src/modules/channel/entities/channel-account.entity';
import { Channel, ChannelKey } from '../src/modules/channel/entities/channel.entity';
import { WhatsAppChannelAdapter } from '../src/modules/channel/whatsapp/whatsapp.adapter';
import { ProviderEvent, ProviderEventStatus } from '../src/modules/ingestion/entities/provider-event.entity';
import { Group } from '../src/modules/groups/entities/group.entity';
import { InboundProcessor } from '../src/modules/messaging/inbound.processor';
import { Message } from '../src/modules/messaging/entities/message.entity';
import { ConversationService } from '../src/modules/crm/conversation.service';
import { CustomerService } from '../src/modules/crm/customer.service';
import {
  ConversationControlState,
  ConversationKind,
  ConversationStatus,
  StateChangeSource,
  isStatusTransitionAllowed,
  toSpecState,
} from '../src/modules/crm/conversation-states';
import { Conversation } from '../src/modules/crm/entities/conversation.entity';
import { ConversationParticipant } from '../src/modules/crm/entities/conversation-participant.entity';
import {
  ConversationAssignment,
  ConversationStateHistory,
} from '../src/modules/crm/entities/conversation-history.entity';
import {
  CustomerIdentity,
  IdentityMatchState,
} from '../src/modules/crm/entities/customer-identity.entity';
import { Customer } from '../src/modules/crm/entities/customer.entity';
import { SupportTeam } from '../src/modules/crm/entities/customer-metadata.entity';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { User } from '../src/modules/auth/entities/user.entity';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { PERMISSIONS, ROLES } from '../src/modules/rbac/permissions.catalogue';
import { TeamIdentityService } from '../src/modules/team/team-identity.service';
import { OpenWaStub } from './openwa-stub';
import { closeTestApp, createTestApp, extractCookie, resetDatabase, type TestContext } from './setup';
import { In } from 'typeorm';

const SESSION = 'crm-session';
const SESSION_UUID = '99999999-8888-4777-8666-555555555555';
const COOKIE = 'support_crm_session';

/**
 * Phase 3 — the customer and conversation domain, against a real Postgres and Redis.
 *
 * The recurring assertion across this suite: **seeing a phone number never creates a customer.**
 * Every path that could quietly promote an unknown sender is tested for refusing to.
 */
describe('CRM domain (integration)', () => {
  let ctx: TestContext;
  let stub: OpenWaStub;

  let accounts: ChannelAccountService;
  let adapter: WhatsAppChannelAdapter;
  let customers: CustomerService;
  let conversations: ConversationService;
  let teamIdentities: TeamIdentityService;
  let inboundProcessor: InboundProcessor;
  let crypto: CryptoService;

  let accountRepo: Repository<ChannelAccount>;
  let eventRepo: Repository<ProviderEvent>;
  let messageRepo: Repository<Message>;
  let groupRepo: Repository<Group>;
  let customerRepo: Repository<Customer>;
  let identityRepo: Repository<CustomerIdentity>;
  let conversationRepo: Repository<Conversation>;
  let participantRepo: Repository<ConversationParticipant>;
  let historyRepo: Repository<ConversationStateHistory>;
  let assignmentRepo: Repository<ConversationAssignment>;
  let teamRepo: Repository<SupportTeam>;
  let auditRepo: Repository<AuditLog>;
  let userRepo: Repository<User>;
  let roleRepo: Repository<Role>;
  let permissionRepo: Repository<Permission>;

  let account: ChannelAccount;
  let webhookSecret: string;

  beforeAll(async () => {
    stub = new OpenWaStub();
    process.env.OPENWA_BASE_URL = await stub.start();
    process.env.OPENWA_API_KEY = 'stub-api-key';

    ctx = await createTestApp();

    accounts = ctx.app.get(ChannelAccountService);
    adapter = ctx.app.get(WhatsAppChannelAdapter);
    customers = ctx.app.get(CustomerService);
    conversations = ctx.app.get(ConversationService);
    teamIdentities = ctx.app.get(TeamIdentityService);
    inboundProcessor = ctx.app.get(InboundProcessor);
    crypto = ctx.app.get(CryptoService);

    // Drive the processor explicitly; the live worker would race the manual calls.
    await inboundProcessor.worker.pause(true);

    accountRepo = ctx.dataSource.getRepository(ChannelAccount);
    eventRepo = ctx.dataSource.getRepository(ProviderEvent);
    messageRepo = ctx.dataSource.getRepository(Message);
    groupRepo = ctx.dataSource.getRepository(Group);
    customerRepo = ctx.dataSource.getRepository(Customer);
    identityRepo = ctx.dataSource.getRepository(CustomerIdentity);
    conversationRepo = ctx.dataSource.getRepository(Conversation);
    participantRepo = ctx.dataSource.getRepository(ConversationParticipant);
    historyRepo = ctx.dataSource.getRepository(ConversationStateHistory);
    assignmentRepo = ctx.dataSource.getRepository(ConversationAssignment);
    teamRepo = ctx.dataSource.getRepository(SupportTeam);
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

    await seedRbac();

    account = await accounts.register({
      channelKey: ChannelKey.WHATSAPP,
      externalName: SESSION,
      label: 'CRM test account',
    });
    await accountRepo.update(account.id, {
      externalId: SESSION_UUID,
      accountPhone: '8801999999999',
      status: ChannelConnectionState.CONNECTED,
    });

    webhookSecret = crypto.generateToken(32);
    await accounts.setWebhook(account.id, 'wh_1', adapter.encryptWebhookSecret(account.id, webhookSecret));
    account = await accounts.findOne(account.id);

    stub.addSession(SESSION, SESSION_UUID, { status: 'ready', phone: '8801999999999' });
  });

  async function seedRbac(): Promise<void> {
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
  }

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

  const incoming = (overrides: Record<string, unknown> = {}) => ({
    id: `WA_${Math.random().toString(36).slice(2, 10)}`,
    from: '8801711223344@c.us',
    to: '8801999999999@c.us',
    chatId: '8801711223344@c.us',
    body: 'MikroTik unreachable',
    type: 'chat',
    timestamp: Math.floor(Date.now() / 1000),
    fromMe: false,
    isGroup: false,
    ...overrides,
  });

  async function deliver(data: Record<string, unknown>): Promise<void> {
    const payload = OpenWaStub.envelope('message.received', SESSION_UUID, data);
    const { body, headers } = OpenWaStub.signWebhook(payload, webhookSecret);
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/channels/whatsapp/webhook/${account.id}`)
      .set(headers)
      .send(body)
      .expect(200);

    for (const event of await eventRepo.find({ where: { status: ProviderEventStatus.RECEIVED } })) {
      await inboundProcessor.process({
        data: { providerEventId: event.id, channelAccountId: account.id, eventType: event.eventType },
      } as never);
    }
  }

  // === criterion 1, 2, 3: customers and identities ============================================

  describe('customers and identities', () => {
    it('creates a customer independent of any channel contact', async () => {
      const customer = await customers.create({ displayName: 'ABC ISP', primaryPhone: '+880 1711-223344' });

      expect(customer.id).toBeTruthy();
      expect(customer.primaryPhone).toBe('8801711223344'); // normalised to digits
      // No identity is created as a side effect: a customer record is not a channel address.
      expect(await identityRepo.count()).toBe(0);
    });

    it('lets one customer hold several channel identities', async () => {
      const customer = await customers.create({ displayName: 'ABC ISP' });

      const first = await customers.createIdentity({
        channelKey: ChannelKey.WHATSAPP,
        phone: '8801711223344',
        customerId: customer.id,
      });
      const second = await customers.createIdentity({
        channelKey: ChannelKey.WHATSAPP,
        phone: '8801722334455',
        customerId: customer.id,
      });

      expect(first.customerId).toBe(customer.id);
      expect(second.customerId).toBe(customer.id);
      const loaded = await customers.findOne(customer.id);
      expect(loaded.identities).toHaveLength(2);
    });

    it('prevents a duplicate identity on the same channel', async () => {
      await customers.createIdentity({ channelKey: ChannelKey.WHATSAPP, phone: '8801711223344' });
      await expect(
        customers.createIdentity({ channelKey: ChannelKey.WHATSAPP, phone: '8801711223344' }),
      ).rejects.toThrow(/already exists/i);
    });

    it('enforces identity uniqueness at the database level too', async () => {
      await customers.createIdentity({ channelKey: ChannelKey.WHATSAPP, phone: '8801711223344' });
      await expect(
        ctx.dataSource.query(
          `INSERT INTO customer_identities ("channelKey", "externalId", phone) VALUES ($1, $2, $3)`,
          [ChannelKey.WHATSAPP, '8801711223344@c.us', '8801711223344'],
        ),
      ).rejects.toThrow();
    });

    it('creates an identity UNRESOLVED when no customer is named', async () => {
      const identity = await customers.createIdentity({
        channelKey: ChannelKey.WHATSAPP,
        phone: '8801711223344',
      });
      expect(identity.matchState).toBe(IdentityMatchState.UNRESOLVED);
      expect(identity.customerId).toBeNull();
    });

    it('REFUSES an unresolved identity that points at a customer — the database says no', async () => {
      // The central Phase 3 safety rule, enforced by a check constraint rather than by convention.
      const customer = await customers.create({ displayName: 'ABC ISP' });
      await expect(
        ctx.dataSource.query(
          `INSERT INTO customer_identities ("channelKey", "externalId", "customerId", "matchState")
           VALUES ($1, $2, $3, 'UNRESOLVED')`,
          [ChannelKey.WHATSAPP, 'x@c.us', customer.id],
        ),
      ).rejects.toThrow();
    });

    it('proposes CANDIDATE on an exact phone match — never CONFIRMED', async () => {
      const customer = await customers.create({ displayName: 'ABC ISP', primaryPhone: '8801711223344' });
      const identity = await customers.createIdentity({
        channelKey: ChannelKey.WHATSAPP,
        phone: '8801711223344',
      });

      const result = await customers.proposeMatch(identity.id);

      expect(result.proposed).toBe(true);
      expect(result.identity.matchState).toBe(IdentityMatchState.CANDIDATE);
      expect(result.identity.customerId).toBe(customer.id);
    });

    it('refuses to propose when several customers share the number', async () => {
      await customers.create({ displayName: 'Customer A', primaryPhone: '8801711223344' });
      await customers.create({ displayName: 'Customer B', primaryPhone: '8801711223344' });
      const identity = await customers.createIdentity({
        channelKey: ChannelKey.WHATSAPP,
        phone: '8801711223344',
      });

      const result = await customers.proposeMatch(identity.id);

      expect(result.proposed).toBe(false);
      expect(result.reason).toMatch(/share this phone number/);
      expect((await customers.findIdentity(identity.id)).matchState).toBe(IdentityMatchState.UNRESOLVED);
    });

    it('confirms an identity and backfills its existing conversations', async () => {
      await deliver(incoming());
      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      expect(conversation.customerId).toBeNull(); // unattributed until a human confirms

      const identity = await identityRepo.findOneOrFail({ where: {} });
      const customer = await customers.create({ displayName: 'ABC ISP' });

      await customers.confirmIdentity(identity.id, customer.id, null, 'verified by phone');

      const after = await conversationRepo.findOneOrFail({ where: { id: conversation.id } });
      expect(after.customerId).toBe(customer.id);

      const participant = await participantRepo.findOneOrFail({ where: { conversationId: conversation.id } });
      expect(participant.customerId).toBe(customer.id);
      expect(participant.participantType).toBe('CUSTOMER');
    });

    it('never overwrites a conversation already attributed to a different customer', async () => {
      await deliver(incoming());
      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      const other = await customers.create({ displayName: 'Existing customer' });
      await conversationRepo.update(conversation.id, { customerId: other.id });

      const identity = await identityRepo.findOneOrFail({ where: {} });
      const newCustomer = await customers.create({ displayName: 'Newly confirmed' });
      await customers.confirmIdentity(identity.id, newCustomer.id, null);

      const after = await conversationRepo.findOneOrFail({ where: { id: conversation.id } });
      expect(after.customerId).toBe(other.id);
    });

    it('records a rejection and detaches the attribution', async () => {
      await deliver(incoming());
      const identity = await identityRepo.findOneOrFail({ where: {} });
      const customer = await customers.create({ displayName: 'Wrong customer' });
      await customers.confirmIdentity(identity.id, customer.id, null);

      const rejected = await customers.rejectIdentity(identity.id, null, 'not them');

      expect(rejected.matchState).toBe(IdentityMatchState.REJECTED);
      // customerId is KEPT — the record of which customer was ruled out.
      expect(rejected.customerId).toBe(customer.id);
      expect((await conversationRepo.findOneOrFail({ where: {} })).customerId).toBeNull();
    });
  });

  // === criterion 4, 5, 6: conversations and messages ==========================================

  describe('conversations', () => {
    it('creates a DIRECT conversation on the first message and attaches it', async () => {
      await deliver(incoming());

      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      expect(conversation.kind).toBe(ConversationKind.DIRECT);
      expect(conversation.status).toBe(ConversationStatus.OPEN);
      expect(conversation.externalConversationId).toBe('8801711223344@c.us');
      // Safe defaults: nothing becomes eligible for AI or automation by existing.
      expect(conversation.aiEnabled).toBe(false);
      expect(conversation.automationEnabled).toBe(false);

      const message = await messageRepo.findOneOrFail({ where: {} });
      expect(message.conversationId).toBe(conversation.id);
      expect(message.senderIdentityId).toBeTruthy();
    });

    it('reuses the same conversation for later messages in the same chat', async () => {
      await deliver(incoming({ id: 'WA_1' }));
      await deliver(incoming({ id: 'WA_2' }));

      expect(await conversationRepo.count()).toBe(1);
      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      expect(conversation.messageCount).toBe(2);
    });

    it('creates a GROUP conversation with a synced group', async () => {
      const group = await groupRepo.save(
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: '1203630432-1609459200@g.us',
          name: 'ABC ISP Support',
          monitoringState: 'MONITORED' as never,
        }),
      );

      await deliver(
        incoming({
          from: group.externalId,
          chatId: group.externalId,
          author: '8801711223344@c.us',
          isGroup: true,
        }),
      );

      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      expect(conversation.kind).toBe(ConversationKind.GROUP);
      expect(conversation.groupId).toBe(group.id);
      expect(conversation.subject).toBe('ABC ISP Support');
    });

    it('reconciles a conversation recorded before its group was synced (Phase 5L)', async () => {
      // Found by the real-WhatsApp validation, not by a unit test. A group message that arrives
      // before `POST /groups/sync` has created the group row is deliberately stored as DIRECT
      // rather than dropped — but nothing ever revisited that decision, so the conversation stayed
      // `DIRECT` with a null `groupId` forever, and could no longer be found by its group.
      const externalGroupId = '1203630999-1700000000@g.us';

      // 1. A message arrives while the group is unknown.
      await deliver(
        incoming({
          id: 'WA_BEFORE_SYNC',
          from: externalGroupId,
          chatId: externalGroupId,
          author: '8801711223399@c.us',
          isGroup: true,
        }),
      );

      const before = await conversationRepo.findOneOrFail({ where: {} });
      expect(before.kind).toBe(ConversationKind.DIRECT);
      expect(before.groupId).toBeNull();

      // 2. The group is synced afterwards.
      const group = await groupRepo.save(
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: externalGroupId,
          name: 'Late Sync Group',
          monitoringState: 'MONITORED' as never,
        }),
      );

      // 3. The next message in it reconciles the conversation rather than leaving it mislabelled.
      await deliver(
        incoming({
          id: 'WA_AFTER_SYNC',
          from: externalGroupId,
          chatId: externalGroupId,
          author: '8801711223399@c.us',
          isGroup: true,
        }),
      );

      const after = await conversationRepo.findOneOrFail({ where: { id: before.id } });
      expect(after.kind).toBe(ConversationKind.GROUP);
      expect(after.groupId).toBe(group.id);
      expect(after.subject).toBe('Late Sync Group');

      // Still one conversation: reconciling must not fork the history.
      expect(await conversationRepo.count()).toBe(1);
    });

    it('never demotes a GROUP conversation back to DIRECT', async () => {
      const group = await groupRepo.save(
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: 'stable@g.us',
          name: 'Stable Group',
          monitoringState: 'MONITORED' as never,
        }),
      );

      await deliver(
        incoming({ id: 'WA_G1', from: group.externalId, chatId: group.externalId, author: '8801711223355@c.us', isGroup: true }),
      );
      await deliver(
        incoming({ id: 'WA_G2', from: group.externalId, chatId: group.externalId, author: '8801711223355@c.us', isGroup: true }),
      );

      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      expect(conversation.kind).toBe(ConversationKind.GROUP);
      expect(conversation.groupId).toBe(group.id);
    });

    it('supports several distinct participants in one group conversation', async () => {
      // One group is NOT one customer (brief §4).
      const group = await groupRepo.save(
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: 'g1@g.us',
          name: 'Shared group',
          monitoringState: 'MONITORED' as never,
        }),
      );
      await teamIdentities.create({
        channelKey: ChannelKey.WHATSAPP,
        phone: '8801888888888',
        displayName: 'Support Exec',
      });

      const base = { from: group.externalId, chatId: group.externalId, isGroup: true };
      await deliver(incoming({ ...base, id: 'M1', author: '8801711223344@c.us' }));
      await deliver(incoming({ ...base, id: 'M2', author: '8801722334455@c.us' }));
      await deliver(incoming({ ...base, id: 'M3', author: '8801888888888@c.us' }));

      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      const participants = await participantRepo.find({ where: { conversationId: conversation.id } });

      expect(participants).toHaveLength(3);
      expect(participants.filter((p) => p.participantType === 'TEAM_MEMBER')).toHaveLength(1);
      // Two unknown senders — NOT auto-promoted to customers.
      expect(participants.filter((p) => p.participantType === 'UNKNOWN')).toHaveLength(2);
      expect(participants.filter((p) => p.participantType === 'CUSTOMER')).toHaveLength(0);
      expect(conversation.customerId).toBeNull();
    });

    it('creates an UNRESOLVED identity for every new sender and nothing more', async () => {
      await deliver(incoming());

      const identity = await identityRepo.findOneOrFail({ where: {} });
      expect(identity.matchState).toBe(IdentityMatchState.UNRESOLVED);
      expect(identity.customerId).toBeNull();
      expect(await customerRepo.count()).toBe(0);
    });

    it('stays idempotent — a duplicate message creates no second conversation', async () => {
      const data = incoming({ id: 'WA_DUP' });
      await deliver(data);
      await deliver(data);

      expect(await messageRepo.count()).toBe(1);
      expect(await conversationRepo.count()).toBe(1);
      expect((await conversationRepo.findOneOrFail({ where: {} })).messageCount).toBe(1);
    });
  });

  // === criterion 7: state ======================================================================

  describe('conversation state', () => {
    async function conversation(): Promise<Conversation> {
      await deliver(incoming());
      return conversationRepo.findOneOrFail({ where: {} });
    }

    it('validates status transitions against the table', () => {
      expect(isStatusTransitionAllowed(ConversationStatus.OPEN, ConversationStatus.RESOLVED)).toBe(true);
      expect(isStatusTransitionAllowed(ConversationStatus.RESOLVED, ConversationStatus.OPEN)).toBe(true);
      // CLOSED is terminal — that is what distinguishes it from RESOLVED.
      expect(isStatusTransitionAllowed(ConversationStatus.CLOSED, ConversationStatus.OPEN)).toBe(false);
      expect(isStatusTransitionAllowed(ConversationStatus.OPEN, ConversationStatus.OPEN)).toBe(false);
    });

    it('records every status change with actor and reason', async () => {
      const target = await conversation();
      await conversations.setStatus(
        target.id,
        ConversationStatus.RESOLVED,
        { id: null, username: 'tester' },
        { reason: 'Customer confirmed the fix' },
      );

      const history = await historyRepo.findOneOrFail({ where: { conversationId: target.id } });
      expect(history.previousStatus).toBe(ConversationStatus.OPEN);
      expect(history.status).toBe(ConversationStatus.RESOLVED);
      expect(history.reason).toBe('Customer confirmed the fix');
      expect(history.actorUsername).toBe('tester');
    });

    it('rejects an illegal transition', async () => {
      const target = await conversation();
      await conversations.setStatus(target.id, ConversationStatus.CLOSED, { id: null, username: 't' });
      await expect(
        conversations.setStatus(target.id, ConversationStatus.OPEN, { id: null, username: 't' }),
      ).rejects.toThrow(/Cannot move/);
    });

    it('reopens a RESOLVED conversation when a customer messages again', async () => {
      const group = await groupRepo.save(
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: 'g2@g.us',
          name: 'Monitored',
          monitoringState: 'MONITORED' as never,
        }),
      );
      const base = { from: group.externalId, chatId: group.externalId, isGroup: true, author: '8801711223344@c.us' };

      await deliver(incoming({ ...base, id: 'R1' }));
      const target = await conversationRepo.findOneOrFail({ where: {} });
      await conversations.setStatus(target.id, ConversationStatus.RESOLVED, { id: null, username: 't' });

      await deliver(incoming({ ...base, id: 'R2' }));

      expect((await conversationRepo.findOneOrFail({ where: { id: target.id } })).status).toBe(
        ConversationStatus.OPEN,
      );
    });

    it('does NOT reopen on a team member’s message', async () => {
      await teamIdentities.create({
        channelKey: ChannelKey.WHATSAPP,
        phone: '8801888888888',
        displayName: 'Exec',
      });
      const target = await conversation();
      await conversations.setStatus(target.id, ConversationStatus.RESOLVED, { id: null, username: 't' });

      await deliver(incoming({ id: 'T1', from: '8801888888888@c.us', chatId: '8801711223344@c.us' }));

      expect((await conversationRepo.findOneOrFail({ where: { id: target.id } })).status).toBe(
        ConversationStatus.RESOLVED,
      );
    });

    it('projects the two axes onto the PROJECT_SPEC.md §7 vocabulary', () => {
      expect(toSpecState(ConversationStatus.OPEN, ConversationControlState.AI_ACTIVE)).toBe('AI_ACTIVE');
      expect(toSpecState(ConversationStatus.WAITING_FOR_HUMAN, ConversationControlState.AI_ACTIVE)).toBe(
        'HUMAN_REQUIRED',
      );
      // PAUSED wins over everything — it is the safety-relevant reading.
      expect(toSpecState(ConversationStatus.OPEN, ConversationControlState.PAUSED)).toBe('PAUSED');
      expect(toSpecState(ConversationStatus.WAITING_FOR_CUSTOMER, ConversationControlState.AI_ACTIVE)).toBe(
        'WAITING_CUSTOMER',
      );
    });
  });

  // === criterion 8: human takeover =============================================================

  describe('human takeover', () => {
    async function conversation(): Promise<Conversation> {
      await deliver(incoming());
      return conversationRepo.findOneOrFail({ where: {} });
    }

    it('records who, why and when', async () => {
      const user = await createUser('exec', 'support_executive');
      const target = await conversation();

      const after = await conversations.startTakeover(
        target.id,
        { id: user.id, username: user.username },
        { reason: 'Customer asked for a person' },
      );

      expect(after.controlState).toBe(ConversationControlState.HUMAN_ACTIVE);
      expect(after.takeoverByUserId).toBe(user.id);
      expect(after.takeoverReason).toBe('Customer asked for a person');
      expect(after.takeoverAt).not.toBeNull();
      expect(after.takeoverExpiresAt).toBeNull(); // holds until released
    });

    it('is idempotent for the same holder', async () => {
      const user = await createUser('exec', 'support_executive');
      const target = await conversation();
      const actor = { id: user.id, username: user.username };

      await conversations.startTakeover(target.id, actor);
      await conversations.startTakeover(target.id, actor);

      expect(await historyRepo.count({ where: { conversationId: target.id } })).toBe(1);
    });

    it('releases to AUTOMATION_ACTIVE by default, not to AI', async () => {
      const user = await createUser('exec', 'support_executive');
      const target = await conversation();
      const actor = { id: user.id, username: user.username };

      await conversations.startTakeover(target.id, actor);
      const after = await conversations.endTakeover(target.id, actor);

      expect(after.controlState).toBe(ConversationControlState.AUTOMATION_ACTIVE);
      expect(after.takeoverByUserId).toBeNull();
    });

    it('expires a takeover that named a deadline, attributed to SYSTEM', async () => {
      const user = await createUser('exec', 'support_executive');
      const target = await conversation();

      await conversations.startTakeover(
        target.id,
        { id: user.id, username: user.username },
        { expiresInMinutes: 30 },
      );
      // Move the deadline into the past rather than waiting 30 minutes.
      await conversationRepo.update(target.id, { takeoverExpiresAt: new Date(Date.now() - 1000) });

      expect(await conversations.expireTakeovers()).toBe(1);

      const after = await conversationRepo.findOneOrFail({ where: { id: target.id } });
      expect(after.controlState).toBe(ConversationControlState.AUTOMATION_ACTIVE);

      const history = await historyRepo.find({
        where: { conversationId: target.id },
        order: { createdAt: 'DESC' },
      });
      expect(history[0].source).toBe(StateChangeSource.SYSTEM);
      expect(history[0].reason).toMatch(/expired/i);
    });

    it('never expires a takeover with no deadline', async () => {
      const user = await createUser('exec', 'support_executive');
      const target = await conversation();
      await conversations.startTakeover(target.id, { id: user.id, username: user.username });

      expect(await conversations.expireTakeovers()).toBe(0);
      expect((await conversationRepo.findOneOrFail({ where: { id: target.id } })).controlState).toBe(
        ConversationControlState.HUMAN_ACTIVE,
      );
    });

    it('refuses to release a conversation that is not under takeover', async () => {
      const target = await conversation();
      await expect(
        conversations.endTakeover(target.id, { id: null, username: 't' }),
      ).rejects.toThrow(/not under human takeover/);
    });
  });

  // === criterion 9: assignment ==================================================================

  describe('assignment', () => {
    async function conversation(): Promise<Conversation> {
      await deliver(incoming());
      return conversationRepo.findOneOrFail({ where: {} });
    }

    it('assigns to a user and records history', async () => {
      const user = await createUser('exec', 'support_executive');
      const target = await conversation();

      const after = await conversations.assign(
        target.id,
        { userId: user.id },
        { id: null, username: 'manager' },
        'Owns MikroTik issues',
      );

      expect(after.assignedToUserId).toBe(user.id);
      const rows = await assignmentRepo.find({ where: { conversationId: target.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].unassignedAt).toBeNull();
      expect(rows[0].reason).toBe('Owns MikroTik issues');
    });

    it('preserves history when reassigning — never overwrites', async () => {
      const first = await createUser('exec1', 'support_executive');
      const second = await createUser('exec2', 'support_executive');
      const target = await conversation();
      const actor = { id: null, username: 'manager' };

      await conversations.assign(target.id, { userId: first.id }, actor);
      await conversations.assign(target.id, { userId: second.id }, actor);

      const rows = await assignmentRepo.find({
        where: { conversationId: target.id },
        order: { createdAt: 'ASC' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].assignedToUserId).toBe(first.id);
      expect(rows[0].unassignedAt).not.toBeNull(); // closed, not deleted
      expect(rows[1].assignedToUserId).toBe(second.id);
      expect(rows[1].unassignedAt).toBeNull();
    });

    it('allows at most one OPEN assignment, enforced by the database', async () => {
      const user = await createUser('exec', 'support_executive');
      const target = await conversation();
      await conversations.assign(target.id, { userId: user.id }, { id: null, username: 'm' });

      await expect(
        ctx.dataSource.query(
          `INSERT INTO conversation_assignments ("conversationId", "assignedToUserId") VALUES ($1, $2)`,
          [target.id, user.id],
        ),
      ).rejects.toThrow();
    });

    it('assigns to a team', async () => {
      const team = await teamRepo.save(teamRepo.create({ key: 'tier1', name: 'Tier 1' }));
      const target = await conversation();

      const after = await conversations.assign(target.id, { teamId: team.id }, { id: null, username: 'm' });
      expect(after.assignedToTeamId).toBe(team.id);
      expect(after.assignedToUserId).toBeNull();
    });

    it('refuses an assignment to both or neither', async () => {
      const user = await createUser('exec', 'support_executive');
      const team = await teamRepo.save(teamRepo.create({ key: 'tier1', name: 'Tier 1' }));
      const target = await conversation();

      await expect(
        conversations.assign(target.id, { userId: user.id, teamId: team.id }, { id: null, username: 'm' }),
      ).rejects.toThrow(/exactly one/);
      await expect(
        conversations.assign(target.id, {}, { id: null, username: 'm' }),
      ).rejects.toThrow(/exactly one/);
    });

    it('closes the history row on unassign', async () => {
      const user = await createUser('exec', 'support_executive');
      const target = await conversation();
      const actor = { id: null, username: 'm' };

      await conversations.assign(target.id, { userId: user.id }, actor);
      await conversations.unassign(target.id, actor);

      const rows = await assignmentRepo.find({ where: { conversationId: target.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].unassignedAt).not.toBeNull();
      expect((await conversationRepo.findOneOrFail({ where: { id: target.id } })).assignedToUserId).toBeNull();
    });
  });

  // === criterion 11: pagination ==================================================================

  describe('history and pagination', () => {
    it('keeps messages with the same timestamp across cursor boundaries', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 12; i++) await deliver(incoming({ id: `SAME_TIME_${i}`, timestamp }));
      const target = await conversationRepo.findOneOrFail({ where: {} });
      const allIds: string[] = [];
      let before: Date | undefined; let beforeId: string | undefined;
      for (let i = 0; i < 3; i++) {
        const page = await conversations.listMessages(target.id, { limit: 5, before, beforeId });
        allIds.push(...page.items.map(m => m.id));
        before = page.nextCursor ? new Date(page.nextCursor) : undefined;
        beforeId = page.nextCursorId || undefined;
      }
      expect(allIds).toHaveLength(12);
      expect(new Set(allIds).size).toBe(12);
    });
    it('paginates message history with a cursor', async () => {
      for (let i = 0; i < 12; i++) {
        await deliver(incoming({ id: `PAGE_${i}`, timestamp: Math.floor(Date.now() / 1000) + i }));
      }
      const target = await conversationRepo.findOneOrFail({ where: {} });

      const first = await conversations.listMessages(target.id, { limit: 5 });
      expect(first.items).toHaveLength(5);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTruthy();

      const second = await conversations.listMessages(target.id, {
        limit: 5,
        before: new Date(first.nextCursor!),
      });
      expect(second.items).toHaveLength(5);
      // No overlap between pages.
      const ids = new Set([...first.items, ...second.items].map((m) => m.id));
      expect(ids.size).toBe(10);
    });

    it('caps the page size regardless of what is asked for', async () => {
      await deliver(incoming());
      const target = await conversationRepo.findOneOrFail({ where: {} });
      const result = await conversations.listMessages(target.id, { limit: 100_000 });
      expect(result.items.length).toBeLessThanOrEqual(200);
    });

    it('paginates the conversation list', async () => {
      for (let i = 0; i < 8; i++) {
        await deliver(incoming({ id: `C_${i}`, from: `88017112233${10 + i}@c.us`, chatId: `88017112233${10 + i}@c.us` }));
      }
      const page = await conversations.list({ limit: 3, offset: 0 });
      expect(page.items).toHaveLength(3);
      expect(page.total).toBe(8);
    });
  });

  // === criterion 13: RBAC ========================================================================

  describe('authorization', () => {
    it('denies conversation reads without the permission', async () => {
      await createUser('viewer', 'report_viewer'); // holds conversations.read
      await createUser('knowledge', 'knowledge_manager');
      const cookie = await login('knowledge');

      // knowledge_manager holds conversations.read but not conversations.manage.
      await request(ctx.app.getHttpServer()).get('/api/v1/conversations').set('Cookie', cookie).expect(200);
      await deliver(incoming());
      const target = await conversationRepo.findOneOrFail({ where: {} });

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/conversations/${target.id}/status`)
        .set('Cookie', cookie)
        .send({ status: 'RESOLVED' })
        .expect(403);
    });

    it('denies takeover without conversations.takeover', async () => {
      await createUser('knowledge', 'knowledge_manager');
      const cookie = await login('knowledge');
      await deliver(incoming());
      const target = await conversationRepo.findOneOrFail({ where: {} });

      const denied = await request(ctx.app.getHttpServer())
        .post(`/api/v1/conversations/${target.id}/takeover`)
        .set('Cookie', cookie)
        .send({})
        .expect(403);
      expect(denied.body.message).toMatch(/conversations\.takeover/);
    });

    it('allows a support executive to take over', async () => {
      await createUser('exec', 'support_executive');
      const cookie = await login('exec');
      await deliver(incoming());
      const target = await conversationRepo.findOneOrFail({ where: {} });

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/conversations/${target.id}/takeover`)
        .set('Cookie', cookie)
        .send({ reason: 'taking this one' })
        .expect(201);
      expect(response.body.controlState).toBe('HUMAN_ACTIVE');
      expect(response.body.specState).toBe('HUMAN_ACTIVE');
    });

    it('denies customer modification without customers.manage', async () => {
      await createUser('exec2', 'report_viewer');
      const cookie = await login('exec2');

      await request(ctx.app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({ displayName: 'Should not work' })
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await request(ctx.app.getHttpServer()).get('/api/v1/conversations').expect(401);
    });
  });

  // === criterion 14: audit ========================================================================

  describe('audit', () => {
    it('records a takeover with before and after', async () => {
      await createUser('exec', 'support_executive');
      const cookie = await login('exec');
      await deliver(incoming());
      const target = await conversationRepo.findOneOrFail({ where: {} });

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/conversations/${target.id}/takeover`)
        .set('Cookie', cookie)
        .send({ reason: 'escalated' })
        .expect(201);

      const entry = await auditRepo.findOneOrFail({ where: { action: 'conversations.takeover_started' } });
      expect((entry.before as Record<string, unknown>).controlState).toBe('AUTOMATION_ACTIVE');
      expect((entry.after as Record<string, unknown>).controlState).toBe('HUMAN_ACTIVE');
      expect(entry.actorUsername).toBe('exec');
    });

    it('records an identity confirmation', async () => {
      await createUser('manager', 'support_manager');
      const cookie = await login('manager');
      await deliver(incoming());

      const identity = await identityRepo.findOneOrFail({ where: {} });
      const customer = await customers.create({ displayName: 'ABC ISP' });

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/customers/identities/${identity.id}/confirm`)
        .set('Cookie', cookie)
        .send({ customerId: customer.id, note: 'confirmed by phone' })
        .expect(201);

      const entry = await auditRepo.findOneOrFail({ where: { action: 'customers.identity_confirmed' } });
      expect((entry.before as Record<string, unknown>).matchState).toBe('UNRESOLVED');
      expect((entry.after as Record<string, unknown>).matchState).toBe('CONFIRMED');
    });

    it('never writes a customer phone number or note body into the audit trail', async () => {
      await createUser('manager', 'support_manager');
      const cookie = await login('manager');

      const created = await request(ctx.app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({ displayName: 'ABC ISP', primaryPhone: '8801711223344' })
        .expect(201);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/customers/${created.body.id}/notes`)
        .set('Cookie', cookie)
        .send({ body: 'Customer disputes the December invoice' })
        .expect(201);

      const entries = JSON.stringify(await auditRepo.find());
      expect(entries).not.toContain('8801711223344');
      expect(entries).not.toContain('disputes the December invoice');
    });
  });
});
