import { Injectable } from '@nestjs/common';
import { AIUnavailableError, AIProviderService, type AIDecisionRequest, type AIDecisionResult } from '../../common/ai/ai-provider';
import { AIConfigService } from './ai-config.service';
import { AIRegistryService } from './ai-registry.service';
import { buildSystemPrompt } from './ai-instructions';
import { AIJobSlot, type AIPersonality } from './ai-types';

/**
 * The one door the Decision Engine knocks on for an answer.
 *
 * Phase 5 shipped a single environment-configured provider. Phase 6 adds database-configured
 * providers with a fallback chain, per-scope model slots and layered personality. This service is
 * how both exist at once without the engine caring which is in play:
 *
 *  * If any provider row is active, the registry answers — with fallback and a circuit breaker.
 *  * Otherwise the environment-configured provider answers, exactly as before.
 *  * If neither is configured, `isAvailable()` is false and the engine escalates. It never invents.
 *
 * Keeping the environment path alive is deliberate rather than sentimental: it is what the
 * integration suite drives (`AI_PROVIDER=test`), and a deployment that has always configured AI
 * through env vars must not break because a new table exists.
 */
@Injectable()
export class AIGatewayService {
  constructor(
    private readonly registry: AIRegistryService,
    private readonly configs: AIConfigService,
    private readonly env: AIProviderService,
  ) {}

  /** Whether anything at all can answer. Asked before the engine commits to the AI path. */
  async isAvailable(): Promise<boolean> {
    if (await this.registry.anyConfigured()) return true;
    return this.env.available;
  }

  /** Provider and model for display. Never a credential. */
  async describe(): Promise<{ available: boolean; provider: string; model: string | null; source: 'database' | 'environment' | 'none' }> {
    const chain = await this.registry.chain();
    if (chain.length > 0) {
      const first = chain[0];
      return {
        available: true,
        provider: first.kind,
        model: first.defaultModel,
        source: 'database',
      };
    }

    const env = this.env.describe();
    return { ...env, source: env.available ? 'environment' : 'none' };
  }

  /**
   * Ask for a decision on one customer message.
   *
   * `scope` selects the configuration — which provider, which model, which voice — through the
   * Global → Profile → Group hierarchy. Everything about *what* the model is allowed to say is in
   * the assembled system prompt; everything about *whether to act on the answer* stays in
   * `DecisionPolicy`, which this service deliberately does not touch.
   */
  async decide(
    request: AIDecisionRequest,
    scope: {
      profileId?: string | null;
      groupId?: string | null;
      summary?: string | null;
      customerFacts?: string[];
    } = {},
  ): Promise<{ result: AIDecisionResult; provider: string; model: string }> {
    if (await this.registry.anyConfigured()) {
      const config = await this.configs.resolve(
        { profileId: scope.profileId ?? null, groupId: scope.groupId ?? null },
        AIJobSlot.DECISION,
      );

      const personality: AIPersonality = {
        tone: config.tone,
        language: config.language ?? request.language ?? null,
        answerLength: config.answerLength,
        emojiLevel: config.emojiLevel,
        technicalLevel: config.technicalLevel,
        // Profile guidance from Phase 5 is folded in here rather than lost: it is another layer of
        // the same instruction stack, just one that predates this table.
        systemInstructions: [config.systemInstructions, request.guidance].filter(Boolean).join('\n') || null,
      };

      const system = buildSystemPrompt({
        personality,
        summary: scope.summary ?? null,
        customerFacts: scope.customerFacts ?? [],
      });

      const { result, provider, model } = await this.registry.decide(request, {
        preferredId: config.providerId,
        model: config.model,
        system,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });

      return { result, provider: provider.kind, model };
    }

    if (!this.env.available) throw new AIUnavailableError();

    const result = await this.env.decide(request);
    return { result, provider: this.env.name, model: this.env.model };
  }
}
