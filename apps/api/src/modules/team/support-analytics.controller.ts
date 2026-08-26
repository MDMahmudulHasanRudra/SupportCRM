import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { QueryBoolean } from '../../common/http/query-boolean';
import { RequirePermissions } from '../rbac/permissions.guard';
import { SupportAnalyticsService } from './support-analytics.service';

export class WindowDto {
  /** Bounded: an unbounded window would let one request scan the whole message history. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

export class RosterDto {
  @IsOptional() @QueryBoolean() includeInactive?: boolean;
}

export class DayDto {
  /** A calendar day, `YYYY-MM-DD`. Validated by shape so it cannot reach SQL as arbitrary text. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be YYYY-MM-DD' })
  day!: string;
}

export class RangeDto {
  /** Inclusive start, `YYYY-MM-DD`. Defaults to 30 days ago. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' }) from?: string;
  /** Inclusive end, `YYYY-MM-DD`. Defaults to today. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' }) to?: string;
}

export class MemberDto {
  @IsUUID() id!: string;
}

/**
 * Support member activity, read-only.
 *
 * Exposed as "support members" in the console, but there is no support-member table: these are the
 * same `team_member_identities` rows that classify an inbound message as `TEAM_MESSAGE`, reported
 * on. Introducing a parallel entity would mean two lists of the same people that could disagree
 * about who is on the team, and the classifier would keep following the other one.
 *
 * Every route aggregates in Postgres and returns figures already reduced — no endpoint here returns
 * a message set for the browser to count.
 */
@ApiTags('support')
@Controller('support')
export class SupportAnalyticsController {
  constructor(private readonly analytics: SupportAnalyticsService) {}

  @Get('members')
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'Registered support members with their reply volume' })
  async members(@Query() query: RosterDto) {
    return { items: await this.analytics.roster({ includeInactive: query.includeInactive }) };
  }

  @Get('members/:id/daily')
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'One support member, replies per day' })
  async memberDaily(@Param() params: MemberDto, @Query() query: WindowDto) {
    return { items: await this.analytics.memberDaily(params.id, query.days ?? 30) };
  }

  @Get('members/:id/groups')
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'One support member, replies by group name' })
  async memberGroups(@Param() params: MemberDto, @Query() query: WindowDto) {
    return { items: await this.analytics.memberGroups(params.id, query.days ?? 30) };
  }

  /**
   * One member's activity day by day, with the groups named.
   *
   * The endpoint behind "which executive supported how many groups on which day". Group counts are
   * distinct groups, never message counts.
   */
  @Get('members/:id/activity')
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'One support member, day by day, with the groups they helped' })
  async memberActivity(@Param() params: MemberDto, @Query() query: RangeDto) {
    const { from, to } = resolveRange(query);
    return { items: await this.analytics.memberActivity(params.id, from, to), from, to };
  }

  @Get('activity')
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'Team-wide support activity per day' })
  async activity(@Query() query: WindowDto) {
    return { items: await this.analytics.teamDaily(query.days ?? 30) };
  }

  @Get('activity/:day')
  @RequirePermissions('team.manage')
  @ApiOperation({ summary: 'Who replied on one day, and in which groups' })
  async activityDay(@Param() params: DayDto) {
    return { items: await this.analytics.dayDetail(params.day) };
  }
}

/**
 * Turns an optional `YYYY-MM-DD` range into a half-open interval.
 *
 * The end is exclusive and one day past the requested date, so a range of "today to today" covers
 * all of today rather than only its first instant. Dates are interpreted in the server's configured
 * timezone — the same one the database session runs — so a day here is the same day the aggregates
 * bucket on.
 */
function resolveRange(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const from = query.from ? startOfLocalDay(query.from) : new Date(midnight.getTime() - 29 * 86_400_000);
  const toDay = query.to ? startOfLocalDay(query.to) : midnight;

  return { from, to: new Date(toDay.getTime() + 86_400_000) };
}

/** Parses `YYYY-MM-DD` as local midnight, not UTC midnight. */
function startOfLocalDay(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}
