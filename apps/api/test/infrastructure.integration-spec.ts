import { LockService } from '../src/common/redis/lock.service';
import { RateLimitService } from '../src/common/redis/rate-limit.service';
import { RedisService } from '../src/common/redis/redis.service';
import { closeTestApp, createTestApp, resetDatabase, type TestContext } from './setup';

/**
 * Phase 1 acceptance criterion 1, infrastructure half: Redis-backed locks, rate limits and dedupe
 * behave correctly against a REAL Redis.
 *
 * These primitives are the foundation of the decision engine's most important safety property —
 * two workers must never both reply to one conversation (`PROJECT_SPEC.md` §186, §193) — so they
 * are tested against the real thing before anything depends on them.
 */
describe('Redis infrastructure (integration)', () => {
  let ctx: TestContext;
  let locks: LockService;
  let rateLimits: RateLimitService;
  let redis: RedisService;

  beforeAll(async () => {
    ctx = await createTestApp();
    locks = ctx.app.get(LockService);
    rateLimits = ctx.app.get(RateLimitService);
    redis = ctx.app.get(RedisService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    // Clear only this test run's namespace — never a blanket FLUSHALL, which would wipe a
    // developer's dev-stack Redis if it happened to be the same instance.
    const client = redis.getClient();
    const keys = await client.keys(`${redis.key('')}*`);
    if (keys.length > 0) await client.del(...keys);
  });

  describe('distributed locks', () => {
    it('grants a lock and refuses a second holder', async () => {
      const first = await locks.acquire('resource-a', 5000);
      expect(first).not.toBeNull();

      const second = await locks.acquire('resource-a', 5000);
      expect(second).toBeNull();
    });

    it('frees the lock on release', async () => {
      const handle = await locks.acquire('resource-b', 5000);
      expect(await locks.release(handle!)).toBe(true);
      expect(await locks.acquire('resource-b', 5000)).not.toBeNull();
    });

    it('expires on its own so a crashed holder cannot deadlock the resource', async () => {
      await locks.acquire('resource-c', 300);
      expect(await locks.acquire('resource-c', 300)).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await locks.acquire('resource-c', 1000)).not.toBeNull();
    });

    it('will not let a lapsed holder release the new holder’s lock', async () => {
      // The exact race a plain DEL-based release gets wrong.
      const stale = await locks.acquire('resource-d', 200);
      await new Promise((resolve) => setTimeout(resolve, 400));

      const fresh = await locks.acquire('resource-d', 5000);
      expect(fresh).not.toBeNull();

      expect(await locks.release(stale!)).toBe(false);
      expect(await locks.isLocked('resource-d')).toBe(true);
    });

    it('extends a lock only for its true owner', async () => {
      const handle = await locks.acquire('resource-e', 500);
      expect(await locks.extend(handle!, 5000)).toBe(true);
      expect(await locks.extend({ key: handle!.key, token: 'forged' }, 5000)).toBe(false);
    });

    it('serialises concurrent contenders — only one runs the critical section', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      let executions = 0;

      const attempt = () =>
        locks.withLock('resource-f', 5000, async () => {
          executions++;
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 100));
          concurrent--;
        });

      const results = await Promise.all(Array.from({ length: 10 }, attempt));

      expect(maxConcurrent).toBe(1);
      expect(executions).toBe(1);
      // The other nine stood down rather than queueing — the correct behaviour for message
      // processing, where a duplicate decision is worse than a skipped one.
      expect(results.filter((r) => r === null)).toHaveLength(9);
    });

    it('releases the lock even when the critical section throws', async () => {
      await expect(
        locks.withLock('resource-g', 5000, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await locks.isLocked('resource-g')).toBe(false);
    });

    it('waits for the lock when asked to', async () => {
      const handle = await locks.acquire('resource-h', 5000);
      setTimeout(() => void locks.release(handle!), 200);

      const result = await locks.withLock('resource-h', 5000, async () => 'ran', {
        onBusy: 'wait',
        waitTimeoutMs: 3000,
      });
      expect(result).toBe('ran');
    });

    it('refuses a lock with no expiry', async () => {
      await expect(locks.acquire('resource-i', 0)).rejects.toThrow(/positive/);
    });

    it('derives one canonical conversation-lock name', () => {
      expect(LockService.conversationLock('abc')).toBe('conversation:abc');
    });
  });

  describe('rate limiting', () => {
    it('allows up to the limit and refuses beyond it', async () => {
      for (let i = 1; i <= 3; i++) {
        const result = await rateLimits.consume('session:x', 3, 60_000);
        expect(result.allowed).toBe(true);
        expect(result.current).toBe(i);
      }
      expect((await rateLimits.consume('session:x', 3, 60_000)).allowed).toBe(false);
    });

    it('keeps scopes independent', async () => {
      await rateLimits.consume('session:a', 1, 60_000);
      expect((await rateLimits.consume('session:a', 1, 60_000)).allowed).toBe(false);
      expect((await rateLimits.consume('session:b', 1, 60_000)).allowed).toBe(true);
    });

    it('recovers after the window elapses', async () => {
      await rateLimits.consume('session:short', 1, 300);
      expect((await rateLimits.consume('session:short', 1, 300)).allowed).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await rateLimits.consume('session:short', 1, 300)).allowed).toBe(true);
    });

    it('does not consume quota when only peeking', async () => {
      await rateLimits.consume('session:peek', 2, 60_000);
      await rateLimits.peek('session:peek', 2, 60_000);
      await rateLimits.peek('session:peek', 2, 60_000);
      // Still one consumed, not three — a pre-send check that aborts must not burn budget.
      expect((await rateLimits.peek('session:peek', 2, 60_000)).current).toBe(1);
    });

    it('refuses everything when the limit is zero', async () => {
      expect((await rateLimits.consume('session:zero', 0, 60_000)).allowed).toBe(false);
    });

    it('holds under concurrency — never more than `limit` allowed', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => rateLimits.consume('session:race', 10, 60_000)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(10);
    });
  });

  describe('deduplication', () => {
    it('reports a key as first-seen exactly once', async () => {
      expect(await rateLimits.markFirstSeen('msg:1', 60_000)).toBe(true);
      expect(await rateLimits.markFirstSeen('msg:1', 60_000)).toBe(false);
      expect(await rateLimits.markFirstSeen('msg:2', 60_000)).toBe(true);
    });

    it('survives a concurrent burst — one winner only', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => rateLimits.markFirstSeen('msg:burst', 60_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('key namespacing', () => {
    it('prefixes every key so two deployments can share one Redis', () => {
      expect(redis.key('lock', 'x')).toBe('support-crm-test:lock:x');
    });

    it('answers a real PING', async () => {
      expect(await redis.ping()).toBe(true);
    });
  });
});
