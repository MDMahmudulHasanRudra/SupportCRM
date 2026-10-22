import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { BillingService } from './billing.service';
import { WorkforceService } from './workforce.service';
import { WorkspaceService } from './workspace.service';
import { DraftDto, InvoiceDto, LeaveDto, LeaveReviewDto, MemberDto, PaymentDto, ReasonDto, ReleaseDto, ReleaseRestoreDto, ReleaseUpdateDto, SavedReplyDto, ShiftDto, SubscriptionActionDto, SubscriptionDto, TeamDto } from './workspace.dto';

@ApiTags('workspace')
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService, private readonly billing: BillingService,
    private readonly workforce: WorkforceService, private readonly audit: AuditService) {}

  private async recorded<T extends { id: string }>(action: string, result: Promise<T>, req: Request): Promise<T> {
    const row = await result;
    await this.audit.record({ action: `workspace.${action}`, resource: action.split('.')[0], resourceId: row.id }, this.audit.actorFromRequest(req, req.user));
    return row;
  }

  @Get('overview') @RequirePermissions('conversations.read')
  @ApiOperation({ summary: 'Live support queue totals for the signed-in operator' })
  overview(@CurrentUser() user: AuthenticatedUser) { return this.workspace.overview(user.id); }

  @Get('billing') @RequirePermissions('billing.read')
  @ApiOperation({ summary: 'Invoices, receipts, subscriptions and currency-separated totals (latest 200 each)' })
  billingOverview() { return this.billing.overview(); }

  @Post('billing/invoices') @RequirePermissions('billing.manage')
  invoice(@Body() dto: InvoiceDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('invoice.created', this.billing.invoice(dto, user.id), req);
  }
  @Post('billing/payments') @RequirePermissions('billing.manage')
  pay(@Body() dto: PaymentDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('payment.recorded', this.billing.pay(dto, user.id), req);
  }
  @Post('billing/payments/:id/reverse') @RequirePermissions('billing.manage')
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('payment.reversed', this.billing.reverse(id, dto.reason, user.id), req);
  }
  @Post('billing/subscriptions') @RequirePermissions('billing.manage')
  subscribe(@Body() dto: SubscriptionDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('subscription.created', this.billing.subscribe(dto, user.id), req);
  }
  @Post('billing/subscriptions/:id/action') @RequirePermissions('billing.manage')
  subscriptionAction(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubscriptionActionDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded(`subscription.${dto.action.toLowerCase()}`, this.billing.subscriptionAction(id, dto, user.id), req);
  }
  @Get('billing/subscriptions/:id/history') @RequirePermissions('billing.read')
  subscriptionHistory(@Param('id', ParseUUIDPipe) id: string) { return this.billing.history(id); }

  @Get('workforce') @RequirePermissions('team.manage')
  workforceOverview() { return this.workforce.overview(); }
  @Get('assignees') @RequirePermissions('conversations.manage')
  async people() { return { items: await this.workforce.people() }; }
  @Post('workforce/teams') @RequirePermissions('team.manage')
  team(@Body() dto: TeamDto, @Req() req: Request) { return this.recorded('team.created', this.workforce.team(dto), req); }
  @Post('workforce/teams/:id/disable') @RequirePermissions('team.manage')
  disableTeam(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.recorded('team.disabled', this.workforce.disable(id), req); }
  @Post('workforce/teams/:id/members') @RequirePermissions('team.manage')
  member(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MemberDto, @Req() req: Request) {
    return this.recorded('team.member_added', this.workforce.member(id, dto.userId, false), req);
  }
  @Post('workforce/teams/:id/members/remove') @RequirePermissions('team.manage')
  removeMember(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MemberDto, @Req() req: Request) {
    return this.recorded('team.member_removed', this.workforce.member(id, dto.userId, true), req);
  }
  @Post('workforce/shifts') @RequirePermissions('team.manage')
  shift(@Body() dto: ShiftDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('shift.created', this.workforce.shift(dto, user.id), req);
  }
  @Put('workforce/shifts/:id') @RequirePermissions('team.manage')
  updateShift(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ShiftDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('shift.updated', this.workforce.updateShift(id, dto, user.id), req);
  }
  @Post('workforce/shifts/:id/cancel') @RequirePermissions('team.manage')
  cancelShift(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('shift.cancelled', this.workforce.cancelShift(id, dto.reason, user.id), req);
  }
  @Get('workforce/shifts/:id/history') @RequirePermissions('team.manage')
  shiftHistory(@Param('id', ParseUUIDPipe) id: string) { return this.workforce.shiftHistory(id); }
  @Post('workforce/leave') @RequirePermissions('team.manage')
  leave(@Body() dto: LeaveDto, @Req() req: Request) { return this.recorded('leave.requested', this.workforce.leave(dto), req); }
  @Post('workforce/leave/:id/review') @RequirePermissions('team.manage')
  reviewLeave(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveReviewDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('leave.reviewed', this.workforce.review(id, dto.status, user.id), req);
  }

  // Per-user resources are always scoped by the authenticated session, never by a submitted user id.
  @Get('notifications')
  notifications(@CurrentUser() user: AuthenticatedUser) { return this.workspace.notifications(user.id); }
  @Post('notifications/read-all')
  readAll(@CurrentUser() user: AuthenticatedUser) { return this.workspace.readNotification(user.id); }
  @Post('notifications/:id/read')
  read(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) { return this.workspace.readNotification(user.id, id); }
  @Get('saved-replies') @RequirePermissions('messages.read')
  replies(@CurrentUser() user: AuthenticatedUser) { return this.workspace.replies(user.id); }
  @Post('saved-replies') @RequirePermissions('messages.send')
  reply(@Body() dto: SavedReplyDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('saved_reply.created', this.workspace.saveReply(dto, user.id), req);
  }
  @Delete('saved-replies/:id') @RequirePermissions('messages.send')
  deleteReply(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('saved_reply.deleted', this.workspace.deleteReply(id, user.id), req);
  }
  @Get('drafts') @RequirePermissions('messages.send')
  drafts(@CurrentUser() user: AuthenticatedUser) { return this.workspace.drafts(user.id); }
  @Put('drafts') @RequirePermissions('messages.send')
  draft(@Body() dto: DraftDto, @CurrentUser() user: AuthenticatedUser) { return this.workspace.draft(dto, user.id); }
  @Get('releases')
  releases() { return this.workspace.releases(false); }
  @Get('releases/manage') @RequirePermissions('settings.manage')
  manageReleases() { return this.workspace.releases(true); }
  @Post('releases') @RequirePermissions('settings.manage')
  release(@Body() dto: ReleaseDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('release.created', this.workspace.createRelease(dto, user.id), req);
  }
  @Put('releases/:id') @RequirePermissions('settings.manage')
  updateRelease(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseUpdateDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('release.updated', this.workspace.updateRelease(id, dto, user.id), req);
  }
  @Get('releases/:id/history') @RequirePermissions('settings.manage')
  releaseHistory(@Param('id', ParseUUIDPipe) id: string) { return this.workspace.releaseHistory(id); }
  @Post('releases/:id/restore') @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Restore an owned release snapshot as a draft, preserving the current version' })
  restoreRelease(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseRestoreDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.recorded('release.restored', this.workspace.restoreRelease(id, dto.versionId, user.id), req);
  }
}
