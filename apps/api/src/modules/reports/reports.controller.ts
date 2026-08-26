import { BadRequestException, Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import type { Response } from 'express';
import { RequirePermissions } from '../rbac/permissions.guard';
import { toCsv } from './csv';
import { defaultWindow, ReportsService, type DateWindow } from './reports.service';
import { OperationsAnalyticsService } from './operations-analytics.service';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class WindowDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class DaysDto {
  /** Bounded: an unbounded window would let one request scan the entire message history. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

const EXPORTABLE = ['conversations', 'decisions', 'escalations'] as const;
type Exportable = (typeof EXPORTABLE)[number];

/**
 * The dashboard, the reports and their exports (`PROJECT_SPEC.md` §100–§106).
 *
 * Read-only throughout: nothing here changes anything. Export is gated separately from viewing —
 * an export leaves the system as a file of customer data, which is a different risk from reading a
 * count on a screen.
 */
@ApiTags('reports')
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly operations: OperationsAnalyticsService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Everything the dashboard shows, for one window' })
  async dashboard(@Query() query: WindowDto) {
    return this.reports.dashboard(windowFrom(query));
  }

  /**
   * The operations dashboard: group coverage, and AI against human support.
   *
   * One call rather than a request per card — the page renders as a unit, and a card-per-endpoint
   * dashboard makes a dozen round trips to show one screen.
   */
  @Get('operations')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Group coverage plus AI and human support activity' })
  async operationsDashboard(@Query() query: DaysDto) {
    return this.operations.dashboard(query.days ?? 14);
  }

  @Get('ai-vs-human')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'AI and human support per day — replies and unique groups, counted separately' })
  async aiVsHuman(@Query() query: DaysDto) {
    return { items: await this.operations.aiVsHumanDaily(query.days ?? 30) };
  }

  @Get('group-coverage')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'How many groups each capability is configured for' })
  async groupCoverage() {
    return this.operations.coverage();
  }

  @Get('activity-trend')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Daily conversation, automation and escalation counts for the window' })
  async activityTrend(@Query() query: WindowDto) {
    return this.reports.activityTrend(windowFrom(query));
  }

  @Get('team-performance')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Per-agent performance — conversations and outcomes, never message count' })
  async team(@Query() query: WindowDto) {
    return this.reports.teamPerformance(windowFrom(query));
  }

  @Get('top-issues')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'What customers needed most, by recorded decision reason' })
  async topIssues(@Query() query: WindowDto) {
    return this.reports.topIssues(windowFrom(query));
  }

  @Get('knowledge-gaps')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Where the knowledge base failed to answer' })
  async gaps(@Query() query: WindowDto) {
    return this.reports.knowledgeGaps(windowFrom(query));
  }

  @Get('broadcasts')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Campaign outcomes, counted from the recipient rows' })
  async broadcasts(@Query() query: WindowDto) {
    return this.reports.broadcastReport(windowFrom(query));
  }

  @Get('ai-performance')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'AI outcomes and the human verdicts on them' })
  async aiPerformance(@Query() query: WindowDto) {
    return this.reports.aiPerformance(windowFrom(query));
  }

  /**
   * A report as CSV.
   *
   * CSV rather than Excel because it is the format that opens everywhere and cannot carry a macro.
   * The row cap is explicit: an export that silently stops at ten thousand rows would be worse than
   * one that says so, so the response names the limit in a trailing comment row.
   */
  @Get('export/:report')
  @RequirePermissions('reports.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'Export a report as CSV' })
  async export(@Param('report') report: string, @Query() query: WindowDto, @Res() response: Response) {
    if (!EXPORTABLE.includes(report as Exportable)) {
      throw new BadRequestException(`Cannot export "${report}". Available: ${EXPORTABLE.join(', ')}.`);
    }

    const limit = 10_000;
    const rows = await this.reports.exportRows(report as Exportable, windowFrom(query), limit);

    response.setHeader('Content-Disposition', `attachment; filename="${report}-${Date.now()}.csv"`);
    response.write(toCsv(rows as unknown as Array<Record<string, unknown>>));

    if (rows.length === limit) {
      // Said out loud rather than left to be discovered by someone reconciling totals.
      response.write(`\n# Truncated at ${limit} rows. Narrow the date range for the rest.\n`);
    }

    response.end();
  }
}

function windowFrom(query: WindowDto): DateWindow {
  if (!query.from && !query.to) return defaultWindow();

  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException('Those dates could not be read.');
  }
  if (from > to) throw new BadRequestException('The start of the range is after its end.');

  return { from, to };
}
