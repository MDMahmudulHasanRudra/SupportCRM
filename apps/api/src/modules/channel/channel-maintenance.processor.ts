import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap,Optional } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Job } from 'bullmq';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { BroadcastService } from '../broadcast/broadcast.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { QUEUES } from '../jobs/queues';
import { DeliveryService } from '../messaging/delivery.service';
import { GoWaToolsService } from './whatsapp/gowa-tools.service';
import { ChannelAccountService } from './channel-account.service';
import { ChannelConnectionState, ConnectionEventSource } from './channel-connection';
import { ChannelRecoveryService } from './channel-recovery.service';
import { ChannelRegistryService } from './channel-registry.service';
import type { ChannelKey } from './entities/channel.entity';

/** How often the maintenance sweep runs. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Periodic reconciliation against the gateway (brief §14).
 *
 * Three jobs, all of which exist because webhooks alone are not sufficient:
 *
 *  1. **Session health** — a `session.disconnected` webhook can be lost, or the gateway can restart
 *     without emitting one. Without polling, a dead session would look CONNECTED indefinitely and
 *     every send would queue against a session that cannot deliver.
 *  2. **Delivery reconciliation** — a message handed to the gateway by a worker that then crashed
 *     sits in SENDING forever: BullMQ considers the job delivered, and no receipt is coming.
 *  3. **Payload retention** — nulls raw webhook payloads once their window passes (brief §4).
 *
 * A repeatable BullMQ job rather than a `setInterval`: with several worker replicas, an interval
 * would run the sweep N times concurrently, whereas a repeatable job with a fixed id runs once.
 */
@Injectable()
@Processor(QUEUES.CHANNEL_MAINTENANCE)
export class ChannelMaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new AppLogger(ChannelMaintenanceProcessor.name);

  constructor(
    @InjectQueue(QUEUES.CHANNEL_MAINTENANCE) private readonly queue: Queue,
    private readonly accounts: ChannelAccountService,
    private readonly registry: ChannelRegistryService,
    private readonly recovery: ChannelRecoveryService,
    private readonly delivery: DeliveryService,
    private readonly ingestion: IngestionService,
    private readonly metrics: MetricsService,
    private readonly broadcasts: BroadcastService,
    @Optional()private readonly whatsappTools?:GoWaToolsService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    // A fixed jobId makes re-registration idempotent: every worker replica calls this on boot, and
    // BullMQ keeps exactly one scheduled instance.
    await this.queue.add(
      'sweep',
      {},
      {
        jobId: 'channel-maintenance-sweep',
        repeat: { every: SWEEP_INTERVAL_MS },
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 50 },
      },
    );
    this.logger.log('Channel maintenance sweep scheduled', { intervalMs: SWEEP_INTERVAL_MS });
  }

  async process(_job: Job): Promise<void> {
    await this.metrics.time('maintenance.sweep_ms', async () => {
      await this.whatsappTools?.sweep().catch(error=>this.logger.warn('WhatsApp schedules sweep failed',{error:(error as Error).message}));
      // Scheduled broadcasts (§97). Folded into the existing sweep rather than given a scheduler of
      // its own: this one already runs exactly once across every replica, and a second repeatable
      // job would be a second thing to reason about when a campaign goes out late.
      await this.broadcasts
        .startDue()
        .then((result) => {
          if (result.started > 0 || result.failed > 0) {
            this.logger.log('Scheduled broadcasts processed', result);
          }
        })
        .catch((error) =>
          this.logger.warn('Scheduled broadcast sweep failed', { error: (error as Error).message }),
        );

      // Each step has its own error boundary: a gateway outage must not stop the retention sweep,
      // which needs no gateway at all.
      await this.syncSessionHealth().catch((error) =>
        this.logger.warn('Session health sync failed', { error: (error as Error).message }),
      );
      // Strictly after the health sync: recovery decides from the state that sync just refreshed,
      // so running it first would act on a picture up to a minute old.
      await this.recoverSessions().catch((error) =>
        this.logger.warn('Automatic session recovery failed', { error: (error as Error).message }),
      );
      await this.delivery
        .reconcileStalledSends()
        .catch((error) =>
          this.logger.warn('Delivery reconciliation failed', { error: (error as Error).message }),
        );
      await this.ingestion
        .purgeExpiredPayloads()
        .catch((error) =>
          this.logger.warn('Payload retention sweep failed', { error: (error as Error).message }),
        );
    });
  }

  /** Reconnects sessions that dropped on their own (`ChannelRecoveryService`). */
  private async recoverSessions(): Promise<void> {
    const result = await this.recovery.recoverDroppedSessions();
    if (result.attempted > 0) {
      this.logger.log('Automatic session recovery pass', result);
    }
  }

  /**
   * Polls the gateway for each owned account's real state.
   *
   * Unowned accounts are skipped entirely — Support CRM stops driving an account the moment
   * ownership is disabled, and that includes not polling it.
   */
  private async syncSessionHealth(): Promise<void> {
    const accounts = await this.accounts.listOwned();

    for (const account of accounts) {
      try {
        const adapter = this.registry.get(account.channelKey as ChannelKey);
        const state = await adapter.getAccountState(account.id);

        await this.accounts.recordState(account, state.status, {
          source: ConnectionEventSource.GATEWAY_POLL,
          rawState: state.status,
          detail: state.lastError ?? null,
          displayIdentity: state.displayIdentity,
          accountPhone: state.accountPhone ?? null,
          capabilities: state.capabilities,
        });

        /*
         * A connected session with no inbound callback is an incomplete integration, not a healthy
         * account: it sends perfectly and receives nothing, silently, for as long as nobody looks.
         *
         * Repaired here rather than only on connect because the condition outlives the request that
         * caused it — a gateway unreachable at pairing time, or a connect that timed out while
         * Chromium was still starting, both leave a working session and no way back in. Adapters
         * that need no per-account registration simply do not implement this.
         */
        if (state.status === ChannelConnectionState.CONNECTED && adapter.ensureInboundCallback) {
          await adapter
            .ensureInboundCallback(account.id, this.ingestion.callbackUrl(account.id))
            .then((result) => {
              if (result.repaired) {
                this.logger.warn('Registered a missing inbound callback for a connected account', {
                  channelAccountId: account.id,
                });
                this.metrics.increment('channel.webhook_repaired');
              }
            })
            .catch((error) =>
              // Never fail the health sweep over this: the state above is already recorded, and a
              // gateway that refuses the registration now will be retried on the next pass.
              this.logger.warn('Could not register a missing inbound callback', {
                channelAccountId: account.id,
                error: (error as Error).message,
              }),
            );
        }
      } catch (error) {
        // An unreachable gateway is UNKNOWN, not DISCONNECTED. The distinction matters: DISCONNECTED
        // asserts something about the WhatsApp session, and we have learned nothing about it —
        // only that we could not ask.
        await this.accounts
          .recordState(account, ChannelConnectionState.UNKNOWN, {
            source: ConnectionEventSource.SYSTEM,
            detail: `Gateway unreachable: ${(error as Error).message}`,
          })
          .catch(() => undefined);

        this.metrics.increment('channel.health_poll_failed');
      }
    }

    this.metrics.increment('channel.health_poll_completed', {}, accounts.length);
  }
}
