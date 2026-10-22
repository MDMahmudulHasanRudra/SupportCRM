import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { User } from '../src/modules/auth/entities/user.entity';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Customer } from '../src/modules/crm/entities/customer.entity';
import { closeTestApp, createTestApp, resetDatabase, type TestContext } from './setup';

describe('Workspace workflows with real Postgres and session permissions', () => {
  let ctx: TestContext; let cookie: string; let otherCookie: string; let userId: string; let customerId: string;
  const base = '/api/v1/workspace';
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { if (ctx) await closeTestApp(ctx); });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    await ctx.dataSource.getRepository(SecuritySettings).save({ id: SECURITY_SETTINGS_ID });
    const role = await ctx.dataSource.getRepository(Role).save({ key: 'super_admin', name: 'Admin', isSuperAdmin: true, permissions: [] });
    const hash = ctx.app.get(CryptoService).hashPassword('TestPassword!123');
    const user = await ctx.dataSource.getRepository(User).save({ username: 'owner', email: 'owner@example.test', name: 'Owner', passwordHash: hash, roles: [role], isActive: true });
    userId = user.id;
    await ctx.dataSource.getRepository(User).save({ username: 'other', email: 'other@example.test', name: 'Other', passwordHash: hash, roles: [], isActive: true });
    const customer = await ctx.dataSource.getRepository(Customer).save({ displayName: 'Example client' }); customerId = customer.id;
    const owner = await request(ctx.app.getHttpServer()).post('/api/v1/auth/login').send({ identifier: 'owner', password: 'TestPassword!123' }).expect(200);
    cookie = String(owner.headers['set-cookie'][0]).split(';')[0];
    const other = await request(ctx.app.getHttpServer()).post('/api/v1/auth/login').send({ identifier: 'other', password: 'TestPassword!123' }).expect(200);
    otherCookie = String(other.headers['set-cookie'][0]).split(';')[0];
  });
  const post = (path: string, body: object) => request(ctx.app.getHttpServer()).post(`${base}${path}`).set('Cookie', cookie).send(body);
  async function invoice(amountMinor = 10000) {
    return (await post('/billing/invoices', { customerId, description: 'Support plan', currency: 'BDT', amountMinor, dueDate: '2026-11-30' }).expect(201)).body as { id: string };
  }

  it('enforces separate billing permission and rejects invalid amounts', async () => {
    await request(ctx.app.getHttpServer()).get(`${base}/billing`).expect(401);
    await request(ctx.app.getHttpServer()).get(`${base}/billing`).set('Cookie', otherCookie).expect(403);
    await post('/billing/invoices', { customerId, description: 'Plan', currency: 'BDT', amountMinor: -1, dueDate: '2026-11-30' }).expect(400);
  });
  it('records partial payments, replays the same key and rejects altered replays', async () => {
    const i = await invoice(); const payment = { invoiceId: i.id, amountMinor: 2500, reference: 'Bank transfer', idempotencyKey: randomUUID() };
    const first = await post('/billing/payments', payment).expect(201);
    const retry = await post('/billing/payments', payment).expect(201); expect(retry.body.id).toBe(first.body.id);
    await post('/billing/payments', { ...payment, amountMinor: 2600 }).expect(409);
    const result = await request(ctx.app.getHttpServer()).get(`${base}/billing`).set('Cookie', cookie).expect(200);
    expect(result.body.invoices[0].balanceMinor).toBe('7500'); expect(result.body.payments).toHaveLength(1);
    expect(result.body.totals[0].currency).toBe('BDT');
  });
  it('serializes concurrent payments so an invoice cannot be overpaid', async () => {
    const i = await invoice();
    const results = await Promise.all([1,2].map(n => post('/billing/payments', { invoiceId: i.id, amountMinor: 7000, reference: `Payment ${n}`, idempotencyKey: randomUUID() })));
    expect(results.map(r => r.status).sort()).toEqual([201,400]);
    const [{ paid }] = await ctx.dataSource.query<Array<{ paid: string }>>('SELECT SUM("amountMinor")::text AS paid FROM billing_payments'); expect(paid).toBe('7000');
  });
  it('reverses without deleting receipts and restores the balance exactly once', async () => {
    const i = await invoice(); const p = await post('/billing/payments', { invoiceId: i.id, amountMinor: 10000, reference: 'Cash', idempotencyKey: randomUUID() }).expect(201);
    await post(`/billing/payments/${p.body.id}/reverse`, { reason: '   ' }).expect(400);
    await post(`/billing/payments/${p.body.id}/reverse`, { reason: 'Duplicate receipt' }).expect(201);
    await post(`/billing/payments/${p.body.id}/reverse`, { reason: 'Duplicate receipt' }).expect(409);
    const result = await request(ctx.app.getHttpServer()).get(`${base}/billing`).set('Cookie', cookie);
    expect(result.body.invoices[0].balanceMinor).toBe('10000'); expect(result.body.payments[0].reversalReason).toBe('Duplicate receipt');
  });
  it('tracks subscription transitions and requires a later renewal date', async () => {
    const s = await post('/billing/subscriptions', { customerId, name: 'Annual plan', status: 'ACTIVE', startsOn: '2026-01-01', endsOn: '2026-12-31' }).expect(201);
    await post(`/billing/subscriptions/${s.body.id}/action`, { action: 'RENEW', endsOn: '2026-12-01' }).expect(400);
    await post(`/billing/subscriptions/${s.body.id}/action`, { action: 'PAUSE' }).expect(201);
    await post(`/billing/subscriptions/${s.body.id}/action`, { action: 'RESUME' }).expect(201);
    await post(`/billing/subscriptions/${s.body.id}/action`, { action: 'RENEW', endsOn: '2027-12-31' }).expect(201);
    await post(`/billing/subscriptions/${s.body.id}/action`, { action: 'CANCEL' }).expect(201);
    await post(`/billing/subscriptions/${s.body.id}/action`, { action: 'RESUME' }).expect(409);
    const h = await request(ctx.app.getHttpServer()).get(`${base}/billing/subscriptions/${s.body.id}/history`).set('Cookie', cookie);
    expect(h.body.items).toHaveLength(5);
  });
  it('blocks overlapping shifts while allowing adjoining shifts and flags approved leave', async () => {
    const shift = { userId, startsAt: '2026-11-01T03:00:00Z', endsAt: '2026-11-01T11:00:00Z', label: 'Morning' };
    await post('/workforce/shifts', shift).expect(201);
    await post('/workforce/shifts', { ...shift, startsAt: '2026-11-01T10:00:00Z' }).expect(409);
    await post('/workforce/shifts', { ...shift, startsAt: shift.endsAt, endsAt: '2026-11-01T13:00:00Z' }).expect(201);
    const l = await post('/workforce/leave', { userId, startsOn: '2026-11-01', endsOn: '2026-11-01', reason: 'Personal' }).expect(201);
    await post(`/workforce/leave/${l.body.id}/review`, { status: 'APPROVED' }).expect(201);
    await post(`/workforce/leave/${l.body.id}/review`, { status: 'REJECTED' }).expect(409);
    const overview = await request(ctx.app.getHttpServer()).get(`${base}/workforce`).set('Cookie', cookie).expect(200);
    expect(overview.body.shifts.every((s: { onLeave: boolean }) => s.onLeave)).toBe(true);
  });
  it('edits future shifts, prevents overlaps and records the actor and before/after', async () => {
    const dto = { userId, label: 'Planned', startsAt: new Date(Date.now()+7*86400000).toISOString(), endsAt: new Date(Date.now()+7*86400000+3600000).toISOString() };
    const shift = await post('/workforce/shifts', dto).expect(201);
    const revised = { ...dto, label: 'Revised', endsAt: new Date(new Date(dto.endsAt).getTime()+3600000).toISOString() };
    const put = (id: string, body: object, auth = cookie) => request(ctx.app.getHttpServer()).put(`${base}/workforce/shifts/${id}`).set('Cookie', auth).send(body);
    await put(shift.body.id, revised, otherCookie).expect(403);
    await put(shift.body.id, revised).expect(200);
    const second = await post('/workforce/shifts', { ...dto, startsAt: revised.endsAt, endsAt: new Date(new Date(revised.endsAt).getTime()+3600000).toISOString() }).expect(201);
    await put(second.body.id, dto).expect(409);
    const h = await request(ctx.app.getHttpServer()).get(`${base}/workforce/shifts/${shift.body.id}/history`).set('Cookie', cookie).expect(200);
    expect(h.body.items).toHaveLength(1);
    expect(h.body.items[0]).toMatchObject({ action: 'UPDATED', actorName: 'Owner', before: { label: 'Planned' }, after: { label: 'Revised' } });
  });
  it('retains cancelled shifts and their reasons while freeing the time slot', async () => {
    const dto = { userId, label: 'Upcoming', startsAt: new Date(Date.now()+86400000).toISOString(), endsAt: new Date(Date.now()+90000000).toISOString() };
    const shift = await post('/workforce/shifts', dto).expect(201);
    await post(`/workforce/shifts/${shift.body.id}/cancel`, { reason: '   ' }).expect(400);
    const cancelled = await post(`/workforce/shifts/${shift.body.id}/cancel`, { reason: 'Coverage moved' }).expect(201);
    expect(cancelled.body.cancelledAt).toBeTruthy();
    await post(`/workforce/shifts/${shift.body.id}/cancel`, { reason: 'Again' }).expect(409);
    await request(ctx.app.getHttpServer()).put(`${base}/workforce/shifts/${shift.body.id}`).set('Cookie', cookie).send(dto).expect(409);
    await post('/workforce/shifts', dto).expect(201);
    const h = await request(ctx.app.getHttpServer()).get(`${base}/workforce/shifts/${shift.body.id}/history`).set('Cookie', cookie).expect(200);
    expect(h.body.items[0]).toMatchObject({ action: 'CANCELLED', after: { cancellationReason: 'Coverage moved', cancelledById: userId } });
    const [{ count }] = await ctx.dataSource.query<Array<{ count: number }>>('SELECT COUNT(*)::int AS count FROM workforce_shifts');
    expect(count).toBe(2);
  });
  it('protects past schedules and rejects invalid lengths or changing the shift owner', async () => {
    const past = await post('/workforce/shifts', { userId, label: 'Past', startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-01T01:00:00Z' }).expect(201);
    await post(`/workforce/shifts/${past.body.id}/cancel`, { reason: 'Old' }).expect(409);
    const dto = { userId, label: 'Future', startsAt: new Date(Date.now()+86400000).toISOString(), endsAt: new Date(Date.now()+90000000).toISOString() };
    const put = (id: string, body: object) => request(ctx.app.getHttpServer()).put(`${base}/workforce/shifts/${id}`).set('Cookie', cookie).send(body);
    await put(past.body.id, dto).expect(409);
    const shift = await post('/workforce/shifts', dto).expect(201);
    await put(shift.body.id, { ...dto, endsAt: dto.startsAt }).expect(400);
    await put(shift.body.id, { ...dto, userId: randomUUID() }).expect(400);
  });
  it('keeps notifications, drafts and saved replies scoped to the authenticated user', async () => {
    const permissions = await ctx.dataSource.getRepository(Permission).save(['messages.read','messages.send'].map(key => ({ key, label: key, category: 'Inbox' })));
    const role = await ctx.dataSource.getRepository(Role).save({ key: 'agent', name: 'Agent', permissions });
    const otherUser = await ctx.dataSource.getRepository(User).findOneByOrFail({ username: 'other' });
    otherUser.roles = [role]; await ctx.dataSource.getRepository(User).save(otherUser);
    const reply = await post('/saved-replies', { title: 'Hello', body: 'How can we help?' }).expect(201);
    await request(ctx.app.getHttpServer()).put(`${base}/drafts`).set('Cookie', cookie).send({ destinationKey: 'group:a', body: 'My private draft' }).expect(200);
    const mine = await request(ctx.app.getHttpServer()).get(`${base}/drafts`).set('Cookie', cookie).expect(200); expect(mine.body.items).toHaveLength(1);
    const othersDrafts = await request(ctx.app.getHttpServer()).get(`${base}/drafts`).set('Cookie', otherCookie).expect(200); expect(othersDrafts.body.items).toHaveLength(0);
    const othersReplies = await request(ctx.app.getHttpServer()).get(`${base}/saved-replies`).set('Cookie', otherCookie).expect(200); expect(othersReplies.body.items).toHaveLength(0);
    await request(ctx.app.getHttpServer()).delete(`${base}/saved-replies/${reply.body.id}`).set('Cookie', otherCookie).expect(404);
    await ctx.dataSource.query('INSERT INTO workspace_notifications ("userId",title,body) VALUES ($1,$2,$3)', [userId,'Private','Owner only']);
    const other = await request(ctx.app.getHttpServer()).get(`${base}/notifications`).set('Cookie', otherCookie).expect(200); expect(other.body.items).toHaveLength(0);
    const own = await request(ctx.app.getHttpServer()).get(`${base}/notifications`).set('Cookie', cookie).expect(200); expect(own.body.unread).toBe(1);
    await request(ctx.app.getHttpServer()).post(`${base}/notifications/${own.body.items[0].id}/read`).set('Cookie', otherCookie).expect(201);
    const after = await request(ctx.app.getHttpServer()).get(`${base}/notifications`).set('Cookie', cookie); expect(after.body.unread).toBe(1);
  });
  it('hides draft releases, preserves edits and announces publication', async () => {
    const draft = { version: 'v1.0', title: 'New workspace', body: 'Better support tools.' };
    const r = await post('/releases', draft).expect(201);
    const get = () => request(ctx.app.getHttpServer()).get(`${base}/releases`).set('Cookie', otherCookie);
    expect((await get()).body.items).toHaveLength(0);
    await request(ctx.app.getHttpServer()).put(`${base}/releases/${r.body.id}`).set('Cookie', cookie).send({ ...draft, status: 'PUBLISHED' }).expect(200);
    expect((await get()).body.items).toHaveLength(1);
    const history = await request(ctx.app.getHttpServer()).get(`${base}/releases/${r.body.id}/history`).set('Cookie', cookie).expect(200); expect(history.body.items).toHaveLength(1);
    const notifications = await request(ctx.app.getHttpServer()).get(`${base}/notifications`).set('Cookie', otherCookie); expect(notifications.body.items).toHaveLength(1);
  });
  it('creates users without exposing hashes and immediately enforces deactivation', async () => {
    const r = await request(ctx.app.getHttpServer()).post('/api/v1/users').set('Cookie', cookie).send({ username: 'newagent', name: 'New agent', email: 'new@example.test', password: 'StrongPassword!123', roleIds: [] }).expect(201);
    expect(r.body.passwordHash).toBeUndefined();
    const login = await request(ctx.app.getHttpServer()).post('/api/v1/auth/login').send({ identifier: 'newagent', password: 'StrongPassword!123' }).expect(200);
    const newCookie = String(login.headers['set-cookie'][0]).split(';')[0];
    await request(ctx.app.getHttpServer()).patch(`/api/v1/users/${r.body.id}`).set('Cookie', cookie).send({ isActive: false }).expect(200);
    await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', newCookie).expect(401);
    await request(ctx.app.getHttpServer()).patch(`/api/v1/users/${userId}`).set('Cookie', cookie).send({ isActive: false }).expect(400);
  });
  it('restores only a release-owned snapshot as a draft and preserves the replaced content', async () => {
    const original = { version: 'v1.0', title: 'Original', body: 'Original notes' };
    const release = await post('/releases', original).expect(201);
    await request(ctx.app.getHttpServer()).put(`${base}/releases/${release.body.id}`).set('Cookie', cookie)
      .send({ ...original, title: 'Published revision', status: 'PUBLISHED' }).expect(200);
    const history = await request(ctx.app.getHttpServer()).get(`${base}/releases/${release.body.id}/history`).set('Cookie', cookie).expect(200);
    const versionId = history.body.items[0].id as string;
    await request(ctx.app.getHttpServer()).post(`${base}/releases/${release.body.id}/restore`).set('Cookie', otherCookie).send({ versionId }).expect(403);
    const unrelated = await post('/releases', { ...original, version: 'v2.0' }).expect(201);
    await post(`/releases/${unrelated.body.id}/restore`, { versionId }).expect(404);
    await post(`/releases/${release.body.id}/restore`, { versionId: 'invalid' }).expect(400);
    const restored = await post(`/releases/${release.body.id}/restore`, { versionId }).expect(201);
    expect(restored.body).toMatchObject({ ...original, status: 'DRAFT', publishedAt: null });
    const after = await request(ctx.app.getHttpServer()).get(`${base}/releases/${release.body.id}/history`).set('Cookie', cookie).expect(200);
    expect(after.body.items).toHaveLength(2);
    expect(after.body.items.some((h: { snapshot: { title: string } }) => h.snapshot.title === 'Published revision')).toBe(true);
    const feed = await request(ctx.app.getHttpServer()).get(`${base}/releases`).set('Cookie', otherCookie).expect(200);
    expect(feed.body.items).toHaveLength(0);
    const notifications = await request(ctx.app.getHttpServer()).get(`${base}/notifications`).set('Cookie', otherCookie).expect(200);
    expect(notifications.body.items).toHaveLength(1); // Publication only; restore sends nothing.
  });
  it('rolls back a restore and its history if another release owns the old version label', async () => {
    const dto = { version: 'v1.0', title: 'Original', body: 'Notes' };
    const release = await post('/releases', dto).expect(201);
    await request(ctx.app.getHttpServer()).put(`${base}/releases/${release.body.id}`).set('Cookie', cookie)
      .send({ ...dto, version: 'v1.1', status: 'DRAFT' }).expect(200);
    const history = await request(ctx.app.getHttpServer()).get(`${base}/releases/${release.body.id}/history`).set('Cookie', cookie).expect(200);
    await post('/releases', dto).expect(201);
    await post(`/releases/${release.body.id}/restore`, { versionId: history.body.items[0].id }).expect(409);
    const after = await request(ctx.app.getHttpServer()).get(`${base}/releases/${release.body.id}/history`).set('Cookie', cookie).expect(200);
    expect(after.body.items).toHaveLength(1);
    const [current] = await ctx.dataSource.query<Array<{ version: string }>>('SELECT version FROM workspace_releases WHERE id=$1', [release.body.id]);
    expect(current.version).toBe('v1.1');
  });
  it('revokes sessions after a password reset and protects super admin access', async () => {
    const other = await ctx.dataSource.getRepository(User).findOneByOrFail({ username: 'other' });
    await request(ctx.app.getHttpServer()).post(`/api/v1/users/${other.id}/password`).set('Cookie', cookie).send({ password: 'AnotherPassword!123' }).expect(201);
    await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', otherCookie).expect(401);
    const permissions = await ctx.dataSource.getRepository(Permission).save(['users.manage','roles.manage'].map(key => ({ key, label: key, category: 'Administration' })));
    const role = await ctx.dataSource.getRepository(Role).save({ key: 'limited_admin', name: 'Limited Admin', permissions });
    other.roles = [role]; await ctx.dataSource.getRepository(User).save(other);
    const login = await request(ctx.app.getHttpServer()).post('/api/v1/auth/login').send({ identifier: 'other', password: 'AnotherPassword!123' }).expect(200);
    const limitedCookie = String(login.headers['set-cookie'][0]).split(';')[0];
    const superRole = await ctx.dataSource.getRepository(Role).findOneByOrFail({ key: 'super_admin' });
    await request(ctx.app.getHttpServer()).post('/api/v1/users').set('Cookie', limitedCookie).send({ username: 'escalated', name: 'Escalated', email: 'escalated@example.test', password: 'StrongPassword!123', roleIds: [superRole.id] }).expect(403);
    await request(ctx.app.getHttpServer()).post(`/api/v1/users/${userId}/password`).set('Cookie', limitedCookie).send({ password: 'Unauthorized!123' }).expect(403);
  });
});
