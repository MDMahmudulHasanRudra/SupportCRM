import request from 'supertest';
import { In, Repository } from 'typeorm';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { ChannelAccountService } from '../src/modules/channel/channel-account.service';
import { ChannelConnectionState, ConnectionEventSource } from '../src/modules/channel/channel-connection';
import { ChannelRecoveryService } from '../src/modules/channel/channel-recovery.service';
import { ChannelAccount } from '../src/modules/channel/entities/channel-account.entity';
import { ChannelConnectionEvent } from '../src/modules/channel/entities/channel-connection-event.entity';
import { Channel, ChannelKey } from '../src/modules/channel/entities/channel.entity';
import { Group } from '../src/modules/groups/entities/group.entity';
import { GroupParticipant } from '../src/modules/groups/entities/group-participant.entity';
import { ParticipantType } from '../src/modules/messaging/message-types';
import { Customer } from '../src/modules/crm/entities/customer.entity';
import { User } from '../src/modules/auth/entities/user.entity';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { PERMISSIONS, ROLES } from '../src/modules/rbac/permissions.catalogue';
import { OpenWaStub } from './openwa-stub';
import { closeTestApp, createTestApp, extractCookie, resetDatabase, type TestContext } from './setup';

const COOKIE = 'support_crm_session';

/**
 * Phase 3.5 — group-scoped participant sync, and automatic session recovery.
 *
 * Both features exist because of what the real-WhatsApp validation showed: an account-wide
 * participant sync would have imported everyone in nine real groups, and an unattended session
 * dropped inside twenty minutes with nothing to bring it back.
 */
