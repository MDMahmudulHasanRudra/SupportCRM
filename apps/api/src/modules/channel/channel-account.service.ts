import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { LockService } from '../../common/redis/lock.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { normalizeCapabilities, type ChannelCapabilities } from './channel-capabilities';
import { ChannelConnectionState, ConnectionEventSource } from './channel-connection';
import { ChannelConnectionEvent } from './entities/channel-connection-event.entity';
import { ChannelAccount } from './entities/channel-account.entity';
import { Channel, ChannelKey } from './entities/channel.entity';

/**
 * Session-lifecycle operations must never run concurrently for one account (brief §15).
 *
 * Two simultaneous connects would create two gateway sessions for one row; a disconnect racing a
 * connect leaves the account in a state neither caller intended. 30s covers a gateway round trip
 * with room to spare, and the TTL guarantees a crashed worker cannot wedge the account.
 */
const SESSION_LOCK_TTL_MS = 30_000;

export interface RecordStateOptions {
  source: ConnectionEventSource;
  rawState?: string | null;
  detail?: string | null;
  actorId?: string | null;
  displayIdentity?: string | null;
  accountPhone?: string | null;
  capabilities?: ChannelCapabilities | null;
}

/**
 * Owns `channel_accounts` — registration, ownership, and the normalized connection state machine.
 *
 * Channel-agnostic on purpose: it knows about accounts, states and locks, and delegates anything
 * gateway-specific to the adapter resolved from the registry. A Messenger account would be managed
 * by this same service.
 */
@Injectable()
export class ChannelAccountService {
  private readonly logger = new AppLogger(ChannelAccountService.name);

