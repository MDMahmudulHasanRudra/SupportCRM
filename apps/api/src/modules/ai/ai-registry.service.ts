import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AIProviderError, AIUnavailableError, type AIDecisionRequest, type AIDecisionResult } from '../../common/ai/ai-provider';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { RedisService } from '../../common/redis/redis.service';
import { AIProviderConfig } from './entities/ai-provider.entity';
import { defaultBaseUrl, providerFor } from './providers/vendor-providers';
import type { CompletionResult, ProviderCallOptions } from './providers/generation-provider';

/**
 * Choosing a provider, surviving its failure, and refusing to invent (`PROJECT_SPEC.md` §21, §123).
 *
 * The order of operations for every call:
 *
 *  1. Take the active providers in priority order.
 *  2. Skip any whose circuit is open — a provider that just failed four times is not asked a fifth
 *     time on the next customer's message. That is the "never hammer a failed provider" of §123,
 *     and it also stops one broken vendor from adding its timeout to every inbound message.
 *  3. Try each in turn. A *retryable* failure moves to the next provider; a permanent one (a
 *     rejected credential, a malformed request) does too, but without counting toward the breaker,
 *     because retrying elsewhere is right while penalising the endpoint is not.
 *  4. If none answers, throw. The caller escalates to a human. There is no offline fallback that
 *     produces plausible text.
 *
 * The credential is decrypted here, held in a local, and passed straight to the adapter. It is
 * never logged, never returned, and never stored anywhere but its envelope.
 */

/** After this many consecutive failures the circuit opens. */
const BREAKER_THRESHOLD = 4;
/** How long it stays open. Long enough to matter, short enough to recover unattended. */
const BREAKER_COOLDOWN_MS = 60_000;

export interface ProviderSelection {
  provider: AIProviderConfig;
  model: string;
}

@Injectable()
export class AIRegistryService {
  private readonly logger = new AppLogger(AIRegistryService.name);

