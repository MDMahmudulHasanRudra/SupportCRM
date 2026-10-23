import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { StorageService } from '../../../common/storage/storage.service';
import { User } from '../../auth/entities/user.entity';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { MessageService } from '../../messaging/message.service';
import { Message } from '../../messaging/entities/message.entity';
import type { ChannelCommand } from '../channel-adapter.interface';
import { commandRecipient, commandContent } from './gowa-schedule.service';
import { safeMime } from './gowa-media.service';
import { integrationHttp, integrationUrl } from './integration-http';
import type { OperationInput } from './gowa-catalogue';
interface IntegrationConfig {
    chatwoot_url: string;
    account_id: number;
    inbox_id: number;
    api_token: string;
    secret: string;
}
interface IntegrationRow {
    accountId: string;
    userId: string;
    encryptedConfig: string;
    secretHash: string;
    enabled: boolean;
    syncSince: Date;
    includeMedia: boolean;
    includeGroups: boolean;
    createdAt: Date;
}
interface ChatwootContact {
    id: number;
    identifier?: string;
    phone_number?: string;
    custom_attributes?: Record<string, unknown>;
}
interface ChatwootWebhook {
    id?: number;
    event?: string;
    message_type?: string | number;
    content?: string;
    private?: boolean;
    source_id?: string;
    account?: {
        id?: number;
    };
    conversation?: {
        id?: number;
        inbox_id?: number;
        meta?: {
            sender?: ChatwootContact;
        };
    };
    content_attributes?: Record<string, unknown>;
    attachments?: Array<{
        data_url?: string;
        file_type?: string;
    }>;
}
@Injectable()
export class GoWaIntegrationService {
    constructor(private readonly db: DataSource, private readonly crypto: CryptoService, private readonly settings: ConfigService, private readonly messages: MessageService, private readonly storage: StorageService) { }
    private async row(accountId: string) { const [row] = await this.db.query<IntegrationRow[]>('SELECT * FROM whatsapp_integrations WHERE "accountId"=$1', [accountId]); return row; }
    private config(row: IntegrationRow) { return JSON.parse(this.crypto.decryptSecret(row.encryptedConfig, `chatwoot:${row.accountId}`)) as IntegrationConfig; }
    async actor(id: string) { const actor = await this.db.getRepository(User).findOne({ where: { id }, relations: { roles: { permissions: true } } }); if (!actor?.isActive)
        throw new ForbiddenException('The integration owner is no longer active.'); return { id: actor.id, username: actor.username, email: actor.email, name: actor.name, roleKeys: actor.roles.map(r => r.key), permissions: new Set(actor.roles.flatMap(r => r.permissions.map(p => p.key))), isSuperAdmin: actor.roles.some(r => r.isSuperAdmin), sessionId: 'chatwoot' } satisfies AuthenticatedUser; }
    private allow(user: AuthenticatedUser, permission: string) { if (!user.isSuperAdmin && !user.permissions.has(permission))
        throw new ForbiddenException(`Permission ${permission} is required.`); }
    private view(row: IntegrationRow) { const config = this.config(row); return { accountId: row.accountId, chatwoot_url: config.chatwoot_url, account_id: config.account_id, inbox_id: config.inbox_id, enabled: row.enabled, tokenConfigured: !!config.api_token, callbackPath: `/api/v1/channels/whatsapp/integrations/chatwoot/${row.accountId}`, authenticationHeader: 'X-Chatwoot-Webhook-Secret', syncSince: row.syncSince, includeMedia: row.includeMedia, includeGroups: row.includeGroups }; }
    async read(accountId: string, operation: string, user: AuthenticatedUser) { this.allow(user, 'channels.manage'); const row = await this.row(accountId); if (operation === 'chatwootListConfigs')
        return { items: row ? [this.view(row)] : [] }; if (operation === 'chatwootSyncStatus') {
        const items = await this.db.query('SELECT status,count(*)::int AS count FROM whatsapp_chatwoot_deliveries WHERE "accountId"=$1 GROUP BY status', [accountId]);
        return { configured: !!row, enabled: row?.enabled ?? false, deliveries: items };
    } if (!row)
        throw new NotFoundException('Configure Chatwoot for this account first.'); return this.view(row); }
    async execute(accountId: string, operation: string, input: OperationInput, user: AuthenticatedUser) {
        this.allow(user, 'channels.manage');
        const current = await this.row(accountId);
        if (operation === 'chatwootDeleteDeviceConfig') {
            await this.db.transaction(async (tx) => { await tx.query('DELETE FROM whatsapp_integrations WHERE "accountId"=$1', [accountId]); await tx.query('DELETE FROM whatsapp_chatwoot_bindings WHERE "accountId"=$1', [accountId]); });
            return { removed: true };
        }
        if (operation === 'chatwootUpsertDeviceConfig') {
            const body = input.body;
            const base = integrationUrl(String(body.chatwoot_url));
            const previous = current ? this.config(current) : null;
            const config: IntegrationConfig = { chatwoot_url: base.href.replace(/\/$/, ''), account_id: Number(body.account_id), inbox_id: Number(body.inbox_id), api_token: String(body.api_token || previous?.api_token || ''), secret: previous?.secret ?? randomBytes(32).toString('hex') };
            if (!Number.isSafeInteger(config.account_id) || config.account_id < 1 || !Number.isSafeInteger(config.inbox_id) || config.inbox_id < 1 || !config.api_token)
                throw new BadRequestException('Chatwoot URL, account, inbox and API token are required.');
            // A real read confirms the supplied account/inbox before enabling a bridge. No message is sent.
            await this.api(config, 'GET', `/inboxes/${config.inbox_id}`);
            const changed = previous && (previous.chatwoot_url !== config.chatwoot_url || previous.account_id !== config.account_id || previous.inbox_id !== config.inbox_id);
            if (changed)
                throw new BadRequestException('Disable and clear the previous destination before using a different Chatwoot inbox.');
            await this.db.query(`INSERT INTO whatsapp_integrations("accountId","userId","encryptedConfig","secretHash",enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT("accountId") DO UPDATE SET "userId"=$2,"encryptedConfig"=$3,"secretHash"=$4,enabled=$5,"updatedAt"=now()`, [accountId, user.id, this.crypto.encryptSecret(JSON.stringify(config), `chatwoot:${accountId}`), createHash('sha256').update(config.secret).digest('hex'), body.enabled === true]);
            return { configured: true, enabled: body.enabled === true, setup: 'Open WhatsApp integration settings to reveal the callback secret to an administrator.' };
        }
        if (operation === 'chatwootSyncHistory') {
            if (!current)
                throw new NotFoundException('Configure Chatwoot first.');
            const days = Number(input.body.days_limit ?? 7);
            if (!Number.isInteger(days) || days < 1 || days > 365)
                throw new BadRequestException('History range must be 1 to 365 days.');
            await this.db.query('UPDATE whatsapp_integrations SET "syncSince"=$2,"includeMedia"=$3,"includeGroups"=$4,"updatedAt"=now() WHERE "accountId"=$1', [accountId, new Date(Date.now() - days * 86400000), input.body.include_media !== false, input.body.include_groups === true]);
            return { queued: true, scope: 'CRM message history', days };
        }
        throw new BadRequestException('Configure the authenticated CRM webhook in Chatwoot settings.');
    }
    async credentials(accountId: string, user: AuthenticatedUser) { this.allow(user, 'channels.manage'); const row = await this.row(accountId); if (!row)
        throw new NotFoundException('Configure Chatwoot first.'); const config = this.config(row); return { ...this.view(row), webhookSecret: config.secret, callbackUrl: `${this.settings.getOrThrow<string>('http.publicUrl').replace(/\/$/, '')}/api/v1/channels/whatsapp/integrations/chatwoot/${accountId}` }; }
    private async api<T = Record<string, unknown>>(config: IntegrationConfig, method: string, path: string, body?: Record<string, unknown> | Buffer, type?: string): Promise<T> { const url = new URL(`${config.chatwoot_url}/api/v1/accounts/${config.account_id}${path}`); const response = await integrationHttp(url, config.api_token, method, body, type); return JSON.parse(response.buffer.toString('utf8')) as T; }
    async webhook(accountId: string, secret: string, payload: ChatwootWebhook) {
        const row = await this.row(accountId);
        const digest = createHash('sha256').update(secret).digest();
        if (!row || !secret || !timingSafeEqual(Buffer.from(row.secretHash, 'hex'), digest))
            throw new UnauthorizedException('Invalid integration authentication.');
        if (!row.enabled)
            return { ignored: true };
        const config = this.config(row);
        if (payload.account?.id !== config.account_id || payload.conversation?.inbox_id !== config.inbox_id)
            throw new UnauthorizedException('Incorrect integration destination.');
        if (payload.event !== 'message_created' || payload.private || !['outgoing', 1].includes(payload.message_type ?? '') || String(payload.source_id ?? '').startsWith('WAID:'))
            return { ignored: true };
        if (!Number.isSafeInteger(payload.id) || Number(payload.id) < 1)
            throw new BadRequestException('Message ID is required.');
        const actor = await this.actor(row.userId);
        this.allow(actor, 'messages.send');
        const [binding] = await this.db.query<Array<{
            chat: string;
        }>>('SELECT chat FROM whatsapp_chatwoot_bindings WHERE "accountId"=$1 AND "conversationId"=$2', [accountId, payload.conversation?.id]);
        if (!binding)
            throw new BadRequestException('This conversation has no verified WhatsApp binding. Synchronize its history first.');
        const attachments = payload.attachments ?? [];
        if (attachments.length > 10)
            throw new BadRequestException('A message may contain at most ten attachments.');
        const ids: string[] = [];
        const content = String(payload.content ?? '').slice(0, 16000);
        const reply = typeof payload.content_attributes?.in_reply_to_external_id === 'string' ? payload.content_attributes.in_reply_to_external_id.replace(/^WAID:/, '') : undefined;
        if (content.trim()) {
            const command: ChannelCommand = { name: 'sendMessage', args: { parameters: {}, body: { phone: binding.chat, message: content, ...(reply ? { reply_message_id: reply } : {}) } } };
            const result = await this.messages.send({ channelAccountId: accountId, externalConversationId: commandRecipient(command), ...commandContent(command), channelCommand: command, createdById: actor.id, idempotencyKey: `cw-${accountId}-${payload.id}-text` });
            ids.push(result.id);
        }
        for (const [index, attachment] of attachments.entries()) {
            const key = `cw-${accountId}-${payload.id}-${index}`;
            const [existing] = await this.db.query<Array<{
                id: string;
            }>>('SELECT id FROM outbound_messages WHERE "idempotencyKey"=$1', [key]);
            if (existing) {
                ids.push(existing.id);
                continue;
            }
            const location = new URL(String(attachment.data_url ?? ''));
            const base = new URL(config.chatwoot_url);
            if (location.origin !== base.origin || !location.pathname.startsWith('/rails/active_storage/'))
                throw new BadRequestException('Attachment must use this Chatwoot server active-storage URL.');
            const media = await integrationHttp(location, config.api_token, 'GET', undefined, undefined, 25 * 1024 * 1024);
            const mime = safeMime(media.buffer, media.mime);
            const type = mime.startsWith('image/') ? 'Image' : mime.startsWith('audio/') ? 'Audio' : mime.startsWith('video/') ? 'Video' : 'File';
            const field = type.toLowerCase();
            const name = decodeURIComponent(location.pathname.split('/').pop() ?? 'attachment').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 180);
            const stored = await this.storage.put(media.buffer, name);
            const command: ChannelCommand = { name: `send${type}`, args: { parameters: {}, body: { phone: binding.chat, [field]: 'chatwoot-upload', ...(reply ? { reply_message_id: reply } : {}) } }, files: { [field]: { ref: stored.ref, name, mime } } };
            const result = await this.messages.send({ channelAccountId: accountId, externalConversationId: commandRecipient(command), ...commandContent(command), channelCommand: command, createdById: actor.id, idempotencyKey: key });
            ids.push(result.id);
        }
        return { queued: ids.length > 0, ids };
    }
    async sweep() { await this.db.query("UPDATE whatsapp_chatwoot_deliveries SET status='UNKNOWN',error='Worker stopped before recording the remote outcome.' WHERE status='RUNNING' AND \"createdAt\"<now()-interval '10 minutes'");const rows = await this.db.query<IntegrationRow[]>('SELECT i.* FROM whatsapp_integrations i JOIN channel_accounts a ON a.id=i."accountId" WHERE i.enabled=true AND a."ownershipEnabled"=true LIMIT 20'); for (const row of rows) {
        const actor = await this.actor(row.userId);
        this.allow(actor, 'channels.manage');
        const messages = await this.db.query<Message[]>(`SELECT m.* FROM messages m LEFT JOIN whatsapp_chatwoot_deliveries d ON d."accountId"=m."channelAccountId" AND d."messageId"=m.id WHERE m."channelAccountId"=$1 AND m."sentAt">=$2 AND d."messageId" IS NULL AND NOT EXISTS(SELECT 1 FROM outbound_messages o WHERE o."channelAccountId"=m."channelAccountId" AND (o.id=m."outboundMessageId" OR o."externalMessageId"=m."externalId") AND o."idempotencyKey" LIKE 'cw-%') AND ($3 OR m."externalGroupId" IS NULL) ORDER BY m."sentAt" ASC LIMIT 20`, [row.accountId, row.syncSince, row.includeGroups]);
        for (const message of messages) {
            try {
                await this.mirror(row, message);
            }
            catch (error) {
                await this.db.query('UPDATE whatsapp_chatwoot_deliveries SET status=$3,error=$4 WHERE "accountId"=$1 AND "messageId"=$2', [row.accountId, message.id, 'UNKNOWN', (error as Error).message.slice(0, 1000)]);
            }
        }
    } }
    private async mirror(row: IntegrationRow, message: Message) {
        const [claim] = await this.db.query<Array<{
            messageId: string;
        }>>('INSERT INTO whatsapp_chatwoot_deliveries("accountId","messageId") VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING "messageId"', [row.accountId, message.id]);
        if (!claim)
            return;
        const config = this.config(row);
        const chat = message.externalConversationId;
        let [binding] = await this.db.query<Array<{
            conversationId: number;
            contactId: number;
        }>>('SELECT "conversationId","contactId" FROM whatsapp_chatwoot_bindings WHERE "accountId"=$1 AND chat=$2', [row.accountId, chat]);
        if (!binding) {
            const search = await this.api<{
                payload: ChatwootContact[];
            }>(config, 'GET', `/contacts/search?q=${encodeURIComponent(chat)}`);
            let contact = search.payload?.find(c => c.identifier === chat || c.custom_attributes?.gowa_whatsapp_jid === chat);
            if (!contact) {
                const result = await this.api<{
                    payload: {
                        contact: ChatwootContact;
                    };
                }>(config, 'POST', '/contacts', { inbox_id: config.inbox_id, name: message.senderDisplayName ?? chat, identifier: chat, custom_attributes: { gowa_whatsapp_jid: chat } });
                contact = result.payload.contact;
            }
            const conversations = await this.api<{
                payload: Array<{
                    id: number;
                    inbox_id: number;
                    status: string;
                }>;
            }>(config, 'GET', `/contacts/${contact.id}/conversations`);
            let conversation = conversations.payload?.find(c => c.inbox_id === config.inbox_id && c.status !== 'resolved');
            if (!conversation)
                conversation = await this.api(config, 'POST', '/conversations', { inbox_id: config.inbox_id, contact_id: contact.id, source_id: chat, status: 'open' }) as unknown as {
                    id: number;
                    inbox_id: number;
                    status: string;
                };
            binding = { conversationId: conversation.id, contactId: contact.id };
            await this.db.query('INSERT INTO whatsapp_chatwoot_bindings("accountId",chat,"conversationId","contactId") VALUES($1,$2,$3,$4) ON CONFLICT("accountId",chat) DO NOTHING', [row.accountId, chat, binding.conversationId, binding.contactId]);
        }
        const body: Record<string, unknown> = { content: message.body ?? `[${message.contentType}]`, message_type: message.fromAccount ? 'outgoing' : 'incoming', private: false, source_id: `WAID:${message.externalId}`, content_attributes: message.quotedExternalId ? { in_reply_to_external_id: `WAID:${message.quotedExternalId}` } : {} };
        const [attachment] = row.includeMedia ? await this.db.query<Array<{
            storageRef: string;
            filename: string;
            mimeType: string;
        }>>('SELECT "storageRef",filename,"mimeType" FROM message_attachments WHERE "messageId"=$1 AND "storageRef" IS NOT NULL LIMIT 1', [message.id]) : [];
        let result: {
            id: number;
        };
        if (attachment) {
            const boundary = `crm-${randomBytes(16).toString('hex')}`;
            const chunks: Buffer[] = [];
            for (const [name, value] of Object.entries(body))
                chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${typeof value === 'object' ? JSON.stringify(value) : value}\r\n`));
            const name = (attachment.filename ?? 'media').replace(/["\r\n\\]/g, '_');
            chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachments[]"; filename="${name}"\r\nContent-Type: ${attachment.mimeType}\r\n\r\n`));
            let size = 0;
            for await (const part of this.storage.read(attachment.storageRef)) {
                size += (part as Buffer).length;
                if (size > 25 * 1024 * 1024)
                    throw new BadRequestException('Attachment is too large.');
                chunks.push(part as Buffer);
            }
            chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
            result = await this.api(config, 'POST', `/conversations/${binding.conversationId}/messages`, Buffer.concat(chunks), `multipart/form-data; boundary=${boundary}`);
        }
        else
            result = await this.api(config, 'POST', `/conversations/${binding.conversationId}/messages`, body);
        await this.db.query('UPDATE whatsapp_chatwoot_deliveries SET status=$3,"remoteId"=$4 WHERE "accountId"=$1 AND "messageId"=$2', [row.accountId, message.id, 'COMPLETED', result.id]);
    }
}
