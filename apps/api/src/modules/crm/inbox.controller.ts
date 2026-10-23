import { Body, Controller, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsUUID } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { InboxService } from './inbox.service';
export class ReadMessagesDto { @IsArray() @ArrayMaxSize(200) @ArrayUnique() @IsUUID('all',{each:true}) messageIds!:string[]; }
export class OrganizeInboxDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ArrayUnique() @IsUUID('all',{each:true}) conversationIds!:string[];
  @IsIn(['ARCHIVE','UNARCHIVE','MARK_UNREAD']) action!:'ARCHIVE'|'UNARCHIVE'|'MARK_UNREAD';
}
export class PinInboxDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ArrayUnique() @IsUUID('all',{each:true}) conversationIds!:string[];
  @IsIn(['PIN','UNPIN']) action!:'PIN'|'UNPIN';
}
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox:InboxService,private readonly audit:AuditService) {}
  @Post('conversations/:id/read') @RequirePermissions('conversations.read','messages.read')
  async read(@Param('id',ParseUUIDPipe) id:string,@Body() dto:ReadMessagesDto,@CurrentUser() user:AuthenticatedUser,@Req() req:Request) {
    const result=await this.inbox.read(id,dto.messageIds,user.id);
    await this.audit.record({action:'inbox.messages_read',resource:'conversation',resourceId:id,metadata:{messages:dto.messageIds.length}},this.audit.actorFromRequest(req,user));
    return result;
  }
  @Post('organize') @RequirePermissions('conversations.read')
  async organize(@Body() dto:OrganizeInboxDto,@CurrentUser() user:AuthenticatedUser,@Req() req:Request) {
    const result=await this.inbox.organize(dto.conversationIds,dto.action,user.id);
    await this.audit.record({action:`inbox.${dto.action.toLowerCase()}`,resource:'conversation',metadata:{count:dto.conversationIds.length}},this.audit.actorFromRequest(req,user));
    return result;
  }
  @Post('pin') @RequirePermissions('conversations.read','conversations.manage')
  async pin(@Body() dto:PinInboxDto,@CurrentUser() user:AuthenticatedUser,@Req() req:Request) {
    const result=await this.inbox.organize(dto.conversationIds,dto.action,user.id);
    await this.audit.record({action:`inbox.${dto.action.toLowerCase()}`,resource:'conversation',metadata:{count:dto.conversationIds.length}},this.audit.actorFromRequest(req,user));
    return result;
  }
}
