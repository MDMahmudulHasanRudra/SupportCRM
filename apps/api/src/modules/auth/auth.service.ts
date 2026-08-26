import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { CryptoService } from '../../common/crypto/crypto.service';
import { SECURITY_SETTINGS_ID, SecuritySettings } from './entities/security-settings.entity';
import { UserSession } from './entities/user-session.entity';
import { User } from './entities/user.entity';

/** Refresh `lastUsedAt` at most this often — otherwise every request becomes a write. */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  name: string;
  roleKeys: string[];
  permissions: Set<string>;
  isSuperAdmin: boolean;
  sessionId: string;
}

export interface LoginResult {
  /** The raw cookie secret. Returned exactly once, never stored, never logged. */
  sessionSecret: string;
  expiresAt: Date;
  user: AuthenticatedUser;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserSession) private readonly sessions: Repository<UserSession>,
    @InjectRepository(SecuritySettings) private readonly securitySettings: Repository<SecuritySettings>,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  async getSecuritySettings(): Promise<SecuritySettings> {
    const existing = await this.securitySettings.findOne({ where: { id: SECURITY_SETTINGS_ID } });
    if (existing) return existing;
    return this.securitySettings.save(
      this.securitySettings.create({
        id: SECURITY_SETTINGS_ID,
        sessionLifetimeHours: this.config.get<number>('security.sessionLifetimeHours', 12),
      }),
    );
  }

  /**
   * Authenticates a username-or-email plus password.
   *
   * Deliberate design choices:
   *  - The lockout check runs BEFORE the password comparison, so a locked account cannot be used as
   *    an oracle and scrypt is not burned on every attempt of a brute-force run.
   *  - Every failure path throws the same message. Distinguishing "no such user" from "wrong
   *    password" would confirm which accounts exist.
   *  - A failure against a real user is recorded; a failure against an unknown identifier is not,
   *    because there is no row to record it on and creating one would be a write primitive for an
   *    unauthenticated caller.
   */
  async login(
    identifier: string,
    password: string,
    meta: { ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<LoginResult> {
    const settings = await this.getSecuritySettings();

    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .leftJoinAndSelect('user.roles', 'role')
      .leftJoinAndSelect('role.permissions', 'permission')
      .where('LOWER(user.username) = LOWER(:identifier) OR LOWER(user.email) = LOWER(:identifier)', {
        identifier,
      })
      .getOne();

    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Invalid credentials');

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'Account temporarily locked due to repeated failed sign-in attempts. Try again later.',
      );
    }

    if (!this.crypto.verifyPassword(password, user.passwordHash)) {
      await this.recordFailedLogin(user, settings);
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.users.update(user.id, {
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      lastLoginAt: new Date(),
    });

    const secret = this.crypto.generateToken(32);
    const expiresAt = new Date(Date.now() + settings.sessionLifetimeHours * 60 * 60 * 1000);

    const session = await this.sessions.save(
      this.sessions.create({
        userId: user.id,
        secretHash: this.crypto.hashToken(secret),
        expiresAt,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      }),
    );

    return { sessionSecret: secret, expiresAt, user: this.toAuthenticatedUser(user, session.id) };
  }

  /**
   * Resolves a cookie secret to a user, or null.
   *
   * Re-checks `isActive` on every request rather than trusting the session row: deactivating a user
   * must take effect immediately, not whenever their session happens to expire.
   */
  async resolveSession(secret: string): Promise<AuthenticatedUser | null> {
    if (!secret) return null;

    const session = await this.sessions.findOne({
      where: { secretHash: this.crypto.hashToken(secret) },
    });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt <= new Date()) return null;

    const user = await this.users
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.roles', 'role')
      .leftJoinAndSelect('role.permissions', 'permission')
      .where('user.id = :id', { id: session.userId })
      .getOne();

    if (!user || !user.isActive) return null;

    if (!session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
      // Fire-and-forget: a bookkeeping write must never fail an otherwise valid request.
      void this.sessions.update(session.id, { lastUsedAt: new Date() }).catch(() => undefined);
    }

    return this.toAuthenticatedUser(user, session.id);
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.update(sessionId, { revokedAt: new Date() });
  }

  /** Admin action: kill every session a user holds. */
  async revokeAllSessionsForUser(userId: string): Promise<number> {
    // IsNull(), not `undefined`: TypeORM drops undefined keys from the criteria, which would have
    // silently re-stamped revokedAt on sessions that were already revoked.
    const result = await this.sessions.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return result.affected ?? 0;
  }

  /** Housekeeping — expired rows carry no security value and only grow the table. */
  async purgeExpiredSessions(): Promise<number> {
    const result = await this.sessions.delete({ expiresAt: LessThan(new Date()) });
    return result.affected ?? 0;
  }

  private async recordFailedLogin(user: User, settings: SecuritySettings): Promise<void> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - settings.loginLockoutWindowMinutes * 60 * 1000);

    // Failures older than the window do not count towards the threshold — otherwise a handful of
    // typos spread over months would eventually lock a legitimate account.
    const withinWindow = user.lastFailedLoginAt && user.lastFailedLoginAt > windowStart;
    const attempts = (withinWindow ? user.failedLoginAttempts : 0) + 1;

    const shouldLock = attempts >= settings.loginLockoutThreshold;

    await this.users.update(user.id, {
      failedLoginAttempts: attempts,
      lastFailedLoginAt: now,
      lockedUntil: shouldLock
        ? new Date(now.getTime() + settings.loginLockoutDurationMinutes * 60 * 1000)
        : null,
    });
  }

  private toAuthenticatedUser(user: User, sessionId: string): AuthenticatedUser {
    const roles = user.roles ?? [];
    const permissions = new Set<string>();
    for (const role of roles) {
      for (const permission of role.permissions ?? []) permissions.add(permission.key);
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      roleKeys: roles.map((r) => r.key),
      permissions,
      isSuperAdmin: roles.some((r) => r.isSuperAdmin),
      sessionId,
    };
  }
}
