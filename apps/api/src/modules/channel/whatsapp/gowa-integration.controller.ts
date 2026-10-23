import { Body, Controller, Get, Header, Headers, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../auth/session.guard';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../../rbac/permissions.guard';
import { AuditService } from '../../audit/audit.service';
import { GoWaIntegrationService } from './gowa-integration.service';
@Controller('channels/whatsapp/integrations')
export class GoWaIntegrationController {
    constructor(private readonly integration: GoWaIntegrationService, private readonly audit: AuditService) { }
    @Get('chatwoot/:id/setup')
    @RequirePermissions('channels.manage')
    @Header('Cache-Control', 'no-store')
    async setup(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @CurrentUser()
    user: AuthenticatedUser, 
    @Req()
    req: Request) { const value = await this.integration.credentials(id, user); await this.audit.record({ action: 'whatsapp.integration_credentials_viewed', resource: 'channel_account', resourceId: id }, this.audit.actorFromRequest(req, user)); return value; }
    @Public()
    @Post('chatwoot/:id')
    webhook(
    @Param('id', ParseUUIDPipe)
    id: string, 
    @Headers('x-chatwoot-webhook-secret')
    secret: string, 
    @Body()
    body: Record<string, unknown>) { return this.integration.webhook(id, secret ?? '', body); }
}