  constructor(
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    @InjectRepository(ChannelConnectionEvent) private readonly events: Repository<ChannelConnectionEvent>,
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    private readonly locks: LockService,
    private readonly realtime: RealtimeGateway,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Registers an account.
   *
   * `externalId` is the gateway's session name and is chosen by the operator, so it is validated
   * strictly: it ends up in URL paths, and an unconstrained value would be a path-traversal vector
   * against the gateway's own routes (brief §21).
   */
  async register(input: {
    channelKey: ChannelKey;
    /** The operator-chosen session NAME. The gateway's UUID is learned on connect. */
    externalName: string;
    label: string;
    isPrimary?: boolean;
  }): Promise<ChannelAccount> {
    const channel = await this.channels.findOne({ where: { key: input.channelKey } });
    if (!channel) throw new NotFoundException(`Unknown channel "${input.channelKey}"`);
    if (!channel.isEnabled) {
      throw new BadRequestException(`Channel "${input.channelKey}" is not enabled`);
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(input.externalName)) {
      throw new BadRequestException(
        'Session id must be 3–64 characters of letters, digits, hyphens or underscores, ' +
          'starting with a letter or digit.',
      );
    }

    const existing = await this.accounts.findOne({
      where: { channelKey: input.channelKey, externalName: input.externalName },
    });
    if (existing) {
      throw new ConflictException(`An account for session "${input.externalName}" already exists`);
    }

    // A partial unique index enforces one primary per channel; demote the incumbent first rather
    // than letting the insert fail on a constraint the caller cannot see.
    if (input.isPrimary) {
      await this.accounts.update({ channelKey: input.channelKey, isPrimary: true }, { isPrimary: false });
    }

    const account = await this.accounts.save(
      this.accounts.create({
        channelKey: input.channelKey,
        externalName: input.externalName,
        // Learned from the gateway on connect — never guessed from the name.
        externalId: null,
        label: input.label,
        isPrimary: input.isPrimary ?? false,
        status: ChannelConnectionState.DISCONNECTED,
        ownershipEnabled: true,
      }),
    );

    await this.recordState(account, ChannelConnectionState.DISCONNECTED, {
      source: ConnectionEventSource.ADMIN_ACTION,
      detail: 'Account registered',
    });

    this.logger.log('Channel account registered', {
      channelAccountId: account.id,
      channelKey: account.channelKey,
    });
    return account;
  }

  /**
   * Records a state transition and emits it.
   *
   * Idempotent by design: re-observing the same state updates the heartbeat but writes no history
   * row and emits no event. Session polling runs on a timer, and a history row per poll would bury
   * the actual transitions in noise.
   */
  async recordState(
    account: ChannelAccount,
    state: ChannelConnectionState,
    options: RecordStateOptions,
  ): Promise<ChannelAccount> {
    // Re-read rather than trusting the caller's copy. A session-lifecycle call takes tens of
    // seconds, and gateway webhooks land on the worker while it runs — so by the time a controller
    // records its outcome, the row has usually moved on. Using the stale copy wrote history rows
    // for transitions that never happened (`DISCONNECTED -> CONNECTING` when the account was
    // already CONNECTING) and emitted events with a wrong `previousState`. Observed in the
    // real-WhatsApp validation run.
    const current = await this.accounts.findOne({ where: { id: account.id } });
    const previous = (current?.status ?? account.status) as ChannelConnectionState;
    const changed = previous !== state;

    await this.accounts.update(account.id, {
      status: state,
      lastHeartbeatAt: new Date(),
      ...(changed && state === ChannelConnectionState.CONNECTED ? { lastConnectedAt: new Date() } : {}),
      ...(options.detail !== undefined && state === ChannelConnectionState.ERROR
        ? { lastError: options.detail }
        : {}),
      ...(changed && state === ChannelConnectionState.CONNECTED ? { lastError: null } : {}),
      // Reaching CONNECTED ends any recovery cycle, no matter what got us here — an automatic
      // attempt, a health poll finding the session back up, a gateway webhook, or an operator.
      // Clearing it only inside the recovery service left healthy accounts displaying
      // "Reconnecting…" forever, which the real-gateway validation caught.
      ...(state === ChannelConnectionState.CONNECTED
        ? { recoveryAttempts: 0, recoveryNextAttemptAt: null, recoveryExhaustedAt: null }
        : {}),
      ...(options.displayIdentity !== undefined ? { displayIdentity: options.displayIdentity } : {}),
      // Only ever set, never cleared by a poll: a transient gateway response that omits the phone
      // must not erase an identity we already established.
      ...(options.accountPhone ? { accountPhone: options.accountPhone } : {}),
      ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    });

    if (changed) {
      await this.events.save(
        this.events.create({
          channelAccountId: account.id,
          previousState: previous,
          state,
          source: options.source,
          rawState: options.rawState?.slice(0, 64) ?? null,
          detail: options.detail?.slice(0, 2000) ?? null,
          actorId: options.actorId ?? null,
        }),
      );

      this.metrics.increment('channel.state_changed', { state });
      this.realtime.emitWhatsAppEvent('whatsapp.account.status_changed', {
        channelAccountId: account.id,
        channelKey: account.channelKey,
        previousState: previous,
        state,
        // No `rawState` and no detail: the realtime channel is a fan-out, and gateway error strings
        // can carry session internals that belong behind an authorised fetch.
      });

      this.logger.log('Channel account state changed', {
        channelAccountId: account.id,
        from: previous,
        to: state,
        source: options.source,
      });
    }

    return this.findOne(account.id);
  }

  /**
   * Writes a history row for one automatic reconnect attempt.
   *
   * Deliberately separate from `recordState`: an attempt is not a state change, and `recordState`
   * writes nothing when the state is unchanged — which is exactly the case for an attempt that
   * fails. Without this, the history would show a session mysteriously reconnecting with no record
   * of the four attempts it took, and no record at all of the ones that never succeeded.
   */
  async recordRecoveryAttempt(
    account: ChannelAccount,
    attempt: number,
    maxAttempts: number,
  ): Promise<void> {
    await this.events.save(
      this.events.create({
        channelAccountId: account.id,
        previousState: account.status as ChannelConnectionState,
        state: ChannelConnectionState.CONNECTING,
        source: ConnectionEventSource.SYSTEM,
        rawState: null,
        detail: `Automatic reconnect attempt ${attempt} of ${maxAttempts}`,
        actorId: null,
      }),
    );
  }

  /**
   * Runs a session-lifecycle operation under the account's lock (brief §15).
   *
   * `onBusy: 'skip'` yields a 409 rather than queueing: if an operator double-clicks Connect, the
   * right answer is "one is already running", not a second connect a few seconds later.
   */
  async withSessionLock<T>(accountId: string, operation: string, fn: () => Promise<T>): Promise<T> {
    const result = await this.locks.withLock(`channel-account:${accountId}`, SESSION_LOCK_TTL_MS, fn);

    if (result === null) {
      this.metrics.increment('channel.lock_contended', { operation });
      throw new ConflictException(
        `Another ${operation} operation is already running for this account. Try again shortly.`,
      );
    }
    return result;
  }

  async findOne(id: string): Promise<ChannelAccount> {
    const account = await this.accounts.findOne({ where: { id } });
    if (!account) throw new NotFoundException(`Channel account ${id} not found`);
    return account;
  }

  async findByExternalId(channelKey: ChannelKey, externalId: string): Promise<ChannelAccount | null> {
    return this.accounts.findOne({ where: { channelKey, externalId } });
  }

  /** Records the gateway's own id for this account, learned when its session was created. */
  async setExternalId(id: string, externalId: string): Promise<void> {
    await this.accounts.update(id, { externalId });
  }

  async list(): Promise<ChannelAccount[]> {
    return this.accounts.find({ order: { createdAt: 'ASC' } });
  }

  /** Accounts eligible for background work: owned by us, and not disabled. */
  async listOwned(): Promise<ChannelAccount[]> {
    return this.accounts.find({ where: { ownershipEnabled: true }, order: { createdAt: 'ASC' } });
  }

  /**
   * Turns Support CRM's ownership of an account on or off.
   *
   * Disabling stops all outbound sending, all sync and all inbound processing while keeping the row
   * and its history. It is the safe way to hand an account back — and the mechanism that makes the
   * account-by-account production cutover possible without deleting anything.
   */
  async setOwnership(id: string, enabled: boolean, actorId: string | null): Promise<ChannelAccount> {
    const account = await this.findOne(id);
    await this.accounts.update(id, { ownershipEnabled: enabled });

    await this.events.save(
      this.events.create({
        channelAccountId: id,
        previousState: account.status as ChannelConnectionState,
        state: account.status as ChannelConnectionState,
        source: ConnectionEventSource.ADMIN_ACTION,
        detail: enabled ? 'Ownership enabled' : 'Ownership disabled',
        actorId,
      }),
    );

    this.logger.log('Channel account ownership changed', { channelAccountId: id, ownershipEnabled: enabled });
    return this.findOne(id);
  }

  async setWebhook(id: string, webhookExternalId: string, encryptedSecret: string): Promise<void> {
    await this.accounts.update(id, { webhookExternalId, webhookSecretEncrypted: encryptedSecret });
  }

  async listConnectionEvents(accountId: string, limit = 50): Promise<ChannelConnectionEvent[]> {
    return this.events.find({
      where: { channelAccountId: accountId },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
  }

  /** Capabilities as last probed. Never assumed — an unprobed account can do nothing (§174). */
  capabilitiesOf(account: ChannelAccount): ChannelCapabilities {
    return normalizeCapabilities(account.capabilities);
  }
}
