import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { JobStatus, JobType } from './entities/job.entity';
import { JobItemStatus } from './entities/job-item.entity';
import { JobsService } from './jobs.service';

export class CreateEchoJobDto {
  @IsString() @MaxLength(160) name!: string;

  /**
   * Bounded at 5,000: `PROJECT_SPEC.md` §119 targets 3,000+ groups, so the cap is above any real
   * bulk action while still refusing a request that would build an unbounded transaction.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  references!: string[];

  @IsOptional() @IsString() @MaxLength(128) idempotencyKey?: string;
}

export class ListJobsDto {
  @IsOptional() @IsEnum(JobStatus) status?: JobStatus;
  @IsOptional() @IsEnum(JobType) type?: JobType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class ListJobItemsDto {
  @IsOptional() @IsEnum(JobItemStatus) status?: JobItemStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * The Job Center API (`PROJECT_SPEC.md` §50).
 *
 * Note what is absent: any endpoint that performs bulk work synchronously. Every route here either
 * creates a job and returns immediately, or reads job state. §49 makes that a hard rule.
 */
@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('jobs.read')
  @ApiOperation({ summary: 'List jobs, newest first' })
  async list(@Query() query: ListJobsDto) {
    const result = await this.jobs.list(query);
    return { ...result, items: result.items.map(serialize) };
  }

  @Get(':id')
  @RequirePermissions('jobs.read')
  @ApiOperation({ summary: 'One job with its progress' })
  async findOne(@Param('id') id: string) {
    return serialize(await this.jobs.findOne(id));
  }

  @Get(':id/items')
  @RequirePermissions('jobs.read')
  @ApiOperation({ summary: 'Per-item results, including the failure reason for each failed item' })
  async items(@Param('id') id: string, @Query() query: ListJobItemsDto) {
    return this.jobs.listItems(id, query);
  }

  @Post('echo')
  @RequirePermissions('jobs.manage')
  @ApiOperation({
    summary: 'Create a SYSTEM_ECHO job — the queue smoke test',
    description:
      'Exercises the full pipeline end to end without touching WhatsApp or AI. ' +
      'A reference beginning with "fail:" fails deliberately, so partial-failure handling is testable.',
  })
  async createEcho(
    @Body() dto: CreateEchoJobDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const job = await this.jobs.create({
      type: JobType.SYSTEM_ECHO,
      name: dto.name,
      items: dto.references.map((reference) => ({ reference })),
      idempotencyKey: dto.idempotencyKey,
      createdById: user.id,
    });

    await this.audit.record(
      {
        action: 'jobs.create',
        resource: 'job',
        resourceId: job.id,
        after: { type: job.type, name: job.name, totalItems: job.totalItems },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serialize(job);
  }

  @Post(':id/cancel')
  @RequirePermissions('jobs.manage')
  @ApiOperation({ summary: 'Request cancellation; in-flight items finish, pending items are cancelled' })
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const job = await this.jobs.requestCancel(id);
    await this.audit.record(
      { action: 'jobs.cancel', resource: 'job', resourceId: id, after: { status: job.status } },
      this.audit.actorFromRequest(request, user),
    );
    return serialize(job);
  }

  @Post(':id/retry')
  @RequirePermissions('jobs.manage')
  @ApiOperation({ summary: 'Re-queue only the failed items — successes are never re-run' })
  async retry(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const job = await this.jobs.retryFailed(id);
    await this.audit.record(
      { action: 'jobs.retry', resource: 'job', resourceId: id },
      this.audit.actorFromRequest(request, user),
    );
    return serialize(job);
  }
}

/** `progressPercent` is a getter, so it must be projected explicitly for JSON serialisation. */
function serialize(job: {
  id: string;
  type: JobType;
  status: JobStatus;
  name: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  error: string | null;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  progressPercent: number;
}) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    name: job.name,
    totalItems: job.totalItems,
    completedItems: job.completedItems,
    failedItems: job.failedItems,
    progressPercent: job.progressPercent,
    error: job.error,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}
