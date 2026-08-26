import request from 'supertest';
import { In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AIProviderService } from '../src/common/ai/ai-provider';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { ChannelAccountService } from '../src/modules/channel/channel-account.service';
import { ChannelConnectionState } from '../src/modules/channel/channel-connection';
import { NO_CAPABILITIES } from '../src/modules/channel/channel-capabilities';
import { ChannelAccount } from '../src/modules/channel/entities/channel-account.entity';
import { Channel, ChannelKey } from '../src/modules/channel/entities/channel.entity';
import { WhatsAppChannelAdapter } from '../src/modules/channel/whatsapp/whatsapp.adapter';
import { ProviderEvent, ProviderEventStatus } from '../src/modules/ingestion/entities/provider-event.entity';
import { Group, GroupMonitoringState } from '../src/modules/groups/entities/group.entity';
import { InboundProcessor } from '../src/modules/messaging/inbound.processor';
import { Message } from '../src/modules/messaging/entities/message.entity';
import { OutboundMessage, OutboundSource } from '../src/modules/messaging/entities/outbound-message.entity';
import { MessageService } from '../src/modules/messaging/message.service';
import { ConversationControlState, ConversationStatus } from '../src/modules/crm/conversation-states';
import { Conversation } from '../src/modules/crm/entities/conversation.entity';
import { AutomationRuleService } from '../src/modules/automation/automation-rule.service';
import {
  ActionType,
  AutomationStatus,
  ConditionType,
  RuleScopeType,
} from '../src/modules/automation/automation-types';
import { AutomationRule } from '../src/modules/automation/entities/automation-rule.entity';
import { AutomationExecution } from '../src/modules/automation/entities/automation-execution.entity';
import { AutomationProfile } from '../src/modules/automation/entities/automation-profile.entity';
import { DecisionLog } from '../src/modules/decision/entities/decision-log.entity';
import { AiRun } from '../src/modules/decision/entities/ai-run.entity';
import { DecisionOutcome, DecisionReason } from '../src/modules/decision/decision-types';
import { DecisionService } from '../src/modules/decision/decision.service';
import { Escalation, EscalationStatus } from '../src/modules/escalation/entities/escalation.entity';
import { EscalationService } from '../src/modules/escalation/escalation.service';
import { KnowledgeArticle } from '../src/modules/knowledge/entities/knowledge-article.entity';
import { KnowledgeCategory } from '../src/modules/knowledge/entities/knowledge-category.entity';
import { KnowledgeArticleService } from '../src/modules/knowledge/knowledge-article.service';
import { KnowledgeIndexService } from '../src/modules/knowledge/knowledge-index.service';
import { KnowledgeScopeType, KnowledgeStatus } from '../src/modules/knowledge/knowledge-types';
import { TeamIdentityService } from '../src/modules/team/team-identity.service';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { User } from '../src/modules/auth/entities/user.entity';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { PERMISSIONS, ROLES } from '../src/modules/rbac/permissions.catalogue';
import { OpenWaStub } from './openwa-stub';
import { closeTestApp, createTestApp, extractCookie, resetDatabase, type TestContext } from './setup';

const COOKIE = 'support_crm_session';
const SESSION = 'decision-test';
const SESSION_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CUSTOMER_JID = '8801711223344@c.us';
const TEAM_JID = '8801888888888@c.us';

/**
 * Phase 5 — the Message Decision Engine.
 *
 * Driven end to end: a signed webhook goes in, the inbound processor runs, and the decision is
 * whatever the engine actually made. Nothing here calls the engine directly except where a test is
 * specifically about the engine's own behaviour, because the property under test is usually "what
 * happens to a real inbound message", not "what does this function return".
 */
