import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { AIConfigService } from './ai-config.service';
import { AIFeedbackService } from './ai-feedback.service';
import { AIMemoryService } from './ai-memory.service';
import { AIRegistryService } from './ai-registry.service';
import { AIConfigScope, AIFeedbackVerdict, AIJobSlot, AIProviderKind } from './ai-types';
import { AIProviderConfig } from './entities/ai-provider.entity';

export class CreateProviderDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsEnum(AIProviderKind) kind!: AIProviderKind;
  @IsOptional() @IsString() @MaxLength(500) baseUrl?: string;
  @IsOptional() @IsString() @MaxLength(500) apiKey?: string;
  @IsOptional() @IsString() @MaxLength(160) defaultModel?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1000) @Max(300000) timeoutMs?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) priority?: number;
}

export class UpdateProviderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) baseUrl?: string;
  /** Sending a new key replaces the envelope. Omitting it leaves the stored one untouched. */
  @IsOptional() @IsString() @MaxLength(500) apiKey?: string;
  @IsOptional() @IsString() @MaxLength(160) defaultModel?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1000) @Max(300000) timeoutMs?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) priority?: number;
}

export class UpsertConfigDto {
  @IsEnum(AIConfigScope) scopeType!: AIConfigScope;
  @IsOptional() @IsUUID() scopeId?: string;
  @IsOptional() @IsEnum(AIJobSlot) jobSlot?: AIJobSlot;
  @IsOptional() @IsUUID() providerId?: string;
  @IsOptional() @IsString() @MaxLength(160) model?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(2) temperature?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(32000) maxTokens?: number;
  @IsOptional() @IsString() @MaxLength(24) tone?: string;
  @IsOptional() @IsString() @MaxLength(16) language?: string;
  @IsOptional() @IsString() @MaxLength(16) answerLength?: string;
  @IsOptional() @IsString() @MaxLength(16) emojiLevel?: string;
  @IsOptional() @IsString() @MaxLength(16) technicalLevel?: string;
  @IsOptional() @IsString() @MaxLength(4000) systemInstructions?: string;
}

export class AddFactDto {
  @IsString() @MinLength(2) @MaxLength(1000) fact!: string;
}

