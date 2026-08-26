import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Redis-backed rate limiting (`PROJECT_SPEC.md` §57, §175).
 *
 * Replaces the prior system's `COUNT(*)`-per-send approach, which issued three aggregate queries
 * against the hottest table in the database on every outbound message. The POLICY is unchanged —
 * per session, per group, per destination, per broadcast, per automation, per AI, per API, all
 * configurable. Only the counter storage moved.
 *
 * Implementation is a fixed-window INCR with an EXPIRE set on first write, done in one pipeline so
 * a crash between the two cannot leave an immortal counter. A sliding window would be smoother, but
 * WhatsApp safety limits are naturally expressed as "no more than N per minute", and a fixed window
 * is O(1) in both time and memory where a sorted-set sliding window is not — which matters when
 * every message checks several limits.
 *
 * `consume()` is the only method that increments. `peek()` deliberately does not, so a pre-send
 * check that later aborts for an unrelated reason does not burn quota.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Requests used in the current window, including this one when `allowed` is true. */
  current: number;
  limit: number;
  /** Milliseconds until the window resets. */
  resetInMs: number;
}

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Attempts to consume one unit from `scope`'s budget.
   *
   * Over-limit calls still INCR. That is intentional: it makes a sustained flood visible in the
   * counter, and it keeps the operation a single atomic round trip. The window still expires on
   * schedule, so quota is never permanently lost.
   */
  async consume(scope: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (limit <= 0) {
      return { allowed: false, current: 0, limit, resetInMs: windowMs };
    }

    const key = this.windowKey(scope, windowMs);
    const results = await this.redis
      .getClient()
      .multi()
      .incr(key)
      .pexpire(key, windowMs, 'NX') // NX: only the first write of a window sets its TTL
      .pttl(key)
      .exec();

    if (!results) {
      // A failed MULTI means Redis is unreachable. Fail CLOSED: an unlimited send rate is an
      // account-safety risk (PROJECT_SPEC.md §175), which is worse than a delayed message.
      return { allowed: false, current: 0, limit, resetInMs: windowMs };
    }

    const current = Number(results[0]?.[1] ?? 0);
    const ttl = Number(results[2]?.[1] ?? windowMs);

    return {
      allowed: current <= limit,
      current,
      limit,
      resetInMs: ttl > 0 ? ttl : windowMs,
    };
  }

  /** Reads usage without consuming. */
  async peek(scope: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const key = this.windowKey(scope, windowMs);
    const client = this.redis.getClient();
    const [raw, ttl] = await Promise.all([client.get(key), client.pttl(key)]);
    const current = Number(raw ?? 0);

    return {
      allowed: current < limit,
      current,
      limit,
      resetInMs: ttl > 0 ? ttl : windowMs,
    };
  }

  /** Clears a scope. Operator action only (an emergency-stop recovery), and always audited. */
  async reset(scope: string, windowMs: number): Promise<void> {
    await this.redis.getClient().del(this.windowKey(scope, windowMs));
  }

  /**
   * Deduplication helper (`PROJECT_SPEC.md` §59).
   *
   * Returns true the FIRST time a key is seen within `ttlMs`, false afterwards. This is a
   * best-effort fast path only — the authoritative duplicate guard is the unique index in Postgres,
   * because Redis can be flushed and must never be the source of truth (§184).
   */
  async markFirstSeen(dedupeKey: string, ttlMs: number): Promise<boolean> {
    const key = this.redis.key('dedupe', dedupeKey);
    return (await this.redis.getClient().set(key, '1', 'PX', ttlMs, 'NX')) === 'OK';
  }

  /**
   * Window-aligned key: every caller in the same window hits the same counter, and the key changes
   * on its own at the boundary, so an abandoned window is never re-read.
   */
  private windowKey(scope: string, windowMs: number): string {
    const bucket = Math.floor(Date.now() / windowMs);
    return this.redis.key('ratelimit', scope, String(windowMs), String(bucket));
  }
}
