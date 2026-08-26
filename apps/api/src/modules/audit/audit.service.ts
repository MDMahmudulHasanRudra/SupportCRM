import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { AppLogger } from '../../common/logging/app-logger';
import { redact } from '../../common/logging/redact';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditLog } from './entities/audit-log.entity';

export interface AuditEntry {
  action: string;
  resource: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  success?: boolean;
}

export interface AuditActor {
  id: string | null;
  username: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** For an unattended action — a scheduled job, a webhook-driven change. */
export const SYSTEM_ACTOR: AuditActor = { id: null, username: 'system' };

@Injectable()
export class AuditService {
  private readonly logger = new AppLogger(AuditService.name);

  constructor(@InjectRepository(AuditLog) private readonly repo: Repository<AuditLog>) {}

  /**
   * Writes one audit row (`PROJECT_SPEC.md` §107).
   *
   * `before`/`after` pass through `redact()` first, so an entity carrying a `passwordHash` or an
   * `apiKey` cannot put it in the audit trail — a table many more people can read than can read the
   * original row.
   *
   * A failure to write is logged loudly but never propagated: an audit outage must not roll back
   * the business action the user successfully performed. The alternative — failing the request —
   * turns a logging problem into an outage.
   */
  async record(entry: AuditEntry, actor: AuditActor): Promise<void> {
    try {
      await this.repo.save(
        this.repo.create({
          actorId: actor.id,
          actorUsername: actor.username,
          action: entry.action,
          resource: entry.resource,
          resourceId: entry.resourceId ?? null,
          before: entry.before === undefined ? null : (redact(entry.before) as Record<string, unknown>),
          after: entry.after === undefined ? null : (redact(entry.after) as Record<string, unknown>),
          metadata: entry.metadata ? (redact(entry.metadata) as Record<string, unknown>) : null,
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent?.slice(0, 512) ?? null,
          success: entry.success ?? true,
        }),
      );
    } catch (error) {
      this.logger.error('Failed to write audit entry', {
        action: entry.action,
        resource: entry.resource,
        error: (error as Error).message,
      });
    }
  }

  /** Builds an actor from the request, so IP and user agent are captured consistently. */
  actorFromRequest(request: Request, user?: AuthenticatedUser): AuditActor {
    return {
      id: user?.id ?? null,
      username: user?.username ?? null,
      ipAddress: this.clientIp(request),
      userAgent: request.headers['user-agent'] ?? null,
    };
  }

  /**
   * Trusts `x-forwarded-for` only when Express itself is configured to trust the proxy — otherwise
   * any client could spoof its own address into the audit trail.
   */
  private clientIp(request: Request): string | null {
    return request.ip ?? request.socket?.remoteAddress ?? null;
  }

  async query(options: {
    actorId?: string;
    action?: string;
    resource?: string;
    resourceId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: AuditLog[]; total: number }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const qb = this.repo.createQueryBuilder('log').orderBy('log.createdAt', 'DESC');
    if (options.actorId) qb.andWhere('log.actorId = :actorId', { actorId: options.actorId });
    if (options.action) qb.andWhere('log.action = :action', { action: options.action });
    if (options.resource) qb.andWhere('log.resource = :resource', { resource: options.resource });
    if (options.resourceId) qb.andWhere('log.resourceId = :resourceId', { resourceId: options.resourceId });

    const [items, total] = await qb.skip(offset).take(limit).getManyAndCount();
    return { items, total };
  }
}