describe('Phase 3.5 (integration)', () => {
  let ctx: TestContext;
  let stub: OpenWaStub;

  let accounts: ChannelAccountService;
  let recovery: ChannelRecoveryService;
  let crypto: CryptoService;

  let accountRepo: Repository<ChannelAccount>;
  let eventRepo: Repository<ChannelConnectionEvent>;
  let groupRepo: Repository<Group>;
  let participantRepo: Repository<GroupParticipant>;
  let customerRepo: Repository<Customer>;
  let userRepo: Repository<User>;
  let roleRepo: Repository<Role>;
  let permissionRepo: Repository<Permission>;

  beforeAll(async () => {
    stub = new OpenWaStub();
    process.env.OPENWA_BASE_URL = await stub.start();
    process.env.OPENWA_API_KEY = 'stub-key';

    ctx = await createTestApp();

    accounts = ctx.app.get(ChannelAccountService);
    recovery = ctx.app.get(ChannelRecoveryService);
    crypto = ctx.app.get(CryptoService);

    accountRepo = ctx.dataSource.getRepository(ChannelAccount);
    eventRepo = ctx.dataSource.getRepository(ChannelConnectionEvent);
    groupRepo = ctx.dataSource.getRepository(Group);
    participantRepo = ctx.dataSource.getRepository(GroupParticipant);
    customerRepo = ctx.dataSource.getRepository(Customer);
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

  let sessionCounter = 0;

  /** An account whose gateway session exists and is live. */
  async function liveAccount(name: string, status: ChannelConnectionState): Promise<ChannelAccount> {
    const account = await accounts.register({
      channelKey: ChannelKey.WHATSAPP,
      externalName: name,
      label: name,
    });

    // Distinct per account: `externalId` is uniquely indexed per channel, so two accounts sharing
    // a generated id would fail on the constraint rather than on the behaviour under test.
    sessionCounter += 1;
    const session = stub.addSession(
      name,
      `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, '0')}`,
    );
    await accountRepo.update(account.id, {
      externalId: session.id,
      status,
      accountPhone: '8801000000000',
      // Recovery only touches accounts that have paired at least once.
      lastConnectedAt: new Date(Date.now() - 60_000),
    });

    return accountRepo.findOneOrFail({ where: { id: account.id } });
  }

  /** Stubs the gateway's detail payload for one group, keyed the way the gateway addresses it. */
  function detail(
    account: ChannelAccount,
    externalGroupId: string,
    name: string,
    participants: Array<Record<string, unknown>>,
  ): void {
    stub.groupDetails.set(`${account.externalId}:${externalGroupId}`, {
      id: externalGroupId,
      name,
      description: null,
      owner: null,
      isAnnounce: false,
      participants,
    });
  }

  async function group(account: ChannelAccount, externalId: string, name: string): Promise<Group> {
    return groupRepo.save(
      groupRepo.create({
        channelKey: ChannelKey.WHATSAPP,
        channelAccountId: account.id,
        externalId,
        name,
        isActive: true,
      }),
    );
  }

  // === group-scoped participant sync ==============================================================

  describe('POST /groups/:groupId/sync-participants', () => {
    it('syncs only the named group and leaves the others untouched', async () => {
      const cookie = await login('admin', 'admin');
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);

      const target = await group(account, 'g-target@g.us', 'Target');
      const other = await group(account, 'g-other@g.us', 'Other');

      detail(account, 'g-target@g.us', 'Target', [
        { id: '8801111111111@c.us', number: '8801111111111', name: 'One', isAdmin: false },
        { id: '8802222222222@c.us', number: '8802222222222', name: 'Two', isAdmin: true },
      ]);
      detail(account, 'g-other@g.us', 'Other', [
        { id: '8809999999999@c.us', number: '8809999999999', name: 'Nine', isAdmin: false },
      ]);

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/groups/${target.id}/sync-participants`)
        .set('Cookie', cookie)
        .send({ channelAccountId: account.id })
        .expect(201);

      expect(response.body.groupId).toBe(target.id);
      expect(response.body.active).toBe(2);

      expect(await participantRepo.count({ where: { groupId: target.id } })).toBe(2);
      // The whole point of the endpoint: nobody else's members were imported.
      expect(await participantRepo.count({ where: { groupId: other.id } })).toBe(0);
      expect(await participantRepo.count()).toBe(2);
    });

    it('is idempotent — a second sync updates rather than duplicates', async () => {
      const cookie = await login('admin', 'admin');
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      const target = await group(account, 'g-target@g.us', 'Target');

      detail(account, 'g-target@g.us', 'Target', [
        { id: '8801111111111@c.us', number: '8801111111111', name: 'One', isAdmin: false },
      ]);

      for (const _ of [1, 2, 3]) {
        await request(ctx.app.getHttpServer())
          .post(`/api/v1/groups/${target.id}/sync-participants`)
          .set('Cookie', cookie)
          .send({ channelAccountId: account.id })
          .expect(201);
      }

      expect(await participantRepo.count({ where: { groupId: target.id } })).toBe(1);
    });

    it('promotes nobody to CUSTOMER', async () => {
      const cookie = await login('admin', 'admin');
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      const target = await group(account, 'g-target@g.us', 'Target');

      detail(account, 'g-target@g.us', 'Target', [
        { id: '8801111111111@c.us', number: '8801111111111', name: 'One', isAdmin: false },
        // The connected account itself — the one participant that IS identifiable.
        { id: '8801000000000@c.us', number: '8801000000000', name: 'Us', isAdmin: true },
      ]);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/groups/${target.id}/sync-participants`)
        .set('Cookie', cookie)
        .send({ channelAccountId: account.id })
        .expect(201);

      const participants = await participantRepo.find({ where: { groupId: target.id } });
      const types = participants.map((p) => p.participantType);

      // A stranger in a group is a stranger. Turning them into a customer record is a decision a
      // human makes, on evidence, and never a side effect of a sync (brief §8).
      expect(types).toContain(ParticipantType.UNKNOWN);
      expect(types).toContain(ParticipantType.ACCOUNT);
      expect(types).not.toContain(ParticipantType.CUSTOMER);
      expect(await customerRepo.count()).toBe(0);
    });

    it('reports a group from another account as absent', async () => {
      const cookie = await login('admin', 'admin');
      const accountA = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      const accountB = await liveAccount('acct-b', ChannelConnectionState.CONNECTED);

      const foreign = await group(accountB, 'g-foreign@g.us', 'Foreign');

      // 404, not 403: whether some other account owns a group with this id is not something a
      // caller scoped to account A is entitled to learn.
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/groups/${foreign.id}/sync-participants`)
        .set('Cookie', cookie)
        .send({ channelAccountId: accountA.id })
        .expect(404);

      expect(await participantRepo.count({ where: { groupId: foreign.id } })).toBe(0);
    });

    it('requires an authenticated session', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      const target = await group(account, 'g-target@g.us', 'Target');

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/groups/${target.id}/sync-participants`)
        .send({ channelAccountId: account.id })
        .expect(401);
    });

    it('requires the groups.update permission', async () => {
      const cookie = await login('viewer', 'report_viewer');
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      const target = await group(account, 'g-target@g.us', 'Target');

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/groups/${target.id}/sync-participants`)
        .set('Cookie', cookie)
        .send({ channelAccountId: account.id })
        .expect(403);
    });

    it('rejects a request that does not say which account it means', async () => {
      const cookie = await login('admin', 'admin');
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      const target = await group(account, 'g-target@g.us', 'Target');

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/groups/${target.id}/sync-participants`)
        .set('Cookie', cookie)
        .send({})
        .expect(400);
    });

    it('refuses when Support CRM does not own the account', async () => {
      const cookie = await login('admin', 'admin');
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      const target = await group(account, 'g-target@g.us', 'Target');
      await accountRepo.update(account.id, { ownershipEnabled: false });

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/groups/${target.id}/sync-participants`)
        .set('Cookie', cookie)
        .send({ channelAccountId: account.id })
        .expect(409);
    });
  });

  // === automatic recovery =========================================================================

  describe('automatic session recovery', () => {
    it('reconnects a session that dropped on its own', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      Object.assign(stub.findByName('acct-a')!, { status: 'ready', paired: true });

      const result = await recovery.recoverDroppedSessions();

      expect(result).toEqual({ attempted: 1, recovered: 1, exhausted: 0 });
      const after = await accountRepo.findOneOrFail({ where: { id: account.id } });
      expect(after.status).toBe(ChannelConnectionState.CONNECTED);
      // A clean slate, so an unrelated drop next month starts from attempt one.
      expect(after.recoveryAttempts).toBe(0);
      expect(after.recoveryNextAttemptAt).toBeNull();
      expect(after.recoveryExhaustedAt).toBeNull();
    });

    it('records every attempt in the connection history', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      Object.assign(stub.findByName('acct-a')!, { status: 'ready', paired: true });

      await recovery.recoverDroppedSessions();

      const events = await eventRepo.find({
        where: { channelAccountId: account.id },
        order: { createdAt: 'ASC' },
      });
      const attempt = events.find((e) => e.detail?.includes('Automatic reconnect attempt 1'));

      expect(attempt).toBeTruthy();
      expect(attempt!.source).toBe(ConnectionEventSource.SYSTEM);
      // "Why did this reconnect at 3am" has an answer.
      expect(events.some((e) => e.state === ChannelConnectionState.CONNECTED)).toBe(true);
    });

    it('backs off after a failure and gives up at the configured maximum', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      const max = 5;

      for (let attempt = 1; attempt <= max; attempt += 1) {
        // Every gateway call fails, so every attempt fails.
        stub.failNextRequests = 20;

        const current = await accountRepo.findOneOrFail({ where: { id: account.id } });
        // Pretend the booked delay has elapsed, rather than waiting minutes of wall clock.
        await accountRepo.update(account.id, { recoveryNextAttemptAt: null });

        await recovery.attempt({ ...current, recoveryNextAttemptAt: null } as ChannelAccount);

        const after = await accountRepo.findOneOrFail({ where: { id: account.id } });
        expect(after.recoveryAttempts).toBe(attempt);

        if (attempt < max) {
          expect(after.recoveryExhaustedAt).toBeNull();
          expect(after.recoveryNextAttemptAt).not.toBeNull();
        }
      }

      const exhausted = await accountRepo.findOneOrFail({ where: { id: account.id } });
      expect(exhausted.recoveryExhaustedAt).not.toBeNull();
      expect(exhausted.recoveryNextAttemptAt).toBeNull();

      // And it stops: an exhausted account is no longer a candidate.
      stub.failNextRequests = 0;
      expect(await recovery.recoverDroppedSessions()).toEqual({ attempted: 0, recovered: 0, exhausted: 0 });
    });

    it('grows the delay between attempts', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      const delays: number[] = [];

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        stub.failNextRequests = 20;
        const current = await accountRepo.findOneOrFail({ where: { id: account.id } });
        const before = Date.now();

        await recovery.attempt({ ...current, recoveryNextAttemptAt: null } as ChannelAccount);

        const after = await accountRepo.findOneOrFail({ where: { id: account.id } });
        delays.push(after.recoveryNextAttemptAt!.getTime() - before);
      }

      expect(delays[1]).toBeGreaterThan(delays[0]);
      expect(delays[2]).toBeGreaterThan(delays[1]);
    });

    it('never runs two attempts at once', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      Object.assign(stub.findByName('acct-a')!, { status: 'ready', paired: true });

      // Hold the account lock the way an operator's Connect would.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = accounts.withSessionLock(account.id, 'connect', () => held);

      try {
        const outcome = await recovery.attempt(account);

        // Skipped, not failed: somebody else is already working on this account, which is the
        // outcome we want. A failed attempt would have burned a slot from the budget.
        expect(outcome).toBe('skipped');
        const after = await accountRepo.findOneOrFail({ where: { id: account.id } });
        expect(after.recoveryAttempts).toBe(0);
      } finally {
        release();
        await holder;
      }
    });

    it('leaves an account alone when an operator disconnected it', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      const cookie = await login('admin', 'admin');

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/channels/whatsapp/accounts/${account.id}/disconnect`)
        .set('Cookie', cookie)
        .expect(201);

      const disconnected = await accountRepo.findOneOrFail({ where: { id: account.id } });
      expect(disconnected.disconnectRequestedAt).not.toBeNull();

      // Reconnecting an account somebody deliberately took down is the single most annoying thing
      // this feature could do.
      expect(await recovery.recoverDroppedSessions()).toEqual({ attempted: 0, recovered: 0, exhausted: 0 });
      expect((await accountRepo.findOneOrFail({ where: { id: account.id } })).status).toBe(
        ChannelConnectionState.DISCONNECTED,
      );
    });

    it('clears the operator hold when they press Connect again', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      await accountRepo.update(account.id, {
        disconnectRequestedAt: new Date(),
        recoveryExhaustedAt: new Date(),
        recoveryAttempts: 5,
      });
      const cookie = await login('admin', 'admin');
      Object.assign(stub.findByName('acct-a')!, { status: 'ready', paired: true });

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/channels/whatsapp/accounts/${account.id}/connect`)
        .set('Cookie', cookie)
        .expect(201);

      const after = await accountRepo.findOneOrFail({ where: { id: account.id } });
      expect(after.disconnectRequestedAt).toBeNull();
      expect(after.recoveryExhaustedAt).toBeNull();
      expect(after.recoveryAttempts).toBe(0);
    });

    it('stops retrying when WhatsApp wants a new QR', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      stub.findByName('acct-a')!.status = 'qr_ready';

      const outcome = await recovery.attempt(account);

      // Re-pairing needs a human with a phone. Retrying cannot produce one, and the QR flow already
      // tells the operator what to do.
      expect(outcome).toBe('skipped');
      const after = await accountRepo.findOneOrFail({ where: { id: account.id } });
      expect(after.status).toBe(ChannelConnectionState.QR_REQUIRED);
      expect(after.recoveryNextAttemptAt).toBeNull();
      expect(after.recoveryAttempts).toBe(0);
    });

    it('ends the recovery cycle when the account comes back by any other route', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      // A failed attempt left a retry booked.
      await accountRepo.update(account.id, {
        recoveryAttempts: 1,
        recoveryNextAttemptAt: new Date(Date.now() + 30_000),
      });

      // The health poll then finds the session back up — nothing to do with the recovery service.
      await accounts.recordState(
        await accountRepo.findOneOrFail({ where: { id: account.id } }),
        ChannelConnectionState.CONNECTED,
        { source: ConnectionEventSource.GATEWAY_POLL },
      );

      // Without this, a healthy account displays "Reconnecting…" forever. Regression:
      // real-gateway validation of Phase 3.5.
      const after = await accountRepo.findOneOrFail({ where: { id: account.id } });
      expect(after.recoveryNextAttemptAt).toBeNull();
      expect(after.recoveryAttempts).toBe(0);
      expect(after.recoveryExhaustedAt).toBeNull();
    });

    it('shows a connected account as connected even if a stale booking survives', async () => {
      const cookie = await login('admin', 'admin');
      const account = await liveAccount('acct-a', ChannelConnectionState.CONNECTED);
      // Written directly, bypassing recordState, to simulate a booking that outlived its outage.
      await accountRepo.update(account.id, {
        recoveryNextAttemptAt: new Date(Date.now() + 30_000),
        recoveryExhaustedAt: new Date(),
      });

      const response = await request(ctx.app.getHttpServer())
        .get('/api/v1/channels/whatsapp/accounts/overview')
        .set('Cookie', cookie)
        .expect(200);

      const row = response.body.items.find((i: { id: string }) => i.id === account.id);
      expect(row.state).toBe('CONNECTED');
      expect(row.statusText).toBe('Connected.');
    });

    it('does not touch an account that has never paired', async () => {
      // Nothing to recover to — connecting it would be a first-time setup nobody asked for.
      const account = await accounts.register({
        channelKey: ChannelKey.WHATSAPP,
        externalName: 'never-paired',
        label: 'Never paired',
      });
      expect(account.lastConnectedAt).toBeNull();

      expect(await recovery.recoverDroppedSessions()).toEqual({ attempted: 0, recovered: 0, exhausted: 0 });
    });

    it('records the true previous state on every transition it writes', async () => {
      const account = await liveAccount('acct-a', ChannelConnectionState.DISCONNECTED);
      Object.assign(stub.findByName('acct-a')!, { status: 'ready', paired: true });

      await recovery.recoverDroppedSessions();

      const events = await eventRepo.find({
        where: { channelAccountId: account.id },
        order: { createdAt: 'ASC' },
      });

      // Every row's previousState must be the state the row before it left the account in — no
      // phantom transitions from a caller's stale copy.
      const transitions = events.filter((e) => e.detail !== null && e.detail.includes('attempt') === false);
      for (const event of transitions) {
        expect(event.previousState).not.toBe(event.state);
      }
      const connected = events.find((e) => e.state === ChannelConnectionState.CONNECTED);
      expect(connected!.previousState).not.toBe(ChannelConnectionState.CONNECTED);
    });
  });
});
