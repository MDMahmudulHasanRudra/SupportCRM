import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AIConfigScope, AIJobSlot, type AIPersonality, type ResolvedAIConfig } from './ai-types';
import { AIConfiguration } from './entities/ai-configuration.entity';
import { mergePersonality } from './ai-instructions';

/**
 * Resolving "which model, in what voice" for one conversation (`PROJECT_SPEC.md` §23, §24).
 *
 * Global → Support Profile → Group, most specific winning, and each field resolved independently
 * so a group can change the language without inheriting a model it never asked for. The merge is
 * the pure `mergePersonality`; this service's job is only to fetch the right rows in the right
 * order.
 *
 * One query for all three scopes rather than three round trips, because this runs on the inbound
 * path for every message the AI is asked about.
 */
@Injectable()
export class AIConfigService {
  constructor(
    @InjectRepository(AIConfiguration) private readonly configurations: Repository<AIConfiguration>,
  ) {}

  async resolve(
    scope: { profileId?: string | null; groupId?: string | null },
    jobSlot: AIJobSlot = AIJobSlot.DECISION,
  ): Promise<ResolvedAIConfig> {
    const scopeIds = [scope.profileId, scope.groupId].filter((id): id is string => Boolean(id));

    const rows = await this.configurations.find({
      where: [
        { scopeType: AIConfigScope.GLOBAL, scopeId: IsNull(), jobSlot, isActive: true },
        ...(scopeIds.length
          ? [{ scopeId: In(scopeIds), jobSlot, isActive: true } as Record<string, unknown>]
          : []),
      ] as never,
    });

    const pick = (scopeType: AIConfigScope, scopeId: string | null) =>
      rows.find(
        (row) => row.scopeType === scopeType && (scopeId === null ? row.scopeId === null : row.scopeId === scopeId),
      ) ?? null;

    // Broadest first: each later layer overrides only what it actually sets.
    const layers = [
      pick(AIConfigScope.GLOBAL, null),
      scope.profileId ? pick(AIConfigScope.PROFILE, scope.profileId) : null,
      scope.groupId ? pick(AIConfigScope.GROUP, scope.groupId) : null,
    ];

    const personality: AIPersonality = mergePersonality(...layers.map((layer) => layer ?? undefined));

    const lastSet = <K extends keyof AIConfiguration>(key: K): AIConfiguration[K] | null => {
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const value = layers[index]?.[key];
        if (value !== null && value !== undefined) return value as AIConfiguration[K];
      }
      return null;
    };

    const temperature = lastSet('temperature');

    return {
      ...personality,
      providerId: (lastSet('providerId') as string | null) ?? null,
      model: (lastSet('model') as string | null) ?? null,
      temperature: temperature === null ? null : Number(temperature),
      maxTokens: (lastSet('maxTokens') as number | null) ?? null,
    };
  }

  async list(): Promise<AIConfiguration[]> {
    return this.configurations.find({ order: { scopeType: 'ASC', jobSlot: 'ASC' } });
  }

  /**
   * Creates or updates the one configuration for a scope and slot.
   *
   * Upsert rather than insert: the unique index means a second row for the same scope is an error,
   * and an operator editing the global tone twice should not meet a constraint violation.
   */
  async upsert(input: {
    scopeType: AIConfigScope;
    scopeId?: string | null;
    jobSlot: AIJobSlot;
    values: Partial<AIConfiguration>;
    userId: string | null;
  }): Promise<AIConfiguration> {
    const scopeId = input.scopeType === AIConfigScope.GLOBAL ? null : (input.scopeId ?? null);

    const existing = await this.configurations.findOne({
      where: {
        scopeType: input.scopeType,
        scopeId: scopeId === null ? IsNull() : scopeId,
        jobSlot: input.jobSlot,
      },
    });

    if (existing) {
      await this.configurations.update(existing.id, { ...input.values, updatedById: input.userId });
      return this.configurations.findOneOrFail({ where: { id: existing.id } });
    }

    return this.configurations.save(
      this.configurations.create({
        ...input.values,
        scopeType: input.scopeType,
        scopeId,
        jobSlot: input.jobSlot,
        createdById: input.userId,
        updatedById: input.userId,
      }),
    );
  }

  async remove(id: string): Promise<void> {
    await this.configurations.delete(id);
  }
}