describe('Decision Engine (integration)', () => {
  let ctx: TestContext;
  let stub: OpenWaStub;

  let accounts: ChannelAccountService;
  let adapter: WhatsAppChannelAdapter;
  let inboundProcessor: InboundProcessor;
  let rules: AutomationRuleService;
  let decisions: DecisionService;
  let escalations: EscalationService;
  let articles: KnowledgeArticleService;
  let indexer: KnowledgeIndexService;
  let messages: MessageService;
  let teamIdentities: TeamIdentityService;
  let crypto: CryptoService;
  let config: ConfigService;

  let accountRepo: Repository<ChannelAccount>;
  let eventRepo: Repository<ProviderEvent>;
  let messageRepo: Repository<Message>;
  let outboundRepo: Repository<OutboundMessage>;
  let conversationRepo: Repository<Conversation>;
  let groupRepo: Repository<Group>;
  let ruleRepo: Repository<AutomationRule>;
  let executionRepo: Repository<AutomationExecution>;
  let profileRepo: Repository<AutomationProfile>;
  let decisionRepo: Repository<DecisionLog>;
  let aiRunRepo: Repository<AiRun>;
  let escalationRepo: Repository<Escalation>;
  let categoryRepo: Repository<KnowledgeCategory>;
  let articleRepo: Repository<KnowledgeArticle>;
  let auditRepo: Repository<AuditLog>;
  let userRepo: Repository<User>;
  let roleRepo: Repository<Role>;
  let permissionRepo: Repository<Permission>;

  let account: ChannelAccount;
  let webhookSecret: string;
  let categoryId: string;

  beforeAll(async () => {
    stub = new OpenWaStub();
    process.env.OPENWA_BASE_URL = await stub.start();
    process.env.OPENWA_API_KEY = 'stub-key';
    // The scripted provider: offline, deterministic, and refused in production by env validation.
    process.env.AI_PROVIDER = 'test';

    ctx = await createTestApp();

    accounts = ctx.app.get(ChannelAccountService);
    adapter = ctx.app.get(WhatsAppChannelAdapter);
    inboundProcessor = ctx.app.get(InboundProcessor);
    rules = ctx.app.get(AutomationRuleService);
    decisions = ctx.app.get(DecisionService);
    escalations = ctx.app.get(EscalationService);
    articles = ctx.app.get(KnowledgeArticleService);
    indexer = ctx.app.get(KnowledgeIndexService);
    messages = ctx.app.get(MessageService);
    teamIdentities = ctx.app.get(TeamIdentityService);
    crypto = ctx.app.get(CryptoService);
    config = ctx.app.get(ConfigService);

    await inboundProcessor.worker.pause(true);

    accountRepo = ctx.dataSource.getRepository(ChannelAccount);
    eventRepo = ctx.dataSource.getRepository(ProviderEvent);
    messageRepo = ctx.dataSource.getRepository(Message);
    outboundRepo = ctx.dataSource.getRepository(OutboundMessage);
    conversationRepo = ctx.dataSource.getRepository(Conversation);
    groupRepo = ctx.dataSource.getRepository(Group);
    ruleRepo = ctx.dataSource.getRepository(AutomationRule);
    executionRepo = ctx.dataSource.getRepository(AutomationExecution);
    profileRepo = ctx.dataSource.getRepository(AutomationProfile);
    decisionRepo = ctx.dataSource.getRepository(DecisionLog);
    aiRunRepo = ctx.dataSource.getRepository(AiRun);
    escalationRepo = ctx.dataSource.getRepository(Escalation);
    categoryRepo = ctx.dataSource.getRepository(KnowledgeCategory);
    articleRepo = ctx.dataSource.getRepository(KnowledgeArticle);
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
    setScript({});

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

    account = await accounts.register({
      channelKey: ChannelKey.WHATSAPP,
      externalName: SESSION,
      label: 'Decision test account',
    });
    await accountRepo.update(account.id, {
      externalId: SESSION_UUID,
      accountPhone: '8801999999999',
      status: ChannelConnectionState.CONNECTED,
      // Phase 2 gates every send on the probed capability descriptor (§174): an account whose
      // capabilities were never probed can do nothing. A connected account has them.
      capabilities: {
        ...NO_CAPABILITIES,
        canSendText: true,
        canSendMedia: true,
        canSendDocument: true,
        canReply: true,
      },
    });

    webhookSecret = crypto.generateToken(32);
    await accounts.setWebhook(account.id, 'wh_1', adapter.encryptWebhookSecret(account.id, webhookSecret));
    account = await accounts.findOne(account.id);

    stub.addSession(SESSION, SESSION_UUID, { status: 'ready', phone: '8801999999999' });

    categoryId = (await categoryRepo.save(categoryRepo.create({ key: 'general', name: 'General', isSystem: true })))
      .id;
  });

  /** Drives the scripted AI provider for one test. */
  function setScript(script: Record<string, unknown>): void {
    config.set('ai.testScript', script);
  }

  const incoming = (overrides: Record<string, unknown> = {}) => ({
    id: `WA_${Math.random().toString(36).slice(2, 12)}`,
    from: CUSTOMER_JID,
    to: '8801999999999@c.us',
    chatId: CUSTOMER_JID,
    body: 'my internet is down',
    type: 'chat',
    timestamp: Math.floor(Date.now() / 1000),
    fromMe: false,
    isGroup: false,
    ...overrides,
  });

  /** Delivers a signed webhook and drains the inbound queue, exactly as production does. */
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

  /** An ACTIVE rule, created through the service so validation and versioning run. */
  async function activeRule(overrides: Partial<Parameters<AutomationRuleService['create']>[0]> = {}) {
    const rule = await rules.create(
      {
        name: 'Internet down',
        conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'internet' }] },
        actions: [{ type: ActionType.SEND_MESSAGE, value: 'We are checking your connection now.' }],
        ...overrides,
      },
      null,
    );
    return rules.transition(rule.id, AutomationStatus.ACTIVE, null);
  }

  async function publishedArticle(input: {
    title: string;
    body: string;
    scopeType?: KnowledgeScopeType;
    scopeId?: string | null;
  }) {
    const article = await articles.create(
      {
        title: input.title,
        body: input.body,
        categoryId,
        scopeType: input.scopeType ?? KnowledgeScopeType.GLOBAL,
        scopeId: input.scopeId ?? null,
      },
      null,
    );
    await articleRepo.update(article.id, { status: KnowledgeStatus.PUBLISHED });
    await indexer.syncArticleChunks(await articles.findOne(article.id));
    return articles.findOne(article.id);
  }


  /**
   * Creates the conversation and switches automation on for it.
   *
   * Automation and AI default to **off** on every conversation and group — Phase 3 made them opt-in
   * so that Phase 5 arriving could not make three thousand groups start replying by surprise. Tests
   * about automation therefore have to opt in, which is the same thing an operator does.
   *
   * The seed message's own decision is cleared afterwards, so each test's assertions are about the
   * message it actually sends.
   */
  async function ready(options: { ai?: boolean } = {}): Promise<Conversation> {
    await deliver(incoming({ body: 'hello there' }));
    const conversation = await conversationRepo.findOneOrFail({ where: {} });

    await conversationRepo.update(conversation.id, {
      automationEnabled: true,
      aiEnabled: options.ai !== false,
    });

    // `delete({})` is rejected by TypeORM as an empty criteria; a builder delete is the way to
    // clear a table deliberately.
    await decisionRepo.createQueryBuilder().delete().execute();
    await outboundRepo.createQueryBuilder().delete().execute();

    return conversationRepo.findOneOrFail({ where: { id: conversation.id } });
  }

  const latestDecision = () => decisionRepo.findOne({ where: {}, order: { createdAt: 'DESC' } });

  // === the single authority ========================================================================

  describe('every customer message produces exactly one decision', () => {
    it('records a decision for an inbound customer message', async () => {
      await ready();
      await deliver(incoming());

      const decision = await latestDecision();
      expect(decision).not.toBeNull();
      expect(decision!.status).toBe('COMPLETED');
      expect(decision!.outcome).toBeTruthy();
      expect(decision!.reason).toBeTruthy();
      expect(decision!.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('produces one decision and one reply for a duplicate webhook', async () => {
      await activeRule();
      await ready();
      const payload = incoming();

      await deliver(payload);
      await deliver(payload); // the same provider message id, delivered twice

      expect(await decisionRepo.count()).toBe(1);
      expect(await outboundRepo.count()).toBe(1);
      // One stored copy of the duplicated message (the seed accounts for the other row).
      expect(await messageRepo.count({ where: { body: 'my internet is down' } })).toBe(1);
    });

    it('refuses a second decision for the same message', async () => {
      await ready();
      await deliver(incoming());
      const message = await messageRepo.findOneOrFail({ where: { body: 'my internet is down' } });
      const conversation = await conversationRepo.findOneOrFail({ where: {} });

      // The unique claim: a redelivered job or a second worker collides and stops.
      const second = await decisions.handleInbound(message, conversation);

      expect(second).toBeNull();
      expect(await decisionRepo.count()).toBe(1);
    });

    it('never decides on a message the account itself sent', async () => {
      await activeRule();
      await ready();
      await deliver(incoming({ fromMe: true, body: 'We are checking your connection now.' }));

      // Our own outbound echo returning through the channel is the direct loop, and it stops here.
      const decision = await latestDecision();
      expect(decision).toBeNull();
      expect(await outboundRepo.count()).toBe(0);
    });
  });

  // === team message protection (brief §7) ==========================================================

  describe('team messages', () => {
    beforeEach(async () => {
      const user = await userRepo.save(
        userRepo.create({
          username: 'agent',
          email: 'agent@example.com',
          name: 'Agent',
          passwordHash: crypto.hashPassword('Password!123'),
          isActive: true,
        }),
      );
      await teamIdentities.create({
        userId: user.id,
        channelKey: ChannelKey.WHATSAPP,
        externalId: TEAM_JID,
        phone: '8801888888888',
        displayName: 'Agent',
      });
    });

    it('stores a team message without triggering automation, AI or escalation', async () => {
      await activeRule();
      await ready();
      await deliver(incoming({ from: TEAM_JID, body: 'internet issue being handled' }));

      const stored = await messageRepo.findOneOrFail({ where: { body: 'internet issue being handled' } });
      expect(stored.classification).toBe('TEAM_MESSAGE');

      // The message is kept, and nothing automatic happens. An agent's own words entering the
      // customer pipeline is how a system starts answering itself.
      const decision = await latestDecision();
      expect(decision).toBeNull();
      expect(await outboundRepo.count()).toBe(0);
      expect(await escalationRepo.count()).toBe(0);
    });
  });

  // === human takeover is authoritative (brief §5) ==================================================

  describe('human takeover', () => {
    async function conversationWithTakeover(overrides: Partial<Conversation> = {}) {
      const conversation = await ready();

      await conversationRepo.update(conversation.id, {
        controlState: ConversationControlState.HUMAN_ACTIVE,
        takeoverAt: new Date(),
        takeoverReason: 'Agent took over',
        ...overrides,
      });
      return conversationRepo.findOneOrFail({ where: { id: conversation.id } });
    }

    it('blocks both automation and AI while a person holds the conversation', async () => {
      await activeRule();
      await conversationWithTakeover();

      await deliver(incoming({ body: 'my internet is still down' }));

      const decision = await latestDecision();
      expect(decision!.outcome).toBe(DecisionOutcome.HUMAN_HANDLING);
      expect(decision!.reasonCode).toBe(DecisionReason.HUMAN_TAKEOVER_ACTIVE);
      expect(await outboundRepo.count()).toBe(0);
      expect(await aiRunRepo.count()).toBe(0);
    });

    it('still stores the customer message during a takeover', async () => {
      await conversationWithTakeover();
      await deliver(incoming({ body: 'are you still there?' }));

      // The whole point: a human owning the conversation stops the machine replying, not the
      // system recording what the customer said.
      const stored = await messageRepo.find({ where: {} });
      expect(stored.some((m) => m.body === 'are you still there?')).toBe(true);
    });

    it('releases an expired takeover and carries on', async () => {
      await activeRule();
      await conversationWithTakeover({ takeoverExpiresAt: new Date(Date.now() - 60_000) } as Partial<Conversation>);

      await deliver(incoming({ body: 'my internet is down again' }));

      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      expect(conversation.takeoverExpiresAt).toBeNull();
      expect(conversation.controlState).not.toBe(ConversationControlState.HUMAN_ACTIVE);

      const decision = await latestDecision();
      expect(decision!.outcome).toBe(DecisionOutcome.RULE_REPLY);
    });

    it('sweeps takeovers that expired while nobody was talking', async () => {
      await conversationWithTakeover({ takeoverExpiresAt: new Date(Date.now() - 60_000) } as Partial<Conversation>);

      const released = await escalations.releaseExpiredTakeovers();

      expect(released).toBe(1);
      expect((await conversationRepo.findOneOrFail({ where: {} })).controlState).toBe(
        ConversationControlState.AUTOMATION_ACTIVE,
      );
    });

    it('does not release a takeover that has no expiry', async () => {
      await conversationWithTakeover();
      expect(await escalations.releaseExpiredTakeovers()).toBe(0);
    });
  });

  // === deterministic rules =========================================================================

  describe('deterministic rules', () => {
    it('replies with the matching rule and records which rule won', async () => {
      const rule = await activeRule();
      await ready();
      await deliver(incoming());

      const decision = await latestDecision();
      expect(decision!.outcome).toBe(DecisionOutcome.RULE_REPLY);
      expect(decision!.ruleId).toBe(rule.id);
      expect(decision!.ruleVersion).toBe(rule.currentVersion);

      expect(decision!.error).toBeNull();
      const outbound = await outboundRepo.findOneOrFail({ where: {} });
      expect(outbound.body).toBe('We are checking your connection now.');
      expect(outbound.source).toBe(OutboundSource.AUTOMATION);
      // Provenance: the send is attributable to the decision that caused it.
      expect(outbound.decisionId).toBe(decision!.id);
    });

    it('does not call AI when a rule answered', async () => {
      await activeRule();
      await ready();
      await deliver(incoming());

      // Deterministic beats AI, and skipping the provider call is the point (brief §14).
      expect(await aiRunRepo.count()).toBe(0);
    });

    it('picks the more specific rule and records the loser', async () => {
      const global = await activeRule({ name: 'Global', priority: 100 });
      const conversation = await ready();
      const conversationScoped = await activeRule({
        name: 'Conversation',
        priority: 0,
        scopeType: RuleScopeType.CONVERSATION,
        scopeId: conversation.id,
        actions: [{ type: ActionType.SEND_MESSAGE, value: 'Specific answer.' }],
      });

      await deliver(incoming());

      const decision = await latestDecision();
      expect(decision!.ruleId).toBe(conversationScoped.id);
      expect(decision!.candidateRuleIds).toEqual(expect.arrayContaining([global.id, conversationScoped.id]));

      const executions = await executionRepo.find({ where: { decisionId: decision!.id } });
      expect(executions.find((e) => e.ruleId === conversationScoped.id)!.outcome).toBe('MATCHED_WON');
      expect(executions.find((e) => e.ruleId === global.id)!.outcome).toBe('MATCHED_LOST');
    });

    it('ignores a rule that is not active', async () => {
      const rule = await rules.create(
        {
          name: 'Draft rule',
          conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'internet' }] },
          actions: [{ type: ActionType.SEND_MESSAGE, value: 'Should never be sent.' }],
        },
        null,
      );
      expect(rule.status).toBe(AutomationStatus.DRAFT);

      await ready();
      await deliver(incoming());
      expect(await outboundRepo.count()).toBe(0);
    });

    it('escalates when a rule says to', async () => {
      await activeRule({
        name: 'Escalate billing',
        conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'refund' }] },
        actions: [{ type: ActionType.ESCALATE, value: 'Refunds need a person' }],
      });
      await ready();

      await deliver(incoming({ body: 'I want a refund' }));

      const decision = await latestDecision();
      expect(decision!.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
      expect(await escalationRepo.count()).toBe(1);
      expect(await outboundRepo.count()).toBe(0);
    });

    it('sends nothing when a rule says to ignore', async () => {
      await activeRule({
        name: 'Ignore stickers',
        conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'internet' }] },
        actions: [{ type: ActionType.IGNORE }],
      });
      await ready();

      await deliver(incoming());

      expect((await latestDecision())!.outcome).toBe(DecisionOutcome.IGNORE);
      expect(await outboundRepo.count()).toBe(0);
    });

    it('counts an execution and stamps the rule when it wins', async () => {
      const rule = await activeRule();
      await ready();
      await deliver(incoming());

      const after = await ruleRepo.findOneOrFail({ where: { id: rule.id } });
      expect(after.executionCount).toBe(1);
      expect(after.lastMatchedAt).not.toBeNull();
    });

    it('honours a cooldown across two messages', async () => {
      await activeRule({ cooldownSeconds: 3_600 });
      await ready();

      await deliver(incoming({ body: 'my internet is down' }));
      await deliver(incoming({ body: 'internet still broken' }));

      // The second message matched the rule but the rule was cooling; no second reply.
      expect(await outboundRepo.count()).toBe(1);
      const decisions = await decisionRepo.find({ order: { createdAt: 'ASC' } });
      expect(decisions[1].outcome).not.toBe(DecisionOutcome.RULE_REPLY);
    });
  });

  // === rule lifecycle and versioning ===============================================================

  describe('rule lifecycle', () => {
    it('creates as a draft and versions every behaviour change', async () => {
      const rule = await rules.create(
        {
          name: 'Versioned',
          conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'a' }] },
          actions: [{ type: ActionType.SEND_MESSAGE, value: 'one' }],
        },
        null,
      );

      await rules.update(rule.id, { actions: [{ type: ActionType.SEND_MESSAGE, value: 'two' }] }, null);
      const versions = await rules.listVersions(rule.id);

      expect(versions).toHaveLength(2);
      expect((await rules.findOne(rule.id)).currentVersion).toBe(2);
    });

    it('returns an active rule to draft when its behaviour is edited', async () => {
      const rule = await activeRule();

      await rules.update(rule.id, { actions: [{ type: ActionType.SEND_MESSAGE, value: 'changed' }] }, null);

      // A live rule's words must not change without review (§199).
      expect((await rules.findOne(rule.id)).status).toBe(AutomationStatus.DRAFT);
    });

    it('rolls back to an earlier version as a new draft version', async () => {
      const rule = await activeRule();
      await rules.update(rule.id, { actions: [{ type: ActionType.SEND_MESSAGE, value: 'v2 text' }] }, null);

      const restored = await rules.rollback(rule.id, 1, null);

      expect(restored.actions[0].value).toBe('We are checking your connection now.');
      expect(restored.currentVersion).toBe(3);
      expect(restored.status).toBe(AutomationStatus.DRAFT);
    });

    it('refuses to activate a rule that cannot work', async () => {
      const rule = await ruleRepo.save(
        ruleRepo.create({
          name: 'Broken',
          status: AutomationStatus.DRAFT,
          conditions: { match: 'ALL', conditions: [] },
          actions: [],
        }),
      );

      await expect(rules.transition(rule.id, AutomationStatus.ACTIVE, null)).rejects.toThrow(/cannot be activated/);
    });
  });

  // === AI ==========================================================================================

  describe('AI fallback', () => {
    beforeEach(async () => {
      await publishedArticle({
        title: 'Internet outage steps',
        body: 'If the internet is down, restart the router and check the fibre light is green.',
      });
    });

    it('answers from knowledge when confidence is high', async () => {
      setScript({ confidence: 0.97, answer: 'Please restart your router and check the fibre light.' });
      await ready();

      await deliver(incoming());

      const decision = await latestDecision();
      expect(decision!.outcome).toBe(DecisionOutcome.AI_REPLY);
      expect(decision!.knowledgeUsed).toBe(true);
      expect(decision!.knowledgeArticleIds?.length).toBeGreaterThan(0);
      // Recorded, and recorded as uncalibrated: the number is a self-report, not a probability.
      expect(Number(decision!.confidence)).toBeCloseTo(0.97, 2);
      expect(decision!.confidenceCalibrated).toBe(false);

      const outbound = await outboundRepo.findOneOrFail({ where: {} });
      expect(outbound.source).toBe(OutboundSource.AI);
      expect(outbound.decisionId).toBe(decision!.id);
    });

    it('escalates on low confidence', async () => {
      setScript({ confidence: 0.4 });
      await ready();

      await deliver(incoming());

      const decision = await latestDecision();
      expect(decision!.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
      expect(decision!.reasonCode).toBe(DecisionReason.AI_LOW_CONFIDENCE);
      expect(await outboundRepo.count()).toBe(0);
      expect(await escalationRepo.count()).toBe(1);
    });

    it('escalates when the model asks for a human', async () => {
      setScript({ confidence: 0.99, needsHuman: true });
      await ready();

      await deliver(incoming());

      expect((await latestDecision())!.reasonCode).toBe(DecisionReason.AI_NEEDS_HUMAN);
      expect(await outboundRepo.count()).toBe(0);
    });

    it('escalates when the model says the knowledge was insufficient', async () => {
      setScript({ confidence: 0.99, knowledgeSufficient: false });
      await ready();

      await deliver(incoming());

      expect((await latestDecision())!.reasonCode).toBe(DecisionReason.KNOWLEDGE_INSUFFICIENT);
      expect(await outboundRepo.count()).toBe(0);
    });

    it.each([
      ['timeout', 'TIMEOUT'],
      ['rate_limit', 'RATE_LIMITED'],
      ['failed', 'FAILED'],
    ])('escalates safely when the provider fails with %s', async (scripted, expectedStatus) => {
      setScript({ throw: scripted });
      await ready();

      await deliver(incoming());

      const decision = await latestDecision();
      expect(decision!.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
      expect(decision!.reasonCode).toBe(DecisionReason.AI_FAILED);
      // Never a fabricated answer, never a lost message.
      expect(await outboundRepo.count()).toBe(0);
      // The customer's message is still there. A provider outage must never lose it.
      expect(await messageRepo.count({ where: { body: 'my internet is down' } })).toBe(1);
      expect(await escalationRepo.count()).toBe(1);

      const run = await aiRunRepo.findOneOrFail({ where: {} });
      expect(run.status).toBe(expectedStatus);
    });

    it('escalates when the provider returns something that is not structured data', async () => {
      setScript({ throw: 'malformed' });
      await ready();

      await deliver(incoming());

      expect((await latestDecision())!.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
      expect(await outboundRepo.count()).toBe(0);
    });

    it('records a run for every provider call', async () => {
      setScript({ confidence: 0.95 });
      await ready();
      await deliver(incoming());

      const run = await aiRunRepo.findOneOrFail({ where: {} });
      expect(run.status).toBe('SUCCESS');
      expect(run.provider).toBe('test');
      expect(run.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('AI when no provider is configured', () => {
    it('escalates rather than answering', async () => {
      // Honest unavailability: with no provider, anything a rule cannot answer goes to a person.
      const provider = ctx.app.get(AIProviderService);
      const available = jest.spyOn(provider, 'available', 'get').mockReturnValue(false);

      try {
        await publishedArticle({ title: 'Anything', body: 'Some approved knowledge about routers.' });
        await ready();
        await deliver(incoming());

        const decision = await latestDecision();
        expect(decision!.outcome).toBe(DecisionOutcome.HUMAN_HANDOFF);
        expect(decision!.reasonCode).toBe(DecisionReason.AI_UNAVAILABLE);
        expect(await outboundRepo.count()).toBe(0);
      } finally {
        available.mockRestore();
      }
    });
  });

  // === knowledge scope isolation reaches the engine ================================================

  describe('knowledge scope', () => {
    it('never puts another group’s knowledge into an answer', async () => {
      const groupA = await groupRepo.save(
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: 'ga@g.us',
          name: 'Group A',
          isActive: true,
          monitoringState: GroupMonitoringState.MONITORED,
        }),
      );
      const groupB = await groupRepo.save(
        groupRepo.create({
          channelKey: ChannelKey.WHATSAPP,
          channelAccountId: account.id,
          externalId: 'gb@g.us',
          name: 'Group B',
          isActive: true,
          monitoringState: GroupMonitoringState.MONITORED,
        }),
      );

      await publishedArticle({
        title: 'Group A only',
        body: 'The maintenance window for this network is Sunday at 02:00 for group A.',
        scopeType: KnowledgeScopeType.GROUP,
        scopeId: groupA.id,
      });

      setScript({ confidence: 0.99 });

      // Seed the group conversation, then switch automation on for it.
      await deliver(incoming({ body: 'hello', isGroup: true, chatId: 'gb@g.us', from: CUSTOMER_JID }));
      const groupConversation = await conversationRepo.findOneOrFail({ where: { externalConversationId: 'gb@g.us' } });
      await conversationRepo.update(groupConversation.id, { automationEnabled: true, aiEnabled: true });
      await decisionRepo.createQueryBuilder().delete().execute();

      await deliver(
        incoming({ body: 'when is the maintenance window?', isGroup: true, chatId: 'gb@g.us', from: CUSTOMER_JID }),
      );

      const decision = await latestDecision();
      const usedArticles = decision!.knowledgeArticleIds ?? [];
      const groupAArticle = await articleRepo.findOneOrFail({ where: { title: 'Group A only' } });

      // Group A's article must be absent from a group B conversation — not ranked lower, absent.
      expect(usedArticles).not.toContain(groupAArticle.id);
      expect(groupB.id).toBeTruthy();
    });
  });

  // === loop protection =============================================================================

  describe('loop protection', () => {
    it('suppresses an identical repeated message', async () => {
      await activeRule();
      await ready();

      await deliver(incoming({ body: 'my internet is down' }));
      await deliver(incoming({ body: 'my internet is down' }));

      const all = await decisionRepo.find({ order: { createdAt: 'ASC' } });
      expect(all[0].outcome).toBe(DecisionOutcome.RULE_REPLY);
      expect(all[1].outcome).toBe(DecisionOutcome.SUPPRESSED);
      expect(all[1].reasonCode).toBe(DecisionReason.REPEATED_MESSAGE);
      expect(await outboundRepo.count()).toBe(1);
    });

    it('stops replying once a conversation exhausts its budget', async () => {
      await activeRule();
      await ready();

      // Each message is distinct so the repeat guard does not fire; the budget is what stops it.
      for (let index = 0; index < 8; index += 1) {
        await deliver(incoming({ body: `internet problem number ${index}` }));
      }

      const replies = await outboundRepo.count();
      expect(replies).toBeLessThanOrEqual(5);

      const suppressed = await decisionRepo.find({ where: { outcome: DecisionOutcome.SUPPRESSED } });
      expect(suppressed.length).toBeGreaterThan(0);
      expect(suppressed[0].reasonCode).toBe(DecisionReason.LOOP_GUARD);
    });
  });

  // === escalation ==================================================================================

  describe('escalation', () => {
    it('puts the conversation into human handling and notifies', async () => {
      setScript({ confidence: 0.2 });
      await publishedArticle({ title: 'Something', body: 'Approved knowledge about connections.' });
      await ready();

      await deliver(incoming());

      const escalation = await escalationRepo.findOneOrFail({ where: {} });
      expect(escalation.status).toBe(EscalationStatus.OPEN);

      const conversation = await conversationRepo.findOneOrFail({ where: {} });
      expect(conversation.status).toBe(ConversationStatus.WAITING_FOR_HUMAN);
      expect(conversation.controlState).toBe(ConversationControlState.HUMAN_ACTIVE);
    });

    it('raises one escalation for a conversation, not one per message', async () => {
      setScript({ confidence: 0.2 });
      await publishedArticle({ title: 'Something', body: 'Approved knowledge about connections.' });
      await ready();

      await deliver(incoming({ body: 'first problem' }));
      await deliver(incoming({ body: 'second problem' }));

      // One conversation with a recurring problem is one item in somebody's queue.
      expect(await escalationRepo.count()).toBe(1);
    });

    it('blocks automation once escalated, until released', async () => {
      await activeRule();
      const conversation = await ready();

      await escalations.raise({ conversationId: conversation.id, reason: 'RULE_ESCALATION' });
      await deliver(incoming({ body: 'my internet is down now' }));

      const latest = await decisionRepo.findOne({ where: {}, order: { createdAt: 'DESC' } });
      expect(latest!.outcome).toBe(DecisionOutcome.HUMAN_HANDLING);
      expect(await outboundRepo.count()).toBe(0);
    });

    it('returns the conversation to automation when an agent releases it', async () => {
      const conversation = await ready();
      const escalation = await escalations.raise({ conversationId: conversation.id, reason: 'RULE_ESCALATION' });

      await escalations.resolve(escalation.id, { userId: null, releaseToAutomation: true });

      const after = await conversationRepo.findOneOrFail({ where: { id: conversation.id } });
      expect(after.controlState).toBe(ConversationControlState.AUTOMATION_ACTIVE);
      expect(after.takeoverByUserId).toBeNull();
    });
  });

  // === the outbound guard ==========================================================================

  describe('nothing can auto-reply without a decision', () => {
    it('rejects an automatic send with no decision reference', async () => {
      await ready();
      const message = await messageRepo.findOneOrFail({ where: {} });

      // The structural guarantee: a future feature that tries to auto-reply outside the engine has
      // no decision id to supply and fails here.
      for (const source of [OutboundSource.AUTOMATION, OutboundSource.AI]) {
        await expect(
          messages.send({
            channelAccountId: account.id,
            externalConversationId: message.externalConversationId,
            body: 'bypassing the engine',
            source,
          }),
        ).rejects.toThrow(/Message Decision Engine/);
      }
    });

    it('still lets a human send manually', async () => {
      await ready();
      const message = await messageRepo.findOneOrFail({ where: {} });

      const sent = await messages.send({
        channelAccountId: account.id,
        externalConversationId: message.externalConversationId,
        body: 'A person typed this.',
        source: OutboundSource.MANUAL,
      });

      expect(sent.decisionId).toBeNull();
    });
  });

  // === dry run =====================================================================================

  describe('dry run', () => {
    it('reports the winner without sending anything', async () => {
      const cookie = await login('admin', 'admin');
      const rule = await activeRule();

      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/decisions/dry-run')
        .set('Cookie', cookie)
        .send({ text: 'my internet is down' })
        .expect(201);

      expect(response.body.winner.id).toBe(rule.id);
      expect(response.body.wouldSend).toBe('We are checking your connection now.');
      expect(response.body.sent).toBe(false);

      // Nothing happened: no message, no decision, no counter moved.
      expect(await outboundRepo.count()).toBe(0);
      expect(await decisionRepo.count()).toBe(0);
      expect((await ruleRepo.findOneOrFail({ where: { id: rule.id } })).executionCount).toBe(0);
    });

    it('shows the rules that lost', async () => {
      const cookie = await login('admin', 'admin');
      await activeRule({ name: 'High', priority: 100 });
      await activeRule({ name: 'Low', priority: 1 });

      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/decisions/dry-run')
        .set('Cookie', cookie)
        .send({ text: 'my internet is down' })
        .expect(201);

      expect(response.body.matched).toHaveLength(2);
      expect(response.body.matched[0].won).toBe(true);
      expect(response.body.matched[1].won).toBe(false);
    });

    it('needs the simulate permission', async () => {
      const cookie = await login('viewer', 'report_viewer');
      await request(ctx.app.getHttpServer())
        .post('/api/v1/decisions/dry-run')
        .set('Cookie', cookie)
        .send({ text: 'anything' })
        .expect(403);
    });
  });

  // === the decision trace ==========================================================================

  describe('decision trace', () => {
    it('answers "why did the system respond to this message?"', async () => {
      const cookie = await login('admin', 'admin');
      const rule = await activeRule();
      await ready();
      await deliver(incoming());

      const message = await messageRepo.findOneOrFail({ where: { body: 'my internet is down' } });
      const response = await request(ctx.app.getHttpServer())
        .get(`/api/v1/decisions/message/${message.id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.outcome).toBe(DecisionOutcome.RULE_REPLY);
      expect(response.body.ruleId).toBe(rule.id);
      expect(response.body.reason).toContain(rule.name);
      expect(response.body.responseMessageId).toBeTruthy();
    });

    it('says so plainly when a message produced no decision', async () => {
      const cookie = await login('admin', 'admin');
      await deliver(incoming({ fromMe: true, body: 'an echo' }));
      const message = await messageRepo.findOneOrFail({ where: { body: 'an echo' } });

      const response = await request(ctx.app.getHttpServer())
        .get(`/api/v1/decisions/message/${message.id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.decision).toBeNull();
    });
  });

  // === security ====================================================================================

  describe('security', () => {
    it('keeps credentials out of decision logs, AI runs, audit rows and API responses', async () => {
      const cookie = await login('admin', 'admin');
      const gatewayKey = process.env.OPENWA_API_KEY as string;
      const aiKey = 'ai-credential-should-never-appear';
      process.env.AI_API_KEY = aiKey;

      await publishedArticle({ title: 'Anything', body: 'Approved knowledge about connections.' });
      setScript({ confidence: 0.95 });
      await ready();
      await deliver(incoming());

      const dumps = [
        JSON.stringify(await decisionRepo.find()),
        JSON.stringify(await aiRunRepo.find()),
        JSON.stringify(await auditRepo.find()),
        JSON.stringify((await request(ctx.app.getHttpServer()).get('/api/v1/decisions').set('Cookie', cookie)).body),
        JSON.stringify(
          (await request(ctx.app.getHttpServer()).get('/api/v1/decisions/status').set('Cookie', cookie)).body,
        ),
      ];

      for (const dump of dumps) {
        expect(dump).not.toContain(gatewayKey);
        expect(dump).not.toContain(aiKey);
      }

      delete process.env.AI_API_KEY;
    });

    it('reports AI availability without naming a credential', async () => {
      const cookie = await login('admin', 'admin');
      const response = await request(ctx.app.getHttpServer())
        .get('/api/v1/decisions/status')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.ai).toEqual({ available: true, provider: 'test', model: 'scripted-test' });
      expect(JSON.stringify(response.body)).not.toMatch(/apiKey|secret|token/i);
    });

    it('does not put the customer’s message or the answer into the decision log', async () => {
      await activeRule({
        conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'distinctive' }] },
      });
      await ready();
      await deliver(incoming({ body: 'a very distinctive customer sentence' }));

      const dump = JSON.stringify(await decisionRepo.find());
      // The decision log explains a decision; it is not a second copy of the conversation, and it
      // is read by more people than the inbox is.
      expect(dump).not.toContain('a very distinctive customer sentence');
      expect(dump).not.toContain('We are checking your connection now.');
    });
  });

  // === authorization ===============================================================================

  describe('authorization', () => {
    it('requires a session for every automation and decision route', async () => {
      for (const path of ['/api/v1/automation/rules', '/api/v1/decisions', '/api/v1/escalations']) {
        await request(ctx.app.getHttpServer()).get(path).expect(401);
      }
    });

    it('lets a writer create a rule but not activate it', async () => {
      const cookie = await loginWithPermissions('writer', ['automation.read', 'automation.create']);

      const created = await request(ctx.app.getHttpServer())
        .post('/api/v1/automation/rules')
        .set('Cookie', cookie)
        .send({
          name: 'Writer rule',
          conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'hello' }] },
          actions: [{ type: ActionType.SEND_MESSAGE, value: 'Hi' }],
        })
        .expect(201);

      // Writing words is not the same authority as putting them in front of customers.
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/automation/rules/${created.body.id}/status`)
        .set('Cookie', cookie)
        .send({ status: AutomationStatus.ACTIVE })
        .expect(403);

      expect((await rules.findOne(created.body.id)).status).toBe(AutomationStatus.DRAFT);
    });

    it('audits rule creation and activation', async () => {
      const cookie = await login('admin', 'admin');

      const created = await request(ctx.app.getHttpServer())
        .post('/api/v1/automation/rules')
        .set('Cookie', cookie)
        .send({
          name: 'Audited rule',
          conditions: { match: 'ALL', conditions: [{ type: ConditionType.CONTAINS, value: 'hello' }] },
          actions: [{ type: ActionType.SEND_MESSAGE, value: 'Hi' }],
        })
        .expect(201);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/automation/rules/${created.body.id}/status`)
        .set('Cookie', cookie)
        .send({ status: AutomationStatus.ACTIVE })
        .expect(201);

      const actions = (await auditRepo.find()).map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(['automation.rule_created', 'automation.rule_status_changed']));
    });
  });

  // === profiles ====================================================================================

  describe('automation profiles', () => {
    it('lets a profile switch automation off for every group assigned to it', async () => {
      const profile = await profileRepo.save(
        profileRepo.create({
          name: 'Silent profile',
          status: AutomationStatus.ACTIVE,
          automationEnabled: false,
          aiEnabled: false,
        }),
      );

      await activeRule();
      const conversation = await ready();
      await conversationRepo.update(conversation.id, { automationProfileId: profile.id });

      await deliver(incoming({ body: 'my internet is down badly' }));

      // One profile edit, every assigned conversation. This is what makes 3,000 groups operable.
      const latest = await decisionRepo.findOne({ where: {}, order: { createdAt: 'DESC' } });
      expect(latest!.outcome).not.toBe(DecisionOutcome.RULE_REPLY);
      expect(await outboundRepo.count()).toBe(0);
    });

    it('applies a profile’s confidence thresholds', async () => {
      const profile = await profileRepo.save(
        profileRepo.create({
          name: 'Permissive profile',
          status: AutomationStatus.ACTIVE,
          automationEnabled: true,
          aiEnabled: true,
          // A profile states only what it changes.
          autoReplyMinConfidence: '0.500',
          escalateBelowConfidence: '0.300',
        }),
      );

      await publishedArticle({ title: 'Steps', body: 'Approved steps for a slow connection.' });
      const conversation = await ready();
      await conversationRepo.update(conversation.id, { automationProfileId: profile.id });

      setScript({ confidence: 0.6 });
      await deliver(incoming({ body: 'my connection is slow today' }));

      // 0.6 would escalate under the default 0.9 threshold; this profile answers.
      const latest = await decisionRepo.findOne({ where: {}, order: { createdAt: 'DESC' } });
      expect(latest!.outcome).toBe(DecisionOutcome.AI_REPLY);
    });
  });

  // === helpers =====================================================================================

  async function login(username: string, roleKey: string): Promise<string> {
    const role = await roleRepo.findOneOrFail({ where: { key: roleKey } });
    await userRepo.save(
      userRepo.create({
        username,
        email: `${username}@example.com`,
        name: username,
        passwordHash: crypto.hashPassword('Password!123'),
        isActive: true,
        roles: [role],
      }),
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: username, password: 'Password!123' })
      .expect(200);

    return `${COOKIE}=${extractCookie(response.headers['set-cookie'] as unknown as string[], COOKIE)}`;
  }

  async function loginWithPermissions(username: string, permissions: string[]): Promise<string> {
    const role = await roleRepo.save(
      roleRepo.create({
        key: `test-${username}`,
        name: `Test ${username}`,
        description: 'Created by the decision engine suite',
        isSystem: false,
        permissions: await permissionRepo.find({ where: { key: In(permissions) } }),
      }),
    );

    await userRepo.save(
      userRepo.create({
        username,
        email: `${username}@example.com`,
        name: username,
        passwordHash: crypto.hashPassword('Password!123'),
        isActive: true,
        roles: [role],
      }),
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: username, password: 'Password!123' })
      .expect(200);

    return `${COOKIE}=${extractCookie(response.headers['set-cookie'] as unknown as string[], COOKIE)}`;
  }
});
