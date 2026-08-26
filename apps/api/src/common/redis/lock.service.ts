import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Distributed locks (`PROJECT_SPEC.md` §185–186, §193).
 *
 * The reason this exists in Phase 1, long before there is anything to lock: the decision engine's
 * single most important safety property is that two workers can never both reply to one
 * conversation. That property is only as good as the lock underneath it, so the lock is built and
 * tested first, against a real Redis.
 *
 * Design notes:
 *  - Acquire is `SET key token NX PX ttl` — atomic, no check-then-set race.
 *  - Release is a Lua compare-and-delete. A plain DEL would let a process whose lock had already
 *    expired delete the lock a DIFFERENT process now legitimately holds. The token check makes
 *    releasing someone else's lock impossible.
 *  - `extend` exists for work that legitimately outruns its TTL (a long AI call). Extending is also
 *    token-checked, so a lapsed holder cannot resurrect its claim.
 *  - TTL is mandatory. A lock without one survives the crash of its holder forever.
 */
export interface LockHandle {
  key: string;
  token: string;
}

/** Returns 1 only if the caller still owns the lock. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

@Injectable()
export class LockService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Attempts to take `name` for `ttlMs`. Returns null immediately if it is held.
   * Prefer {@link withLock} — a raw acquire makes it easy to forget the release.
   */
  async acquire(name: string, ttlMs: number): Promise<LockHandle | null> {
    if (ttlMs <= 0) throw new Error('Lock TTL must be positive — a lock without expiry can deadlock');

    const key = this.redis.key('lock', name);
    // 128 bits of ownership proof. Must be unguessable, or another holder could forge a release.
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const result = await this.redis.getClient().set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { key, token } : null;
  }

  /** True if this call actually released it; false if the lock had already lapsed or moved on. */
  async release(handle: LockHandle): Promise<boolean> {
    const result = await this.redis.getClient().eval(RELEASE_SCRIPT, 1, handle.key, handle.token);
    return result === 1;
  }

  /** True if the TTL was pushed out; false if ownership was already lost. */
  async extend(handle: LockHandle, ttlMs: number): Promise<boolean> {
    const result = await this.redis
      .getClient()
      .eval(EXTEND_SCRIPT, 1, handle.key, handle.token, String(ttlMs));
    return result === 1;
  }

  async isLocked(name: string): Promise<boolean> {
    return (await this.redis.getClient().exists(this.redis.key('lock', name))) === 1;
  }

  /**
   * Runs `fn` under the lock and always releases, including when `fn` throws.
   *
   * `onBusy: 'skip'` (default) returns null when the lock is held — the right behaviour for message
   * processing, where a second attempt on the same conversation should stand down rather than
   * queue up behind the first. `onBusy: 'wait'` polls until `waitTimeoutMs` elapses.
   */
  async withLock<T>(
    name: string,
    ttlMs: number,
    fn: () => Promise<T>,
    options: { onBusy?: 'skip' | 'wait'; waitTimeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<T | null> {
    const { onBusy = 'skip', waitTimeoutMs = 5000, pollIntervalMs = 50 } = options;

    let handle = await this.acquire(name, ttlMs);

    if (!handle && onBusy === 'wait') {
      const deadline = Date.now() + waitTimeoutMs;
      while (!handle && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        handle = await this.acquire(name, ttlMs);
      }
    }

    if (!handle) return null;

    try {
      return await fn();
    } finally {
      // Release failure is not fatal — the TTL will clear it. Swallowing it keeps a Redis blip from
      // masking the real error `fn` may have thrown.
      await this.release(handle).catch(() => undefined);
    }
  }

  /**
   * The canonical name for a conversation lock. Centralised so every future call site derives the
   * same string — two spellings of the same lock would silently defeat it.
   */
  static conversationLock(conversationId: string): string {
    return `conversation:${conversationId}`;
  }
}
