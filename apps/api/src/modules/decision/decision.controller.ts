import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { AIGatewayService } from '../ai/ai-gateway.service';
import { RequirePermissions } from '../rbac/permissions.guard';
import { DecisionContextBuilder } from './decision-context';
import { DecisionService } from './decision.service';
import { DecisionOutcome } from './decision-types';
import { DryRunService } from './dry-run.service';

export class ListDecisionsDto {
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsEnum(DecisionOutcome) outcome?: DecisionOutcome;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class DryRunDto {
  @IsString() @MinLength(1) @MaxLength(4000) text!: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsString() @MaxLength(32) conversationState?: string;
  @IsOptional() @IsString() @MaxLength(32) messageType?: string;
  @IsOptional() @IsBoolean() hasAttachment?: boolean;
  @IsOptional() ruleIds?: string[];
  /** Also run the knowledge + AI half. Costs a provider call; still sends nothing. */
  @IsOptional() @IsBoolean() includeAi?: boolean;
  @IsOptional() @IsString() at?: string;
}

/**
 * Reading decisions, and testing them without consequences.
 *
 * There is deliberately **no endpoint that makes a decision happen**. Decisions are produced by the
 * inbound pipeline; exposing a "decide now" route would be a second way into the single authority,
 * which is the one thing this phase exists to prevent.
 */
@ApiTags('decisions')
@Controller({ path: 'decisions', version: '1' })
export class DecisionController {
  constructor(
    private readonly decisions: DecisionService,
    private readonly dryRun: DryRunService,
    private readonly ai: AIGatewayService,
    private readonly contextBuilder: DecisionContextBuilder,
  ) {}

  /**
   * Whether AI is configured, and the numbers the engine is actually deciding by.
   *
   * The provider and model, never the credential. The thresholds are the *resolved* global values —
   * a stored setting if there is one, the code default otherwise — so a screen can show what is in
   * force rather than an empty box that means "unset, and I could not tell you what that implies".
   */
  @Get('status')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Decision engine status, including whether AI is available' })
  async status() {
    return { ai: await this.ai.describe(), thresholds: await this.contextBuilder.resolveThresholds(null) };
  }

  @Get()
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Recent decisions' })
  async list(@Query() query: ListDecisionsDto) {
    return this.decisions.list(query);
  }

  @Get(':id')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'One decision, with everything needed to explain it' })
  async findOne(@Param('id') id: string) {
    const trace = await this.decisions.trace(id);
    if (!trace) throw new NotFoundException(`Decision ${id} not found`);
    return trace;
  }

  /**
   * "Why did the system respond to this message?" (brief §30).
   *
   * The trace UI's endpoint. A message with no decision is a normal answer — a team message, or one
   * that arrived before the engine existed — and says so rather than 404ing.
   */
  @Get('message/:messageId')
  @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'The decision for one message' })
  async forMessage(@Param('messageId') messageId: string) {
    const decision = await this.decisions.findForMessage(messageId);
    return decision ?? { decision: null, note: 'No automatic decision was made for this message.' };
  }

  /**
   * Runs the rules — and optionally the AI — against hypothetical text.
   *
   * Sends nothing, writes nothing, changes nothing. Uses the same pure evaluator and the same
   * policy the live engine uses, which is what makes the answer trustworthy.
   */
  @Post('dry-run')
  @RequirePermissions('automation.simulate')
  @ApiOperation({ summary: 'Test what would happen, without sending anything' })
  async simulate(@Body() dto: DryRunDto) {
    return this.dryRun.run(dto);
  }
}
