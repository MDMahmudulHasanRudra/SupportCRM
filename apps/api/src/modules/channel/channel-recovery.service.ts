import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { ChannelAccountService } from './channel-account.service';
import { ChannelConnectionState, ConnectionEventSource } from './channel-connection';
import { ChannelRegistryService } from './channel-registry.service';
import { ChannelAccount } from './entities/channel-account.entity';
import type { ChannelKey } from './entities/channel.entity';

/**
 * Automatic reconnection for sessions that dropped on their own.
 *
 * A WhatsApp Web session is not a durable thing. The real-WhatsApp validation watched one drop
 * unattended inside twenty minutes, and until somebody noticed and pressed Connect, every message
 * sent to that number was lost. This closes that window without a human in it.
 *
 * The rules it works under, each of which exists to stop it doing harm:
 *
 *  - **Never fight the operator.** An account an operator disconnected stays disconnected.
 *  - **Never re-pair.** If WhatsApp wants a new QR, a human has to scan it; retrying achieves
 *    nothing and the UI must say so rather than spin.
 *  - **Never run twice.** Attempts take the same account lock every other lifecycle operation
 *    takes, so a sweep can never overlap an operator's Connect or another replica's attempt.
 *  - **Never retry forever.** The budget is finite; when it is spent the account waits for a human
 *    and says so.
 *  - **Leave a trail.** Every attempt is a row in the connection history, successes and failures
 *    alike, because "why did this reconnect at 3am" is a question someone will ask.
 */
@Injectable()
export class ChannelRecoveryService {
  private readonly logger = new AppLogger(ChannelRecoveryService.name);

