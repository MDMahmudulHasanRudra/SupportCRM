import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Allow, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { SettingValueType } from './entities/setting.entity';
import { EMERGENCY_STOPS, FEATURE_FLAGS, SettingsService } from './settings.service';

export class UpsertSettingDto {
  /**
   * Any JSON value; the declared `valueType` decides how it is stored.
   *
   * `@Allow()` is required, not decorative: the global ValidationPipe runs with `whitelist` and
   * `forbidNonWhitelisted`, so a property carrying no class-validator decorator at all is stripped
   * and then rejected as unknown. `@Allow()` whitelists it without constraining its shape.
   */
  @Allow()
  value!: unknown;

  @IsOptional() @IsEnum(SettingValueType) valueType?: SettingValueType;
  @IsOptional() @IsString() @MaxLength(64) category?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings.read')
  @ApiOperation({ summary: 'All settings. Secret values are never returned — only whether they are set.' })
  async list() {
    return { items: await this.settings.listPublic() };
  }

  @Get('feature-flags')
  @RequirePermissions('settings.read')
  @ApiOperation({ summary: 'Feature flags and emergency stops with their effective values' })
  async featureFlags() {
    const flags: Record<string, boolean> = {};
    for (const key of Object.values(FEATURE_FLAGS)) {
      flags[key] = await this.settings.isFeatureEnabled(key);
    }

    const stops: Record<string, boolean> = {};
    for (const key of Object.values(EMERGENCY_STOPS)) {
      stops[key] = await this.settings.isStopped(key);
    }

    return { featureFlags: flags, emergencyStops: stops };
  }

  @Put(':key')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Create or update one setting' })
  async upsert(
    @Param('key') key: string,
    @Body() dto: UpsertSettingDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const { before, after } = await this.settings.set(key, dto.value, {
      valueType: dto.valueType,
      category: dto.category,
      description: dto.description,
      updatedById: user.id,
    });

    // Emergency stops get their own action name so they are trivially greppable in the audit log —
    // "who stopped everything at 03:00" should not require filtering a generic settings feed.
    const isEmergency = Object.values(EMERGENCY_STOPS).includes(key as never);
    await this.audit.record(
      {
        action: isEmergency ? 'system.emergency_stop' : 'settings.update',
        resource: 'setting',
        resourceId: key,
        before: { value: before },
        after: { value: after },
      },
      this.audit.actorFromRequest(request, user),
    );

    return { key, value: after };
  }
}
