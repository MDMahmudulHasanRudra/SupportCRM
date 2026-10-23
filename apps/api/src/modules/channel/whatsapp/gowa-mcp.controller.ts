import { Body, Controller, ForbiddenException, Get, HttpException, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Allow, Equals, IsObject, IsOptional, IsString, isUUID } from 'class-validator';
import Ajv from 'ajv';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../../rbac/permissions.guard';
import { AuditService } from '../../audit/audit.service';
import { GoWaToolsService } from './gowa-tools.service';
export class McpRequestDto {
    @Equals('2.0')
    jsonrpc!: string;
    @IsString()
    method!: string;
    @IsOptional()
    @IsObject()
    params?: Record<string, unknown>;
    @Allow()
    id?: string | number | null;
}
/** Stateless JSON Streamable HTTP bridge. It uses CRM sessions and queued tool actions. */
@Controller('channels/whatsapp/mcp')
export class GoWaMcpController {
    constructor(private readonly tools: GoWaToolsService, private readonly config: ConfigService, private readonly audit: AuditService) { }
    private origin(req: Request) { const origin = req.headers.origin; if (origin && !this.config.getOrThrow<string[]>('http.corsOrigins').includes(origin))
        throw new ForbiddenException('Origin is not allowed.'); }
    @Get(':accountId')
    @RequirePermissions('channels.read')
    stream(
    @Param('accountId', ParseUUIDPipe)
    _id: string, 
    @Req()
    req: Request, 
    @Res()
    res: Response) { this.origin(req); res.status(405).set('Allow', 'POST').end(); }
    @Post(':accountId')
    @RequirePermissions('channels.read')
    async rpc(
    @Param('accountId', ParseUUIDPipe)
    accountId: string, 
    @Body()
    request: McpRequestDto, 
    @CurrentUser()
    user: AuthenticatedUser, 
    @Req()
    req: Request, 
    @Res()
    res: Response) {
        this.origin(req);
        res.set('Cache-Control', 'no-store');
        if (request.id === undefined) {
            res.status(202).end();
            return;
        }
        const reply = (result: unknown) => res.status(200).json({ jsonrpc: '2.0', id: request.id, result });
        const fail = (code: number, message: string) => res.status(200).json({ jsonrpc: '2.0', id: request.id, error: { code, message } });
        if (request.method === 'initialize') {
            reply({ protocolVersion: ['2025-11-25', '2025-06-18'].includes(String(request.params?.protocolVersion)) ? request.params?.protocolVersion : '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'support-crm-whatsapp', version: '1.0.0' }, instructions: 'Write calls enqueue audited CRM actions. A human must review each action. Use a stable requestKey for retries and inspect action status. Native account and webhook controls remain in the web workspace.' });
            return;
        }
        if (request.method === 'ping') {
            reply({});
            return;
        }
        const catalogue = this.tools.catalogueFor(user).operations.filter(op => !op.disabledReason);
        if (request.method === 'tools/list') {
            const actionTools=['crm_action_status','crm_action_cancel'].map(name=>({name,title:name==='crm_action_status'?'Read CRM action status':'Cancel queued CRM action',inputSchema:{type:'object',properties:{actionId:{type:'string',format:'uuid'}},required:['actionId'],additionalProperties:false},annotations:{readOnlyHint:name==='crm_action_status'}}));
            reply({ tools: [...catalogue.map(op => ({ name: op.id, title: op.title, description: `${op.title}. ${op.mode === 'read' ? 'Read current data.' : 'Submit through CRM controls; inspect the returned action status.'}`, inputSchema: { type: 'object', properties: { parameters: { type: 'object', properties: Object.fromEntries(op.parameters.map(p => [p.name, p.schema])), required: op.parameters.filter(p => p.required).map(p => p.name), additionalProperties: false }, body: op.body, ...(op.mode === 'read' || op.mode === 'schedule' && op.id.startsWith('get') || op.id === 'listScheduledSends' ? {} : { requestKey: { type: 'string', format: 'uuid' }, confirmed: { type: 'boolean', const: true }, files: { type: 'object', additionalProperties: { type: 'string', format: 'uuid' } }, scheduledFor: { type: 'string', format: 'date-time' } }) }, required: ['parameters', 'body', ...(op.mode === 'read' || ['getScheduledSend', 'listScheduledSends'].includes(op.id) ? [] : ['requestKey', 'confirmed'])], additionalProperties: false }, annotations: { readOnlyHint: op.mode === 'read' || ['getScheduledSend', 'listScheduledSends'].includes(op.id), destructiveHint: op.mode === 'action', openWorldHint: true } })),...actionTools] });
            return;
        }
        if (request.method !== 'tools/call') {
            fail(-32601, 'Method not found.');
            return;
        }
        if(['crm_action_status','crm_action_cancel'].includes(String(request.params?.name))){
            const args=request.params?.arguments as {actionId?:string}|undefined;if(!isUUID(args?.actionId)){fail(-32602,'A UUID actionId is required.');return;}
            try{const result=request.params?.name==='crm_action_cancel'?await this.tools.cancel(accountId,args!.actionId!,user):await this.tools.get(accountId,args!.actionId!,user);await this.audit.record({action:'whatsapp.mcp_action',resource:'channel_account',resourceId:accountId,metadata:{operation:request.params?.name,actionId:args!.actionId}},this.audit.actorFromRequest(req,user));reply({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});}catch{reply({content:[{type:'text',text:'The action could not be read or cancelled.'}],isError:true});}return;
        }
        const op = catalogue.find(item => item.id === request.params?.name);
        if (!op) {
            fail(-32602, 'Unknown or unauthorized tool.');
            return;
        }
        const input = request.params?.arguments as {
            parameters: Record<string, unknown>;
            body: Record<string, unknown>;
            requestKey: string;
            confirmed: boolean;
            files?: Record<string, string>;
            scheduledFor?: string;
        } | undefined;
        const validate = new Ajv({ strict: false, validateFormats: false }).compile({ type: 'object', properties: { parameters: { type: 'object' }, body: { type: 'object' }, requestKey: { type: 'string' }, confirmed: { type: 'boolean' }, files: { type: 'object', additionalProperties: { type: 'string' } }, scheduledFor: { type: 'string' } }, required: ['parameters', 'body'], additionalProperties: false });
        if (!input || !validate(input)) {
            fail(-32602, 'Invalid tool arguments.');
            return;
        }
        try {
            const read = op.mode === 'read' || ['getScheduledSend', 'listScheduledSends'].includes(op.id);
            if (!read && (!isUUID(input.requestKey) || input.confirmed !== true)) {
                fail(-32602, 'Writes require a UUID requestKey and explicit confirmed=true.');
                return;
            }
            const result = read ? await this.tools.read(accountId, op.id, input, user) : await this.tools.submit(accountId, op.id, input, user);
            await this.audit.record({ action: 'whatsapp.mcp_tool', resource: 'channel_account', resourceId: accountId, metadata: { operation: op.id } }, this.audit.actorFromRequest(req, user));
            reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { value: result }, isError: false });
        }
        catch (error) {
            const status = error instanceof HttpException ? error.getStatus() : 500;
            reply({ content: [{ type: 'text', text: status < 500 ? (error as Error).message : 'The tool failed. Inspect the CRM action history before retrying a write.' }], isError: true });
        }
    }
}