  constructor(
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    private readonly accountService: ChannelAccountService,
    private readonly registry: ChannelRegistryService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  private get maxAttempts(): number {
    return this.config.get<number>('channelRecovery.maxAttempts') ?? 5;
  }

  /** States a dropped session can sit in. `UNKNOWN` counts: we could not reach the gateway. */
  private static readonly RECOVERABLE: readonly ChannelConnectionState[] = [
    ChannelConnectionState.DISCONNECTED,
    ChannelConnectionState.UNKNOWN,
    ChannelConnectionState.ERROR,
  ];

  /**
   * Runs one recovery pass. Called by the maintenance sweep.
   *
   * Returns what it did, so the sweep can log a single line rather than one per account.
   */
  async recoverDroppedSessions(): Promise<{ attempted: number; recovered: number; exhausted: number }> {
    if (this.maxAttempts === 0) return { attempted: 0, recovered: 0, exhausted: 0 };

    const due = await this.findDue();
    let recovered = 0;
    let exhausted = 0;

    for (const account of due) {
      const outcome = await this.attempt(account);
      if (outcome === 'recovered') recovered += 1;
      if (outcome === 'exhausted') exhausted += 1;
    }

    return { attempted: due.length, recovered, exhausted };
  }

  /**
   * Accounts eligible for an automatic attempt right now.
   *
   * Filtered in SQL rather than in a loop: the sweep runs every minute forever, and on a healthy
   * deployment this query matches nothing and costs nothing.
   */
  private async findDue(): Promise<ChannelAccount[]> {
    const candidates = await this.accounts.find({
      where: {
        ownershipEnabled: true,
        // An operator's deliberate disconnect is not a fault to be corrected.
        disconnectRequestedAt: IsNull(),
        // Budget already spent — waiting for a human.
        recoveryExhaustedAt: IsNull(),
        // Never touched an account that has not paired at least once: there is nothing to recover
        // to, and connecting it would be a first-time setup nobody asked for.
        lastConnectedAt: Not(IsNull()),
      },
      order: { createdAt: 'ASC' },
    });

    const now = Date.now();
    return candidates.filter(
      (account) =>
        ChannelRecoveryService.RECOVERABLE.includes(account.status as ChannelConnectionState) &&
        // The first drop has no schedule yet, so a null means "try immediately".
        (account.recoveryNextAttemptAt === null || account.recoveryNextAttemptAt.getTime() <= now),
    );
  }

  /**
   * One attempt for one account.
   *
   * Every exit path either schedules the next attempt or stops the cycle; none of them leaves the
   * account in a state where nothing further will happen but the UI implies otherwise.
   */
  async attempt(account: ChannelAccount): Promise<'recovered' | 'retrying' | 'exhausted' | 'skipped'> {
    const attemptNumber = account.recoveryAttempts + 1;

    try {
      return await this.accountService.withSessionLock(account.id, 'automatic reconnect', async () => {
        // Re-read under the lock. An operator may have connected it, or disconnected it on purpose,
        // between the query above and this moment.
        const current = await this.accountService.findOne(account.id);
        if (
          current.disconnectRequestedAt !== null ||
          !ChannelRecoveryService.RECOVERABLE.includes(current.status as ChannelConnectionState)
        ) {
          return 'skipped';
        }

        await this.accountService.recordRecoveryAttempt(current, attemptNumber, this.maxAttempts);
        this.metrics.increment('channel.recovery_attempted');

        const adapter = this.registry.get(current.channelKey as ChannelKey);
        const state = await adapter.connect(current.id);

        const fresh = await this.accountService.findOne(current.id);
        await this.accountService.recordState(fresh, state.status, {
          source: ConnectionEventSource.SYSTEM,
          rawState: state.status,
          detail: `Automatic reconnect attempt ${attemptNumber}`,
          displayIdentity: state.displayIdentity,
          accountPhone: state.accountPhone ?? null,
          capabilities: state.capabilities,
        });

        if (state.status === ChannelConnectionState.CONNECTED) {
          await this.clearRecovery(current.id);
          this.metrics.increment('channel.recovery_succeeded');
          this.logger.log('Channel account recovered automatically', {
            channelAccountId: current.id,
            attempt: attemptNumber,
          });
          return 'recovered';
        }

        if (state.status === ChannelConnectionState.QR_REQUIRED) {
          // Re-pairing is a human act. Retrying cannot produce a scanned phone, and the QR flow
          // already tells the operator exactly what to do — so stop, without burning the budget on
          // attempts that were never going to work.
          await this.clearRecovery(current.id);
          this.metrics.increment('channel.recovery_needs_human');
          this.logger.warn('Channel account needs re-pairing — automatic recovery stopped', {
            channelAccountId: current.id,
          });
          return 'skipped';
        }

        // CONNECTING is not failure: the gateway accepted the start and the session is booting. It
        // still counts as an attempt, so a session stuck in CONNECTING cannot loop forever.
        return this.scheduleNext(current.id, attemptNumber);
      });
    } catch (error) {
      // A contended lock means somebody else is already working on this account — exactly the
      // outcome we want, and not a failed attempt.
      if (error instanceof ConflictException) {
        this.metrics.increment('channel.recovery_lock_contended');
        return 'skipped';
      }

      this.metrics.increment('channel.recovery_failed');
      this.logger.warn('Automatic reconnect failed', {
        channelAccountId: account.id,
        attempt: attemptNumber,
        error: (error as Error).message,
      });

      await this.accountService
        .recordState(await this.accountService.findOne(account.id), ChannelConnectionState.DISCONNECTED, {
          source: ConnectionEventSource.SYSTEM,
          detail: `Automatic reconnect attempt ${attemptNumber} failed`,
        })
        .catch(() => undefined);

      return this.scheduleNext(account.id, attemptNumber);
    }
  }

  /**
   * Books the next attempt, or gives up.
   *
   * Exponential with a ceiling: a gateway that is down for an hour should not be probed every
   * thirty seconds for that hour, and an operator watching the account should not have to wait
   * hours for the retry rate to come back down either.
   */
  private async scheduleNext(
    accountId: string,
    attemptNumber: number,
  ): Promise<'retrying' | 'exhausted'> {
    if (attemptNumber >= this.maxAttempts) {
      await this.accounts.update(accountId, {
        recoveryAttempts: attemptNumber,
        recoveryNextAttemptAt: null,
        recoveryExhaustedAt: new Date(),
      });
      this.metrics.increment('channel.recovery_exhausted');
      this.logger.warn('Automatic reconnect gave up — waiting for a human', {
        channelAccountId: accountId,
        attempts: attemptNumber,
      });
      return 'exhausted';
    }

    const base = this.config.get<number>('channelRecovery.baseMs') ?? 30_000;
    const ceiling = this.config.get<number>('channelRecovery.maxBackoffMs') ?? 600_000;
    const delay = Math.min(base * 2 ** (attemptNumber - 1), ceiling);

    await this.accounts.update(accountId, {
      recoveryAttempts: attemptNumber,
      recoveryNextAttemptAt: new Date(Date.now() + delay),
    });

    return 'retrying';
  }

  /** Wipes the recovery cycle. Called on success, and whenever an operator takes over. */
  async clearRecovery(accountId: string): Promise<void> {
    await this.accounts.update(accountId, {
      recoveryAttempts: 0,
      recoveryNextAttemptAt: null,
      recoveryExhaustedAt: null,
    });
  }

  /**
   * Marks an operator's intent.
   *
   * `disconnect` sets the flag so recovery leaves the account alone; `connect` clears it and resets
   * the cycle, so an operator pressing Connect always gets a clean slate rather than inheriting a
   * spent budget from an earlier outage.
   */
  async setOperatorIntent(accountId: string, intent: 'connect' | 'disconnect'): Promise<void> {
    await this.accounts.update(accountId, {
      disconnectRequestedAt: intent === 'disconnect' ? new Date() : null,
      ...(intent === 'connect'
        ? { recoveryAttempts: 0, recoveryNextAttemptAt: null, recoveryExhaustedAt: null }
        : {}),
    });
  }
}
