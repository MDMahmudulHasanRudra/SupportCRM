import { Body, Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Allow, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { CopilotService } from './copilot.service';

export class AskDto {
  @IsString() @MinLength(1) @MaxLength(4000) question!: string;
}

export class InvokeDto {
  @IsString() @MinLength(1) @MaxLength(4000) prompt!: string;
  @IsString() @MaxLength(64) tool!: string;
  @IsOptional() @Allow() arguments?: Record<string, unknown>;
}

export class ConfirmDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/**
 * The admin Copilot (`PROJECT_SPEC.md` §89–§91, §137–§138).
 *
 * Three routes and one principle: the Copilot acts with the caller's authority and never more. A
 * read runs if they could have run it themselves; a write is proposed, described in words, and does
 * nothing until a person confirms it — and the confirmation re-checks the permission rather than
 * trusting the one from a minute ago.
 *
 * `automation.simulate` gates the assistant itself, so being able to ask it questions is a
 * deliberate grant. What it can then *do* is still bounded by each tool's own permission.
 */
@ApiTags('copilot')
@Controller({ path: 'copilot', version: '1' })
export class CopilotController {
  constructor(
    private readonly copilot: CopilotService,
    private readonly audit: AuditService,
  ) {}

  @Get('tools')
  @RequirePermissions('automation.simulate')
  @ApiOperation({ summary: 'What you can ask for — filtered by your own permissions' })
  tools(@CurrentUser() user: AuthenticatedUser) {
    return { items: this.copilot.tools(user) };
  }

  @Post('ask')
  @RequirePermissions('automation.simulate')
  @ApiOperation({ summary: 'Ask in plain language. The assistant picks one of its declared tools.' })
  async ask(@Body() dto: AskDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const answer = await this.copilot.ask(user, dto.question);

    if (answer.action) {
      await this.audit.record(
        {
          action: answer.action.kind === 'WRITE' ? 'copilot.write_proposed' : 'copilot.read_executed',
          resource: 'copilot_action',
          resourceId: answer.action.id,
          after: { tool: answer.action.tool, status: answer.action.status, viaAsk: true },
        },
        this.audit.actorFromRequest(request, user),
      );
    }

    return answer;
  }

  @Post('invoke')
  @RequirePermissions('automation.simulate')
  @ApiOperation({ summary: 'Run a read, or propose a write for confirmation' })
  async invoke(@Body() dto: InvokeDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const action = await this.copilot.invoke(user, {
      prompt: dto.prompt,
      tool: dto.tool,
      arguments: dto.arguments,
    });

    // Audited on the way in, including reads: "who asked the assistant for the customer list" is a
    // question worth being able to answer.
    await this.audit.record(
      {
        action: action.kind === 'WRITE' ? 'copilot.write_proposed' : 'copilot.read_executed',
        resource: 'copilot_action',
        resourceId: action.id,
        after: { tool: action.tool, status: action.status },
      },
      this.audit.actorFromRequest(request, user),
    );

    return action;
  }

  @Post(':id/confirm')
  @RequirePermissions('automation.simulate')
  @ApiOperation({ summary: 'Carry out a proposed write. Re-checks the permission it needs.' })
  async confirm(
    @Param('id') id: string,
    @Body() _dto: ConfirmDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const action = await this.copilot.confirm(user, id);

    await this.audit.record(
      {
        action: 'copilot.write_confirmed',
        resource: 'copilot_action',
        resourceId: id,
        after: { tool: action.tool, status: action.status, result: action.result },
      },
      this.audit.actorFromRequest(request, user),
    );

    return action;
  }

  @Post(':id/reject')
  @RequirePermissions('automation.simulate')
  @ApiOperation({ summary: 'Decline a proposed write' })
  async reject(@Param('id') id: string) {
    return this.copilot.reject(id);
  }

  @Get('history')
  @RequirePermissions('automation.read')
  @ApiOperation({ summary: 'What the Copilot has been asked to do' })
  async history(@Query('limit') limit?: string) {
    return this.copilot.history(limit ? Number(limit) : 50);
  }
}
