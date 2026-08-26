import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';

/**
 * Owns every Redis connection in the process.
 *
 * `PROJECT_SPEC.md` §184: Redis is used for queues, locks, rate limiting, temporary state, job
 * progress and caching — and is NEVER the source of truth for business data. Anything durable lives
 * in Postgres; if Redis were flushed, the system must lose only in-flight coordination, never a
 * customer message, a decision, or a job record.
 *
 * Separate connections are handed out because BullMQ and the Socket.IO adapter put connections into
 * blocking/subscriber mode, where ordinary commands are rejected. Sharing one client across those
 * would break at runtime, so each subsystem gets its own and they are all closed on shutdown.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly connections: Redis[] = [];
  private readonly prefix: string;
  private client?: Redis;

  constructor(private readonly config: ConfigService) {
    this.prefix = this.config.getOrThrow<string>('redis.keyPrefix');
  }

  /** Base options; BullMQ requires `maxRetriesPerRequest: null` on its own connections. */
  private baseOptions(): RedisOptions {
    return {
      host: this.config.getOrThrow<string>('redis.host'),
      port: this.config.getOrThrow<number>('redis.port'),
      password: this.config.get<string>('redis.password'),
      db: this.config.getOrThrow<number>('redis.db'),
      lazyConnect: false,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    };
  }

  /** The shared general-purpose client, used for locks, rate limits and caching. */
  getClient(): Redis {
    if (!this.client) {
      this.client = this.createConnection();
    }
    return this.client;
  }

  /**
   * A dedicated connection. `blocking: true` removes the per-request retry cap, which BullMQ's
   * blocking reads require — with the cap in place they abort mid-wait.
   */
  createConnection(options: { blocking?: boolean } = {}): Redis {
    const connection = new Redis({
      ...this.baseOptions(),
      ...(options.blocking ? { maxRetriesPerRequest: null, enableReadyCheck: false } : {}),
    });
    // ioredis emits 'error' on every reconnect attempt; without a listener Node treats it as an
    // unhandled error event and kills the process during a transient Redis blip.
    connection.on('error', (err) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'redis', message: 'connection error', error: err.message })}\n`,
      );
    });
    this.connections.push(connection);
    return connection;
  }

  /**
   * Namespaces a key. Applied manually rather than via ioredis's `keyPrefix` option because BullMQ
   * and the Socket.IO adapter manage their own prefixes, and a client-level prefix would silently
   * double-prefix theirs.
   */
  key(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  /** Used by the health check — a real round trip, not a cached connection flag. */
  async ping(): Promise<boolean> {
    try {
      return (await this.getClient().ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }
}
