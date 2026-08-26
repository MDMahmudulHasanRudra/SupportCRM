import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { RateLimitScope } from './entities/rate-limit-policy.entity';
import { RateLimitPolicyService } from './rate-limit-policy.service';

export class UpsertRateLimitDto {
  @IsEnum(RateLimitScope) scope!: RateLimitScope;
  @IsOptional() @IsUUID() scopeId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100_000) limit!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(86_400) windowSeconds!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/**
 * Rate limits (`PROJECT_SPEC.md` §57, §175).
 *
 * `effective` is the endpoint that matters: it returns every scope with the numbers actually in
 * force and whether they come from a stored policy or the built-in default. A settings screen that
 * shows blanks for the scopes nobody has overridden tells an operator nothing about what the system
 * is doing right now.
 *
 * Raising a limit is an operator accepting risk to their own WhatsApp account, which is why the
 * note field exists and why every change is audited.
 */
@ApiTags('settings')
@Controller({ path: 'settings/rate-limits', version: '1' })
export class RateLimitController {
  constructor(
    private readonly policies: RateLimitPolicyService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings.read')
  @ApiOperation({ summary: 'Every scope, with the limit in force and where it came from' })
  async effective() {
    return {
      items: await this.policies.effective(),
      overrides: await this.policies.list(),
    };
  }

  @Post()
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Set the limit for one scope, or for one subject within it' })
  async upsert(
    @Body() dto: UpsertRateLimitDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const saved = await this.policies.upsert({
      scope: dto.scope,
      scopeId: dto.scopeId ?? null,
      limit: dto.limit,
      windowSeconds: dto.windowSeconds,
      note: dto.note ?? null,
      userId: user.id,
    });

    await this.audit.record(
      {
        action: 'settings.rate_limit_changed',
        resource: 'rate_limit_policy',
        resourceId: saved.id,
        after: { scope: saved.scope, limit: saved.limit, windowSeconds: saved.windowSeconds },
      },
      this.audit.actorFromRequest(request, user),
    );

    return saved;
  }
}
