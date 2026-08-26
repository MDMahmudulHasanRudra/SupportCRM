import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { LessThan, Not, IsNull, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { ChannelKey } from '../channel/entities/channel.entity';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { WebhookRejectionReason, WebhookVerificationError } from '../channel/webhook.types';
import { QUEUES } from '../jobs/queues';
import { ProviderEvent, ProviderEventStatus } from './entities/provider-event.entity';

/** How long a verified raw payload is retained before the sweep nulls it (brief §4). */
const RAW_PAYLOAD_RETENTION_HOURS = 72;

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  providerEventId: string | null;
  eventType: string;
}

/**
 * Webhook ingestion (Phase 2 brief §4, §14).
 *
 * The contract of this service is deliberately small and strict:
 *
 *   verify → dedupe → persist → enqueue → return
 *
 * and nothing else. No normalization, no classification, no group lookup, no sending. Those all
 * happen on the worker. `PROJECT_SPEC.md` §6 forbids heavy work inside the webhook request, and the
 * gateway retries a delivery that does not answer quickly — so slow processing here would not just
 * be slow, it would manufacture duplicates.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new AppLogger(IngestionService.name);

  constructor(
    @InjectRepository(ProviderEvent) private readonly events: Repository<ProviderEvent>,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    @InjectQueue(QUEUES.MESSAGE_INCOMING) private readonly inbound: Queue,
    private readonly registry: ChannelRegistryService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Handles one raw delivery.
   *
   * Every rejection path is silent to the caller beyond a 401/400: an attacker probing the endpoint
   * learns nothing about which session ids exist or why verification failed. The detail goes to the
   * security log instead.
   */
  async ingest(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    channelKey: ChannelKey = ChannelKey.WHATSAPP,
  ): Promise<IngestResult> {
    this.metrics.increment('webhook.received');

    // The adapter is resolved by channel, never imported: ingestion works the same way for
    // every channel and knows nothing about any of them (docs/adr/0001 §7).
    const adapter = this.registry.get(channelKey);

    // Read only the account identifier from the UNVERIFIED body — just enough to find whose
    // secret to check. Nothing else from this parse is trusted or retained.
    const externalId = adapter.identifyWebhookAccount(rawBody);
    if (!externalId) {
      this.reject('malformed_body', { reason: 'no account identifier in body' });
      throw new WebhookVerificationError(WebhookRejectionReason.MALFORMED_BODY);
    }

    const account = await this.accounts.findOne({ where: { channelKey, externalId } });
    if (!account) {
      // An unknown session is a rejection, not a 404: confirming which session ids exist would let
      // an unauthenticated caller enumerate the customer's accounts.
      this.reject('unknown_account', { externalId });
      throw new WebhookVerificationError(WebhookRejectionReason.UNKNOWN_ACCOUNT);
    }

    let verified;
    try {
      verified = await adapter.verifyWebhook(account, rawBody, headers);
    } catch (error) {
      const reason = error instanceof WebhookVerificationError ? error.reason : 'unknown';
      this.reject(String(reason), { channelAccountId: account.id });
      throw error;
    }

    // Ownership disabled: record the event for the audit trail, but do not process it. The account
    // row and its history stay intact; Support CRM simply stops acting on it.
    const consumed = verified.consumed && account.ownershipEnabled;

    const retainedUntil = new Date(Date.now() + RAW_PAYLOAD_RETENTION_HOURS * 60 * 60 * 1000);

    let event: ProviderEvent;
    try {
      event = await this.events.save(
        this.events.create({
          channelAccountId: account.id,
          providerIdempotencyKey: verified.providerIdempotencyKey,
          providerDeliveryId: verified.providerDeliveryId,
          eventType: verified.eventType,
          status: consumed ? ProviderEventStatus.RECEIVED : ProviderEventStatus.IGNORED,
          rawPayload: verified.payload,
          payloadRetainedUntil: retainedUntil,
          providerRetryCount: verified.providerRetryCount,
          processedAt: consumed ? null : new Date(),
        }),
      );
    } catch (error) {
      // 23505 = unique_violation on (channelAccountId, providerIdempotencyKey).
      //
      // THIS is the idempotency guarantee. The gateway's own docs warn that a queue failure there
      // can cause both a queued job and a direct fallback to POST the same event — and two API
      // replicas can race any application-level check. Only the database can arbitrate, and
      // insert-and-catch is how we let it.
      if ((error as { code?: string }).code === '23505') {
        this.metrics.increment('webhook.duplicate');
        this.logger.debug('Duplicate provider event ignored', {
          channelAccountId: account.id,
          eventType: verified.eventType,
        });
        return {
          accepted: true,
          duplicate: true,
          providerEventId: null,
          eventType: verified.eventType,
        };
      }
      throw error;
    }

    if (consumed) {
      // Keyed by conversation where we can determine it, so per-conversation ordering is preserved
      // (`PROJECT_SPEC.md` §187). jobId doubles as a second dedupe layer inside BullMQ.
      await this.inbound.add(
        verified.eventType,
        { providerEventId: event.id, channelAccountId: account.id, eventType: verified.eventType },
        {
          // Hyphen, not colon: BullMQ rejects a custom job id containing ':' unless it splits
          // into exactly three parts (a legacy allowance its own source marks for removal).
          jobId: `pe-${event.id}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3600, count: 5000 },
          removeOnFail: { age: 24 * 3600 },
        },
      );
      this.metrics.increment('webhook.queued');
    } else {
      this.metrics.increment('webhook.ignored');
    }

    return {
      accepted: true,
      duplicate: false,
      providerEventId: event.id,
      eventType: verified.eventType,
    };
  }

  /**
   * The callback URL the gateway should POST to for a given account.
   *
   * Per-account path rather than one shared endpoint: it makes gateway-side logs legible, and it
   * means a leaked URL for one session tells an attacker nothing about the others.
   */
  callbackUrl(accountId: string): string {
    const base = this.config.getOrThrow<string>('http.baseUrl').replace(/\/$/, '');
    return `${base}/api/v1/channels/whatsapp/webhook/${accountId}`;
  }

  /**
   * Retention sweep (brief §4, `PROJECT_SPEC.md` §127).
   *
   * Nulls the raw payload once its window passes while KEEPING the row: the payload holds customer
   * message content, but the row is what provides idempotency, and deleting it would let an old
   * redelivery be processed a second time.
   */
  async purgeExpiredPayloads(now = new Date()): Promise<number> {
    const result = await this.events.update(
      { payloadRetainedUntil: LessThan(now), rawPayload: Not(IsNull()) },
      { rawPayload: null },
    );
    const purged = result.affected ?? 0;
    if (purged > 0) this.logger.log('Purged expired webhook payloads', { count: purged });
    return purged;
  }

  /**
   * Security log for a rejected delivery (brief §4).
   *
   * Records what was refused and why — never the body, which is unverified attacker-controlled
   * input, and never the signature, which is a credential-equivalent value.
   */
  private reject(reason: string, context: Record<string, unknown>): void {
    this.metrics.increment('webhook.rejected', { reason });
    this.logger.warn('Rejected webhook delivery', { securityEvent: 'webhook_rejected', reason, ...context });
  }
}
