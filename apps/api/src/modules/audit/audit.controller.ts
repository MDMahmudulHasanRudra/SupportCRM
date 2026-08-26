import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AuditService } from './audit.service';
import { RequirePermissions } from '../rbac/permissions.guard';

export class QueryAuditDto {
  @IsOptional() @IsString() actorId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() resource?: string;
  @IsOptional() @IsString() resourceId?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * Read-only by design. There is no create, update or delete endpoint for audit rows anywhere in the
 * application — an audit trail an operator can edit is not an audit trail (`PROJECT_SPEC.md` §107).
 */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.view')
  @ApiOperation({ summary: 'Query the audit log (most recent first)' })
  async query(@Query() query: QueryAuditDto) {
    return this.audit.query(query);
  }
}
