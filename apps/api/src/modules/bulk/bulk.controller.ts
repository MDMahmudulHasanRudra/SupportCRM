import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Allow, IsArray, IsEnum, IsOptional, IsUUID } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { BulkOperation, BulkOperationsService } from './bulk-operations.service';

export class BulkRequestDto {
  @IsEnum(BulkOperation) operation!: BulkOperation;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) groupIds?: string[];
  @IsOptional() @Allow() filter?: { channelAccountId?: string; monitoringState?: string };
  @IsOptional() @IsUUID() targetId?: string;
}

/**
 * Bulk configuration (`PROJECT_SPEC.md` §47–§49).
 *
 * Both endpoints return immediately. `preview` says what a selection covers; `apply` queues a Job
 * Center job and hands back its id. Nothing here writes thousands of rows inside a request.
 */
@ApiTags('bulk')
@Controller({ path: 'bulk/groups', version: '1' })
export class BulkController {
  constructor(
    private readonly bulk: BulkOperationsService,
    private readonly audit: AuditService,
  ) {}

  @Post('preview')
  @RequirePermissions('groups.bulk_update')
  @ApiOperation({ summary: 'How many groups a selection covers, before committing to it' })
  async preview(@Body() dto: BulkRequestDto) {
    return this.bulk.preview(dto);
  }

  @Post('apply')
  @RequirePermissions('groups.bulk_update')
  @ApiOperation({ summary: 'Queue a bulk group change (one Job Center item per group)' })
  async apply(@Body() dto: BulkRequestDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const result = await this.bulk.queue(dto, user.id);

    await this.audit.record(
      {
        action: 'bulk.groups_updated',
        resource: 'group',
        after: { operation: result.operation, totalItems: result.totalItems, jobId: result.jobId },
      },
      this.audit.actorFromRequest(request, user),
    );
    return result;
  }
}
