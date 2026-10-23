import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Header, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsISO8601, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { AuditService } from '../../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../../rbac/permissions.guard';
import { ChannelLabelService } from '../../messaging/channel-label.service';
import { GoWaHistoryService } from './gowa-history.service';
import { GoWaMediaService } from './gowa-media.service';
import { GoWaToolsService } from './gowa-tools.service';
import type { ToolUploadFile } from './gowa-operation.types';
export class ToolReadDto {
    @IsObject()
    parameters!: Record<string, unknown>;
    @IsObject()
    body!: Record<string, unknown>;
}
export class ToolActionDto extends ToolReadDto {
    @IsUUID()
    requestKey!: string;
    @IsBoolean()
    confirmed!: boolean;
    @IsOptional()
    @IsObject()
    files?: Record<string, string>;
    @IsOptional()
    @IsISO8601()
    scheduledFor?: string;
}
export class PairWithPhoneDto {
    @IsString()
    phone!: string;
}
@Controller('channels/whatsapp/tools')
export class GoWaToolsController {
    constructor(private readonly tools: GoWaToolsService, private readonly audit: AuditService, private readonly media: GoWaMediaService, private readonly history: GoWaHistoryService,private readonly labels:ChannelLabelService) { }
    @Get('accounts/:id/files/:fileId')
    @RequirePermissions('messages.read')
    @Header('Cache-Control', 'private, no-store')
    @Header('X-Content-Type-Options', 'nosniff')
    file(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @Param('fileId', ParseUUIDPipe)
    fileId: string, 
    @CurrentUser()
    user: AuthenticatedUser) { return this.media.file(id, fileId, user); }
    @Get('accounts/:id/messages/:messageId/media')
    @RequirePermissions('messages.read')
    @Header('Cache-Control', 'private, no-store')
    @Header('X-Content-Type-Options', 'nosniff')
    messageMedia(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @Param('messageId', ParseUUIDPipe)
    messageId: string, 
    @CurrentUser()
    user: AuthenticatedUser) { return this.media.message(id, messageId, user); }
    @Get('accounts/:id/events/:eventId/media')
    @RequirePermissions('messages.read')
    @Header('Cache-Control', 'private, no-store')
    @Header('X-Content-Type-Options', 'nosniff')
    eventMedia(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @Param('eventId', ParseUUIDPipe)
    eventId: string, 
    @CurrentUser()
    user: AuthenticatedUser) { return this.media.event(id, eventId, user); }
    @Get('accounts/:id/feed')
    @RequirePermissions('messages.read')
    feed(
    @Param('id', ParseUUIDPipe)
    id: string) { return this.history.feed(id); }
    @Get('accounts/:id/labels')@RequirePermissions('conversations.read')
    async listLabels(@Param('id',ParseUUIDPipe)id:string){await this.tools.account(id);return this.labels.list(id);}
    @Get('catalogue')
    @RequirePermissions('channels.read')
    catalogue(
    @CurrentUser()
    user: AuthenticatedUser) { return this.tools.catalogueFor(user); }
    @Post('accounts/:id/read/:operation')
    @RequirePermissions('channels.read')
    async read(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @Param('operation')
    operation: string, 
    @Body()
    input: ToolReadDto, 
    @CurrentUser()
    user: AuthenticatedUser, 
    @Req()
    req: Request) { const result = await this.tools.read(id, operation, input, user); await this.audit.record({ action: 'whatsapp.tool_read', resource: 'channel_account', resourceId: id, metadata: { operation } }, this.audit.actorFromRequest(req, user)); return result; }
    @Post('accounts/:id/actions/:operation')
    @RequirePermissions('channels.read')
    async action(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @Param('operation')
    operation: string, 
    @Body()
    input: ToolActionDto, 
    @CurrentUser()
    user: AuthenticatedUser, 
    @Req()
    req: Request) { const result = await this.tools.submit(id, operation, input, user); await this.audit.record({ action: 'whatsapp.tool_submitted', resource: 'channel_account', resourceId: id, metadata: { operation, actionId: result.id } }, this.audit.actorFromRequest(req, user)); return result; }
    @Post('accounts/:id/uploads')
    @RequirePermissions('channels.read')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
    async upload(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @UploadedFile()
    file: ToolUploadFile, 
    @CurrentUser()
    user: AuthenticatedUser, 
    @Req()
    req: Request) { const result = await this.tools.upload(id, file, user); await this.audit.record({ action: 'whatsapp.file_uploaded', resource: 'channel_account', resourceId: id, metadata: { bytes: result.size } }, this.audit.actorFromRequest(req, user)); return result; }
    @Get('accounts/:id/events')
    @RequirePermissions('messages.read')
    events(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @CurrentUser()
    user: AuthenticatedUser) { return this.tools.events(id, user); }
    @Get('accounts/:id/actions')
    @RequirePermissions('channels.read')
    list(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @CurrentUser()
    user: AuthenticatedUser) { return this.tools.list(id, user); }
    @Get('accounts/:id/actions/:actionId')
    @RequirePermissions('channels.read')
    get(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @Param('actionId', ParseUUIDPipe)
    actionId: string, 
    @CurrentUser()
    user: AuthenticatedUser) { return this.tools.get(id, actionId, user); }
    @Post('accounts/:id/actions/:actionId/cancel')
    @RequirePermissions('channels.read')
    async cancel(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @Param('actionId', ParseUUIDPipe)
    actionId: string, 
    @CurrentUser()
    user: AuthenticatedUser, 
    @Req()
    req: Request) { const result = await this.tools.cancel(id, actionId, user); await this.audit.record({ action: 'whatsapp.tool_cancelled', resource: 'channel_account', resourceId: id, metadata: { actionId } }, this.audit.actorFromRequest(req, user)); return result; }
}
