import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { RateLimitService, type RateLimitResult } from '../../common/redis/rate-limit.service';
import { RateLimitPolicy, RateLimitScope } from './entities/rate-limit-policy.entity';

/**
 * Configurable rate limits (`PROJECT_SPEC.md` §57, §175).
 *
 * The counting is Redis's job and already existed; what was missing is that the *numbers* were
 * constants. §57 requires them configurable per session, group, destination, broadcast, automation,
 * AI and API — so a policy row can narrow any scope, and a code default applies when none does.
 *
 * The defaults below are deliberately conservative. §175 is explicit that these are account-safety
 * controls: nothing here exists to push past a platform restriction, and an operator raising a
 * limit is taking on that risk knowingly.
 */

export const DEFAULT_LIMITS: Record<RateLimitScope, { limit: number; windowSeconds: number }> = {
  // Per WhatsApp session. The one most likely to get an account restricted if abused.
  [RateLimitScope.SESSION]: { limit: 20, windowSeconds: 60 },
  [RateLimitScope.GROUP]: { limit: 10, windowSeconds: 60 },
  // Per individual recipient — the strictest, because repeatedly messaging one person is what
  // reads as harassment to a platform and to the person.
  [RateLimitScope.DESTINATION]: { limit: 4, windowSeconds: 60 },
  [RateLimitScope.BROADCAST]: { limit: 30, windowSeconds: 60 },
  [RateLimitScope.AUTOMATION]: { limit: 60, windowSeconds: 60 },
  [RateLimitScope.AI]: { limit: 60, windowSeconds: 60 },
  [RateLimitScope.API]: { limit: 600, windowSeconds: 60 },
};

@Injectable()
export class RateLimitPolicyService {
  constructor(
    @InjectRepository(RateLimitPolicy) private readonly policies: Repository<RateLimitPolicy>,
    private readonly limiter: RateLimitService,
  ) {}

  /** The numbers in force for a scope: a specific row, then the scope default, then the code default. */
  async resolve(scope: RateLimitScope, scopeId?: string | null): Promise<{ limit: number; windowSeconds: number }> {
    if (scopeId) {
      const specific = await this.policies.findOne({ where: { scope, scopeId, isActive: true } });
      if (specific) return { limit: specific.limit, windowSeconds: specific.windowSeconds };
    }

    const general = await this.policies.findOne({ where: { scope, scopeId: IsNull(), isActive: true } });
    if (general) return { limit: general.limit, windowSeconds: general.windowSeconds };

    return DEFAULT_LIMITS[scope];
  }

  /** Consumes one unit against the resolved policy. */
  async consume(scope: RateLimitScope, subject: string, scopeId?: string | null): Promise<RateLimitResult> {
    const { limit, windowSeconds } = await this.resolve(scope, scopeId);
    return this.limiter.consume(`rl:${scope}:${subject}`, limit, windowSeconds * 1000);
  }

  /** Asks without consuming — for a preview, or a check before a batch commits to sending. */
  async peek(scope: RateLimitScope, subject: string, scopeId?: string | null): Promise<RateLimitResult> {
    const { limit, windowSeconds } = await this.resolve(scope, scopeId);
    return this.limiter.peek(`rl:${scope}:${subject}`, limit, windowSeconds * 1000);
  }

  async list(): Promise<RateLimitPolicy[]> {
    return this.policies.find({ order: { scope: 'ASC', createdAt: 'ASC' } });
  }

  /** Everything in force, including the scopes nobody has overridden. For the settings screen. */
  async effective(): Promise<Array<{ scope: RateLimitScope; limit: number; windowSeconds: number; source: 'policy' | 'default' }>> {
    const rows = await this.policies.find({ where: { scopeId: IsNull(), isActive: true } });

    return Object.values(RateLimitScope).map((scope) => {
      const row = rows.find((policy) => policy.scope === scope);
      return row
        ? { scope, limit: row.limit, windowSeconds: row.windowSeconds, source: 'policy' as const }
        : { ...DEFAULT_LIMITS[scope], scope, source: 'default' as const };
    });
  }

  async upsert(input: {
    scope: RateLimitScope;
    scopeId?: string | null;
    limit: number;
    windowSeconds: number;
    note?: string | null;
    userId: string | null;
  }): Promise<RateLimitPolicy> {
    const scopeId = input.scopeId ?? null;
    const existing = await this.policies.findOne({
      where: { scope: input.scope, scopeId: scopeId === null ? IsNull() : scopeId },
    });

    if (existing) {
      await this.policies.update(existing.id, {
        limit: input.limit,
        windowSeconds: input.windowSeconds,
        note: input.note ?? null,
        updatedById: input.userId,
      });
      return this.policies.findOneOrFail({ where: { id: existing.id } });
    }

    return this.policies.save(
      this.policies.create({
        scope: input.scope,
        scopeId,
        limit: input.limit,
        windowSeconds: input.windowSeconds,
        note: input.note ?? null,
        updatedById: input.userId,
      }),
    );
  }
}
