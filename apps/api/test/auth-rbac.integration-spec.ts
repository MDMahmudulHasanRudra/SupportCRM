import request from 'supertest';
import { In, Repository } from 'typeorm';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { UserSession } from '../src/modules/auth/entities/user-session.entity';
import { User } from '../src/modules/auth/entities/user.entity';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { PERMISSIONS, ROLES } from '../src/modules/rbac/permissions.catalogue';
import { closeTestApp, createTestApp, extractCookie, resetDatabase, type TestContext } from './setup';

const COOKIE = 'support_crm_session';

/**
 * Phase 1 acceptance criteria 2 and 4:
 *   "A seeded admin can log in; a second role is genuinely denied a protected route."
 *   "Every config change produces an audit_logs row with before/after."
 *
 * Against a real Postgres, through the real global guards.
 */
describe('Auth, RBAC and audit (integration)', () => {
  let ctx: TestContext;
  let users: Repository<User>;
  let roles: Repository<Role>;
  let permissions: Repository<Permission>;
  let sessions: Repository<UserSession>;
  let auditLogs: Repository<AuditLog>;
  let crypto: CryptoService;

  beforeAll(async () => {
    ctx = await createTestApp();
    users = ctx.dataSource.getRepository(User);
    roles = ctx.dataSource.getRepository(Role);
    permissions = ctx.dataSource.getRepository(Permission);
    sessions = ctx.dataSource.getRepository(UserSession);
    auditLogs = ctx.dataSource.getRepository(AuditLog);
    crypto = ctx.app.get(CryptoService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    await seedRolesAndPermissions();
    await ctx.dataSource
      .getRepository(SecuritySettings)
      .save({ id: SECURITY_SETTINGS_ID } as SecuritySettings);
  });

  async function seedRolesAndPermissions(): Promise<void> {
    await permissions.save(
      PERMISSIONS.map((p) =>
        permissions.create({
          key: p.key,
          label: p.label,
          category: p.category,
          isDangerous: p.isDangerous ?? false,
        }),
      ),
    );
    for (const definition of ROLES) {
      await roles.save(
        roles.create({
          key: definition.key,
          name: definition.name,
          description: definition.description,
          isSystem: true,
          isSuperAdmin: definition.isSuperAdmin ?? false,
          permissions: await permissions.find({ where: { key: In([...definition.permissions]) } }),
        }),
      );
    }
  }

  async function createUser(username: string, roleKey: string, password = 'Password!123'): Promise<User> {
    const role = await roles.findOneOrFail({ where: { key: roleKey } });
    return users.save(
      users.create({
        username,
        email: `${username}@example.com`,
        name: username,
        passwordHash: crypto.hashPassword(password),
        isActive: true,
        roles: [role],
      }),
    );
  }

  async function login(username: string, password = 'Password!123'): Promise<string> {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: username, password })
      .expect(200);
    const cookie = extractCookie(response.headers['set-cookie'] as unknown as string[], COOKIE);
    expect(cookie).toBeTruthy();
    return `${COOKIE}=${cookie}`;
  }

  describe('login', () => {
    it('signs in a seeded admin and returns their effective permissions', async () => {
      await createUser('admin', 'super_admin');

      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'admin', password: 'Password!123' })
        .expect(200);

      expect(response.body.user.username).toBe('admin');
      expect(response.body.user.isSuperAdmin).toBe(true);
      expect(response.body.user.permissions.length).toBeGreaterThan(0);
    });

    it('accepts an email as the identifier', async () => {
      await createUser('admin', 'super_admin');
      await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'admin@example.com', password: 'Password!123' })
        .expect(200);
    });

    it('sets an httpOnly session cookie and never returns the raw secret in the body', async () => {
      await createUser('admin', 'super_admin');
      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'admin', password: 'Password!123' })
        .expect(200);

      const raw = (response.headers['set-cookie'] as unknown as string[])[0];
      expect(raw.toLowerCase()).toContain('httponly');
      expect(raw.toLowerCase()).toContain('samesite=lax');

      const secret = extractCookie(response.headers['set-cookie'] as unknown as string[], COOKIE)!;
      expect(JSON.stringify(response.body)).not.toContain(secret);
    });

    it('stores only the hash of the session secret, never the secret itself', async () => {
      await createUser('admin', 'super_admin');
      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'admin', password: 'Password!123' })
        .expect(200);

      const secret = extractCookie(response.headers['set-cookie'] as unknown as string[], COOKIE)!;
      const stored = await sessions.find();
      expect(stored).toHaveLength(1);
      expect(stored[0].secretHash).toBe(crypto.hashToken(secret));
      expect(stored[0].secretHash).not.toBe(secret);
    });

    it('rejects a wrong password with the same message as an unknown user', async () => {
      await createUser('admin', 'super_admin');
      const wrongPassword = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'admin', password: 'nope' })
        .expect(401);
      const unknownUser = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'ghost', password: 'nope' })
        .expect(401);

      // Identical responses — otherwise login is an account-enumeration oracle.
      expect(wrongPassword.body.message).toBe(unknownUser.body.message);
    });

    it('rejects a deactivated user', async () => {
      const user = await createUser('admin', 'super_admin');
      await users.update(user.id, { isActive: false });
      await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'admin', password: 'Password!123' })
        .expect(401);
    });

    it('locks the account after the configured number of failures', async () => {
      await createUser('admin', 'super_admin');
      const settings = await ctx.dataSource.getRepository(SecuritySettings).findOneOrFail({
        where: { id: SECURITY_SETTINGS_ID },
      });

      for (let i = 0; i < settings.loginLockoutThreshold; i++) {
        await request(ctx.app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ identifier: 'admin', password: 'wrong' })
          .expect(401);
      }

      // Even the CORRECT password is now refused — proof the lock precedes the password check.
      const locked = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'admin', password: 'Password!123' })
        .expect(401);
      expect(locked.body.message).toMatch(/locked/i);
    });

    it('records both successful and failed sign-ins in the audit log', async () => {
      await createUser('admin', 'super_admin');
      await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'admin', password: 'wrong' })
        .expect(401);
      await login('admin');

      const entries = await auditLogs.find({ order: { createdAt: 'ASC' } });
      expect(entries.map((e) => e.action)).toEqual(['auth.login_failed', 'auth.login']);
      expect(entries[0].success).toBe(false);

      // The attempted password must appear nowhere in the audit trail.
      expect(JSON.stringify(entries)).not.toContain('wrong');
    });
  });

  describe('session lifecycle', () => {
    it('rejects an unauthenticated request to a protected route', async () => {
      await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    });

    it('rejects a forged cookie', async () => {
      await request(ctx.app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', `${COOKIE}=not-a-real-secret`)
        .expect(401);
    });

    it('revokes the session server-side on logout', async () => {
      await createUser('admin', 'super_admin');
      const cookie = await login('admin');

      await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      await request(ctx.app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
      // Same cookie, now dead — this is what a stateless token could not do.
      await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    });

    it('invalidates a live session the moment the user is deactivated', async () => {
      const user = await createUser('admin', 'super_admin');
      const cookie = await login('admin');
      await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

      await users.update(user.id, { isActive: false });
      await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    });

    it('rejects an expired session', async () => {
      await createUser('admin', 'super_admin');
      const cookie = await login('admin');
      // TypeORM rejects an empty update criteria, so scope it to this user's sessions.
      const user = await users.findOneOrFail({ where: { username: 'admin' } });
      await sessions.update({ userId: user.id }, { expiresAt: new Date(Date.now() - 1000) });
      await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    });
  });

  describe('RBAC enforcement', () => {
    it('allows a role that holds the permission', async () => {
      await createUser('manager', 'support_manager');
      const cookie = await login('manager');
      await request(ctx.app.getHttpServer()).get('/api/v1/audit').set('Cookie', cookie).expect(200);
    });

    it('denies a role that does not — the acceptance-criteria case', async () => {
      // report_viewer holds reports.view only; the audit log requires audit.view.
      await createUser('viewer', 'report_viewer');
      const cookie = await login('viewer');

      const denied = await request(ctx.app.getHttpServer())
        .get('/api/v1/audit')
        .set('Cookie', cookie)
        .expect(403);
      expect(denied.body.message).toMatch(/audit\.view/);
    });

    it('denies a support executive the settings-management route', async () => {
      await createUser('exec', 'support_executive');
      const cookie = await login('exec');
      await request(ctx.app.getHttpServer())
        .put('/api/v1/settings/some.key')
        .set('Cookie', cookie)
        .send({ value: 'x' })
        .expect(403);
    });

    it('lets a super admin through a route no role explicitly grants', async () => {
      await createUser('root', 'super_admin');
      const cookie = await login('root');
      await request(ctx.app.getHttpServer())
        .put('/api/v1/settings/some.key')
        .set('Cookie', cookie)
        .send({ value: 'x' })
        .expect(200);
    });

    it('refuses an unknown permission key instead of granting a partial set', async () => {
      await createUser('root', 'super_admin');
      const cookie = await login('root');
      const role = await roles.findOneOrFail({ where: { key: 'report_viewer' } });

      const response = await request(ctx.app.getHttpServer())
        .put(`/api/v1/rbac/roles/${role.id}/permissions`)
        .set('Cookie', cookie)
        .send({ permissionKeys: ['reports.view', 'totally.made_up'] })
        .expect(400);
      expect(response.body.message).toMatch(/totally\.made_up/);

      // Nothing was applied — a partial grant would be worse than an outright failure.
      const unchanged = await roles.findOneOrFail({
        where: { key: 'report_viewer' },
        relations: ['permissions'],
      });
      expect(unchanged.permissions.map((p) => p.key)).toContain('conversations.read');
    });

    it('refuses to edit the super admin role', async () => {
      await createUser('root', 'super_admin');
      const cookie = await login('root');
      const role = await roles.findOneOrFail({ where: { key: 'super_admin' } });

      await request(ctx.app.getHttpServer())
        .put(`/api/v1/rbac/roles/${role.id}/permissions`)
        .set('Cookie', cookie)
        .send({ permissionKeys: [] })
        .expect(400);
    });

    it('writes a before/after audit row when a role’s permissions change', async () => {
      await createUser('root', 'super_admin');
      const cookie = await login('root');
      const role = await roles.findOneOrFail({ where: { key: 'report_viewer' } });

      await request(ctx.app.getHttpServer())
        .put(`/api/v1/rbac/roles/${role.id}/permissions`)
        .set('Cookie', cookie)
        .send({ permissionKeys: ['reports.view'] })
        .expect(200);

      const entry = await auditLogs.findOneOrFail({
        where: { action: 'rbac.role_permissions_updated' },
      });
      expect((entry.before as { permissions: string[] }).permissions.length).toBeGreaterThan(1);
      expect((entry.after as { permissions: string[] }).permissions).toEqual(['reports.view']);
      expect(entry.actorUsername).toBe('root');
    });
  });

  describe('database constraints', () => {
    it('enforces unique usernames', async () => {
      await createUser('dup', 'report_viewer');
      await expect(createUser('dup', 'report_viewer')).rejects.toThrow();
    });

    it('rejects a role_permissions row referencing a nonexistent permission', async () => {
      // The point of a real permissions TABLE rather than a string enum: a typo fails closed
      // against a foreign key instead of silently becoming an ungranted (or worse, granted) key.
      const role = await roles.findOneOrFail({ where: { key: 'report_viewer' } });
      await expect(
        ctx.dataSource.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, gen_random_uuid())`,
          [role.id],
        ),
      ).rejects.toThrow();
    });

    it('never selects the password hash by default', async () => {
      await createUser('admin', 'super_admin');
      const found = await users.findOneOrFail({ where: { username: 'admin' } });
      expect(found.passwordHash).toBeUndefined();
    });
  });
});