export class FeedbackDto {
  @IsEnum(AIFeedbackVerdict) verdict!: AIFeedbackVerdict;
  @IsOptional() @IsUUID() aiMessageId?: string;
  @IsOptional() @IsUUID() decisionId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsString() @MaxLength(4000) correctedText?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/**
 * AI providers, configuration and feedback (`PROJECT_SPEC.md` §21–§24, §88, §92).
 *
 * The rule that shapes every response here: **a credential goes in and never comes out.** Providers
 * are returned with `hasApiKey`, never with the key, never with the envelope. There is no endpoint
 * that reveals one, because an endpoint that reveals one is the endpoint that leaks one.
 *
 * There is also no route that makes the AI answer a customer. Answering happens on the inbound
 * decision path and nowhere else — the single-authority guarantee of Phase 5 would be worth
 * nothing if this controller offered a side door.
 */
@ApiTags('ai')
@Controller({ path: 'ai', version: '1' })
export class AIController {
  constructor(
    @InjectRepository(AIProviderConfig) private readonly providers: Repository<AIProviderConfig>,
    private readonly registry: AIRegistryService,
    private readonly configs: AIConfigService,
    private readonly memory: AIMemoryService,
    private readonly feedback: AIFeedbackService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // === providers ================================================================================

  @Get('providers')
  @RequirePermissions('settings.read')
  @ApiOperation({ summary: 'Configured AI providers. Whether a key is set — never the key.' })
  async listProviders() {
    const rows = await this.providers.find({ order: { priority: 'ASC', createdAt: 'ASC' } });
    return { items: rows.map(serializeProvider) };
  }

  @Post('providers')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Add a provider' })
  async createProvider(
    @Body() dto: CreateProviderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const provider = await this.providers.save(
      this.providers.create({
        name: dto.name.trim(),
        kind: dto.kind,
        baseUrl: dto.baseUrl ?? null,
        defaultModel: dto.defaultModel ?? null,
        timeoutMs: dto.timeoutMs ?? 45_000,
        // Created inactive unless asked otherwise: adding a provider and having it start answering
        // customers in the same click is not a decision anybody makes deliberately.
        isActive: dto.isActive ?? false,
        priority: dto.priority ?? 100,
        createdById: user.id,
      }),
    );

    // Encrypted after the insert, because the envelope is bound to the row's id.
    if (dto.apiKey) {
      await this.providers.update(provider.id, {
        apiKeyEncrypted: this.crypto.encryptSecret(dto.apiKey, `ai_provider:${provider.id}:apiKey`),
      });
    }

    await this.audit.record(
      {
        action: 'ai.provider_created',
        resource: 'ai_provider',
        resourceId: provider.id,
        after: { name: provider.name, kind: provider.kind, isActive: provider.isActive },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serializeProvider(await this.providers.findOneOrFail({ where: { id: provider.id } }));
  }

  @Patch('providers/:id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Edit a provider' })
  async updateProvider(
    @Param('id') id: string,
    @Body() dto: UpdateProviderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.providers.findOne({ where: { id } });
    if (!before) throw new NotFoundException('That provider does not exist.');

    await this.providers.update(id, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.baseUrl !== undefined ? { baseUrl: dto.baseUrl } : {}),
      ...(dto.defaultModel !== undefined ? { defaultModel: dto.defaultModel } : {}),
      ...(dto.timeoutMs !== undefined ? { timeoutMs: dto.timeoutMs } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      ...(dto.apiKey ? { apiKeyEncrypted: this.crypto.encryptSecret(dto.apiKey, `ai_provider:${id}:apiKey`) } : {}),
    });

    await this.audit.record(
      {
        action: 'ai.provider_updated',
        resource: 'ai_provider',
        resourceId: id,
        before: { isActive: before.isActive, priority: before.priority },
        // Whether the credential changed is auditable; the credential is not.
        after: { isActive: dto.isActive ?? before.isActive, credentialReplaced: Boolean(dto.apiKey) },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serializeProvider(await this.providers.findOneOrFail({ where: { id } }));
  }

  @Post('providers/:id/test')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Send one probe request to a provider and report what happened' })
  async testProvider(@Param('id') id: string) {
    return this.registry.test(id);
  }

  @Delete('providers/:id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Remove a provider' })
  async removeProvider(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.providers.delete(id);
    await this.audit.record(
      { action: 'ai.provider_deleted', resource: 'ai_provider', resourceId: id },
      this.audit.actorFromRequest(request, user),
    );
    return { deleted: true };
  }

  // === configuration ============================================================================

  @Get('configurations')
  @RequirePermissions('settings.read')
  @ApiOperation({ summary: 'All AI configurations, by scope and job slot' })
  async listConfigs() {
    return { items: await this.configs.list() };
  }

  @Get('configurations/effective')
  @RequirePermissions('settings.read')
  @ApiOperation({ summary: 'What a given group or profile actually resolves to' })
  async effective(@Query('groupId') groupId?: string, @Query('profileId') profileId?: string) {
    return this.configs.resolve({ groupId: groupId ?? null, profileId: profileId ?? null });
  }

  @Post('configurations')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Create or update the configuration for one scope and slot' })
  async upsertConfig(
    @Body() dto: UpsertConfigDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const saved = await this.configs.upsert({
      scopeType: dto.scopeType,
      scopeId: dto.scopeId ?? null,
      jobSlot: dto.jobSlot ?? AIJobSlot.DECISION,
      values: {
        providerId: dto.providerId ?? null,
        model: dto.model ?? null,
        temperature: dto.temperature === undefined ? null : String(dto.temperature),
        maxTokens: dto.maxTokens ?? null,
        tone: dto.tone ?? null,
        language: dto.language ?? null,
        answerLength: dto.answerLength ?? null,
        emojiLevel: dto.emojiLevel ?? null,
        technicalLevel: dto.technicalLevel ?? null,
        systemInstructions: dto.systemInstructions ?? null,
      },
      userId: user.id,
    });

    await this.audit.record(
      {
        action: 'ai.configuration_saved',
        resource: 'ai_configuration',
        resourceId: saved.id,
        after: { scopeType: saved.scopeType, scopeId: saved.scopeId, jobSlot: saved.jobSlot },
      },
      this.audit.actorFromRequest(request, user),
    );
    return saved;
  }

  @Delete('configurations/:id')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Remove a scope override, falling back to the broader one' })
  async removeConfig(@Param('id') id: string) {
    await this.configs.remove(id);
    return { deleted: true };
  }

  // === conversation memory and feedback =========================================================

  @Get('conversations/:conversationId/turns')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'The AI turns for one conversation — verdicts and usage, never reasoning' })
  async turns(@Param('conversationId') conversationId: string) {
    return { items: await this.memory.turnsFor(conversationId) };
  }