  constructor(
    @InjectRepository(AIProviderConfig) private readonly providers: Repository<AIProviderConfig>,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  /** Active providers, best first. Priority ascending, then oldest — a total order, never a tie. */
  async chain(): Promise<AIProviderConfig[]> {
    return this.providers.find({
      where: { isActive: true },
      order: { priority: 'ASC', createdAt: 'ASC' },
    });
  }

  async anyConfigured(): Promise<boolean> {
    return (await this.providers.count({ where: { isActive: true } })) > 0;
  }

  /**
   * Runs `attempt` against each provider in turn until one succeeds.
   *
   * `preferredId` puts one provider at the front — that is how a per-group model slot is honoured
   * without losing the fallback chain behind it.
   */
  async withFallback<T>(
    options: { preferredId?: string | null; model?: string | null; timeoutMs?: number },
    attempt: (provider: AIProviderConfig, call: ProviderCallOptions) => Promise<T>,
  ): Promise<{ result: T; provider: AIProviderConfig; model: string }> {
    const chain = await this.orderedChain(options.preferredId ?? null);
    if (chain.length === 0) throw new AIUnavailableError('No AI provider is configured and active.');

    let lastError: Error | null = null;
    let skipped = 0;

    for (const provider of chain) {
      if (await this.isOpen(provider.id)) {
        skipped += 1;
        continue;
      }

      const model = options.model ?? provider.defaultModel;
      if (!model) {
        lastError = new AIProviderError(`${provider.name} has no model configured.`, false, 'FAILED');
        continue;
      }

      const call: ProviderCallOptions = {
        apiKey: this.apiKeyFor(provider),
        baseUrl: provider.baseUrl || defaultBaseUrl(provider.kind) || null,
        model,
        timeoutMs: options.timeoutMs ?? provider.timeoutMs,
        system: '',
      };

      try {
        const result = await attempt(provider, call);
        await this.recordSuccess(provider);
        return { result, provider, model };
      } catch (error) {
        lastError = error as Error;
        const retryable = error instanceof AIProviderError ? error.retryable : true;

        // Only transient failures count toward the breaker. A permanent one is a configuration
        // problem: opening the circuit would hide it behind a cooldown instead of surfacing it.
        if (retryable) await this.recordFailure(provider, lastError.message);
        else await this.noteError(provider, lastError.message);

        this.metrics.increment('ai.provider_failed', { provider: provider.kind, retryable: String(retryable) });
        this.logger.warn('AI provider failed; trying the next in the chain', {
          providerId: provider.id,
          kind: provider.kind,
          retryable,
          // The message is already classified and carries no response body or credential.
          error: lastError.message,
        });
      }
    }

    this.metrics.increment('ai.chain_exhausted');
    throw new AIProviderError(
      skipped > 0
        ? `Every AI provider failed or is cooling down after repeated failures (${skipped} skipped).`
        : (lastError?.message ?? 'Every AI provider failed.'),
      true,
      'FAILED',
    );
  }

  /** A structured decision, through the fallback chain. */
  async decide(
    request: AIDecisionRequest,
    options: { preferredId?: string | null; model?: string | null; system: string; temperature?: number | null; maxTokens?: number | null },
  ): Promise<{ result: AIDecisionResult; provider: AIProviderConfig; model: string }> {
    return this.withFallback({ preferredId: options.preferredId, model: options.model }, (provider, call) =>
      providerFor(provider.kind).decide(request, {
        ...call,
        system: options.system,
        temperature: options.temperature ?? null,
        maxTokens: options.maxTokens ?? null,
      }),
    );
  }

  /** Free-form generation, for summaries. Same chain, same breaker. */
  async complete(
    prompt: string,
    options: { preferredId?: string | null; model?: string | null; system: string; maxTokens?: number | null },
  ): Promise<{ result: CompletionResult; provider: AIProviderConfig; model: string }> {
    return this.withFallback({ preferredId: options.preferredId, model: options.model }, (provider, call) =>
      providerFor(provider.kind).complete(prompt, options.system, {
        ...call,
        system: options.system,
        maxTokens: options.maxTokens ?? null,
      }),
    );
  }

  /**
   * A one-off connectivity check for the admin screen.
   *
   * Deliberately bypasses the breaker: an operator pressing "Test" is asking about *now*, and
   * answering from a cooldown would be answering a different question.
   */
  async test(providerId: string): Promise<{ ok: boolean; detail: string }> {
    const provider = await this.providers.findOne({ where: { id: providerId } });
    if (!provider) return { ok: false, detail: 'That provider does not exist.' };
    if (!provider.defaultModel) return { ok: false, detail: 'No default model is configured.' };

    try {
      const outcome = await providerFor(provider.kind).complete(
        'Reply with the single word: ready',
        'You are a connectivity probe. Answer in one word.',
        {
          apiKey: this.apiKeyFor(provider),
          baseUrl: provider.baseUrl || defaultBaseUrl(provider.kind) || null,
          model: provider.defaultModel,
          timeoutMs: Math.min(provider.timeoutMs, 20_000),
          system: 'You are a connectivity probe. Answer in one word.',
          maxTokens: 16,
        },
      );
      await this.recordSuccess(provider);
      return { ok: true, detail: `Answered with "${outcome.text.trim().slice(0, 40)}".` };
    } catch (error) {
      const message = (error as Error).message;
      await this.noteError(provider, message);
      return { ok: false, detail: message };
    }
  }

  // === internals ================================================================================

  private async orderedChain(preferredId: string | null): Promise<AIProviderConfig[]> {
    const chain = await this.chain();
    if (!preferredId) return chain;

    const preferred = chain.find((provider) => provider.id === preferredId);
    if (!preferred) return chain;
    return [preferred, ...chain.filter((provider) => provider.id !== preferredId)];
  }

  /**
   * The decrypted credential.
   *
   * Bound to the provider's id as additional authenticated data, so an envelope copied from
   * another row fails to decrypt rather than silently authenticating as something else.
   */
  private apiKeyFor(provider: AIProviderConfig): string | null {
    if (!provider.apiKeyEncrypted) return null;
    try {
      return this.crypto.decryptSecret(provider.apiKeyEncrypted, `ai_provider:${provider.id}:apiKey`);
    } catch {
      // A key that cannot be decrypted is a key we do not have. Saying so beats sending null and
      // getting a confusing 401 from the vendor.
      this.logger.error('An AI provider credential could not be decrypted', { providerId: provider.id });
      return null;
    }
  }

  private breakerKey(providerId: string): string {
    return `ai:breaker:${providerId}`;
  }

  private async isOpen(providerId: string): Promise<boolean> {
    const value = await this.redis.getClient().get(`${this.breakerKey(providerId)}:open`);
    return value !== null;
  }

  private async recordFailure(provider: AIProviderConfig, message: string): Promise<void> {
    const key = this.breakerKey(provider.id);
    const failures = await this.redis.getClient().incr(`${key}:failures`);
    if (failures === 1) await this.redis.getClient().pexpire(`${key}:failures`, BREAKER_COOLDOWN_MS * 2);

    if (failures >= BREAKER_THRESHOLD) {
      await this.redis.getClient().set(`${key}:open`, '1', 'PX', BREAKER_COOLDOWN_MS);
      await this.redis.getClient().del(`${key}:failures`);
      this.metrics.increment('ai.breaker_opened', { provider: provider.kind });
      this.logger.warn('AI provider circuit opened after repeated failures', {
        providerId: provider.id,
        cooldownMs: BREAKER_COOLDOWN_MS,
      });
    }

    await this.noteError(provider, message);
  }

  private async recordSuccess(provider: AIProviderConfig): Promise<void> {
    const key = this.breakerKey(provider.id);
    await this.redis.getClient().del(`${key}:failures`);
    await this.providers.update(provider.id, { lastCheckedAt: new Date(), lastError: null });
  }

  private async noteError(provider: AIProviderConfig, message: string): Promise<void> {
    await this.providers.update(provider.id, {
      lastCheckedAt: new Date(),
      lastError: message.slice(0, 500),
    });
  }
}
