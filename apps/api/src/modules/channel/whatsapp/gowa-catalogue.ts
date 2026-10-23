import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import Ajv from 'ajv';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { GOWA_WORKSPACE_OPERATIONS } from './gowa-workspace.operations';
import { GOWA_OPERATIONS } from './gowa-operations.generated';
import type { GoWaOperation } from './gowa-operation.types';
export interface OperationInput {
    parameters: Record<string, unknown>;
    body: Record<string, unknown>;
}
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const remoteMedia = ['image_url', 'audio_url', 'video_url', 'file_url', 'sticker_url'];
@Injectable()
export class GoWaCatalogue {
    private readonly validators = new Map<string, ReturnType<Ajv['compile']>>();
    operation(id: string): GoWaOperation { const op = [...GOWA_OPERATIONS, ...GOWA_WORKSPACE_OPERATIONS].find(o => o.id === id); if (!op)
        throw new NotFoundException('Unknown WhatsApp tool.'); return op; }
    permissions(op: GoWaOperation): string[] {
        const keys = ['channels.read'];
        if (op.id === 'importChatHistory')
            keys.push('messages.read', 'conversations.manage');
        else if (op.mode === 'schedule')
            keys.push(op.method === 'GET' ? 'messages.read' : 'messages.send');
        else if (op.mode === 'send' || op.route.startsWith('/send/'))
            keys.push('messages.send');
        else if (op.id.startsWith('chatwoot'))
            keys.push('channels.manage');
        else if (op.route.startsWith('/message') || op.route.startsWith('/chat') || op.route === '/chats')
            keys.push(op.mode === 'read' ? 'messages.read' : 'messages.send');
        else if (op.route.startsWith('/group') || op.id === 'userMyGroups')
            keys.push(op.mode === 'read' ? 'groups.read' : 'groups.update');
        else if (op.id === 'userMyContacts')
            keys.push('customers.read');
        else if (op.mode !== 'read' || op.id === 'userMyPrivacy')
            keys.push('channels.manage');
        return keys;
    }
    assertPermission(op: GoWaOperation, user: Pick<AuthenticatedUser, 'permissions' | 'isSuperAdmin'>) { if (!user.isSuperAdmin && this.permissions(op).some(p => !user.permissions.has(p)))
        throw new ForbiddenException('Your role cannot use this WhatsApp tool.'); }
    reason(op: GoWaOperation): string | null {
        if (op.mode === 'account')
            return 'Use the account connection and pairing controls.';
        if (op.mode === 'integration')
            return 'Configure the authenticated Chatwoot reply webhook in WhatsApp settings.';
        return null;
    }
    validate(op: GoWaOperation, input: OperationInput) {
        if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 256 * 1024)
            throw new BadRequestException('Tool input exceeds 256 KiB.');
        for (const key of remoteMedia)
            if (input.body[key])
                throw new BadRequestException('Upload the media file inside CRM instead of supplying a remote media URL.');
        let validate = this.validators.get(op.id);
        if (!validate) {
            const parameters = { type: 'object', properties: Object.fromEntries(op.parameters.map(p => [p.name, p.schema])), required: op.parameters.filter(p => p.required).map(p => p.name), additionalProperties: false };
            validate = ajv.compile({ type: 'object', properties: { parameters, body: op.body }, required: ['parameters', 'body'], additionalProperties: false });
            this.validators.set(op.id, validate);
        }
        if (!validate(input))
            throw new BadRequestException(validate.errors?.slice(0, 12).map(e => `${e.instancePath || 'Input'} ${e.message}`));
    }
    route(op: GoWaOperation, input: OperationInput) {
        let route = op.route;
        const query = new URLSearchParams();
        for (const p of op.parameters) {
            const value = input.parameters[p.name];
            if (value === undefined || value === '')
                continue;
            if (p.location === 'path')
                route = route.replace(`{${p.name}}`, encodeURIComponent(String(value)));
            else if (p.location === 'query')
                query.set(p.name, String(value));
        }
        if (route.includes('{'))
            throw new BadRequestException('Required tool identifier is missing.');
        return route + (query.size ? `?${query}` : '');
    }
}