  @Get('conversations/:conversationId/memory')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'The rolling summary the AI carries for one conversation' })
  async conversationMemory(@Param('conversationId') conversationId: string) {
    const summary = await this.memory.summaryFor(conversationId);
    return summary ?? { conversationId, summary: null, turnCount: 0 };
  }

  @Get('customers/:customerId/facts')
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: 'Long-term memory about a customer. Only approved facts are ever used.' })
  async facts(@Param('customerId') customerId: string) {
    return { items: await this.memory.factsFor(customerId) };
  }

  @Post('customers/:customerId/facts')
  @RequirePermissions('customers.update')
  @ApiOperation({ summary: 'Record a fact about a customer' })
  async addFact(
    @Param('customerId') customerId: string,
    @Body() dto: AddFactDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const saved = await this.memory.addFact({ customerId, fact: dto.fact, userId: user.id });
    await this.audit.record(
      { action: 'ai.fact_added', resource: 'ai_customer_fact', resourceId: saved.id, after: { customerId } },
      this.audit.actorFromRequest(request, user),
    );
    return saved;
  }

  @Post('facts/:id/approve')
  @RequirePermissions('customers.update')
  @ApiOperation({ summary: 'Approve a suggested fact so the AI may use it' })
  async approveFact(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.memory.approveFact(id, user.id);
  }

  @Post('facts/:id/retire')
  @RequirePermissions('customers.update')
  @ApiOperation({ summary: 'Stop using a fact. Kept for history rather than deleted.' })
  async retireFact(@Param('id') id: string) {
    return this.memory.retireFact(id);
  }

  @Post('feedback')
  @RequirePermissions('conversations.manage')
  @ApiOperation({ summary: 'Record a human verdict on an AI turn' })
  async recordFeedback(
    @Body() dto: FeedbackDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const saved = await this.feedback.record({ ...dto, userId: user.id });
    await this.audit.record(
      {
        action: 'ai.feedback_recorded',
        resource: 'ai_feedback',
        resourceId: saved.id,
        after: { verdict: saved.verdict },
      },
      this.audit.actorFromRequest(request, user),
    );
    return saved;
  }

  @Get('feedback')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Recent human verdicts on AI answers' })
  async listFeedback(@Query('verdict') verdict?: AIFeedbackVerdict) {
    return this.feedback.list(verdict);
  }
}

/**
 * What an API caller may see about a provider.
 *
 * `hasApiKey` rather than the key, the envelope, or any prefix of either. A "last four characters"
 * convenience is exactly the kind of helpfulness that ends up in a screenshot.
 */
function serializeProvider(provider: AIProviderConfig) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    timeoutMs: provider.timeoutMs,
    isActive: provider.isActive,
    priority: provider.priority,
    hasApiKey: Boolean(provider.apiKeyEncrypted),
    lastCheckedAt: provider.lastCheckedAt,
    lastError: provider.lastError,
    createdAt: provider.createdAt,
  };
}
