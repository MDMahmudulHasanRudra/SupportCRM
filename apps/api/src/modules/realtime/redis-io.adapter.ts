import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions, Server } from 'socket.io';
import { AppLogger } from '../../common/logging/app-logger';
import { RedisService } from '../../common/redis/redis.service';

/**
 * Bridges Socket.IO across processes.
 *
 * Without this, `server.to(room).emit(...)` only reaches sockets connected to the *emitting*
 * process — and almost every realtime event in Support CRM originates in the worker, which no
 * browser ever connects to. Inbound messages, connection-state changes and pairing codes are all
 * produced by queue processors; the operator's socket lives on an API replica. The two are only
 * joined by this adapter, which publishes each emission to Redis for every other node to deliver
 * locally.
 *
 * It is installed in BOTH run modes for that reason. The worker's Socket.IO server accepts no
 * browser connections — it exists solely so its emissions reach the ones that do.
 *
 * Redis is a transport here, not a source of truth (`docs/adr/0001` §5): a message that nobody is
 * connected to receive is simply dropped, and the durable record of what happened is the row the
 * processor already wrote to PostgreSQL.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new AppLogger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly redis: RedisService,
  ) {
    super(app);
  }

  /**
   * Two dedicated connections, as the Redis pub/sub protocol requires: a subscribed connection can
   * issue no other command, so the publisher cannot share it.
   */
  async connect(): Promise<void> {
    const pubClient = this.redis.createConnection();
    const subClient = pubClient.duplicate();

    subClient.on('error', (error: Error) =>
      this.logger.warn('Realtime subscriber connection error', { error: error.message }),
    );

    this.adapterConstructor = createAdapter(pubClient, subClient, {
      // Namespaced with everything else this deployment owns in Redis, so two environments sharing
      // an instance never deliver each other's events.
      key: this.redis.key('socket.io'),
    });

    this.logger.log('Realtime cross-process delivery enabled');
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    } else {
      // Reachable only if `connect()` was skipped. Say so loudly: the symptom otherwise is a UI
      // that silently stops updating, which is very hard to trace back to here.
      this.logger.error('Realtime adapter is not connected — events will not cross processes');
    }

    return server;
  }
}
