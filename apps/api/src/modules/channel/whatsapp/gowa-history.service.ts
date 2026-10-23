import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LockService } from '../../../common/redis/lock.service';
import { InboundMessageService } from '../../messaging/inbound-message.service';
import { MessageProcessingStatus } from '../../messaging/message-types';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ChannelAccount } from '../entities/channel-account.entity';
import { GoWaClient } from './gowa.client';
import { WhatsAppChannelAdapter } from './whatsapp.adapter';
import { crmJid, providerJid } from './gowa-identifiers';
import type { OperationInput } from './gowa-catalogue';
interface StoredMessage {
    id: string;
    chat_jid: string;
    sender_jid: string;
    sender_display_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    media_type: string;
    filename: string;
    context_metadata?: string;
    reactions?: Array<{
        sender_jid: string;
        emoji: string;
    }>;
}
@Injectable()
export class GoWaHistoryService {
    constructor(private readonly db: DataSource, private readonly client: GoWaClient, private readonly adapter: WhatsAppChannelAdapter, private readonly messages: InboundMessageService, private readonly locks: LockService, private readonly realtime: RealtimeGateway) { }
    async import(accountId: string, input: OperationInput) {
        const account = await this.db.getRepository(ChannelAccount).findOneByOrFail({ id: accountId });
        if (!account.ownershipEnabled || !account.externalId)
            throw new ConflictException('Connect and enable CRM ownership first.');
        const chat = crmJid(String(input.parameters.chat_jid));
        const limit = Number(input.body.limit ?? 100);
        const offset = Number(input.body.offset ?? 0);
        const page = await this.client.request<{
            data: StoredMessage[];
            pagination: {
                total: number;
            };
        }>('GET', `/chat/${encodeURIComponent(providerJid(chat))}/messages?limit=${limit}&offset=${offset}`, undefined, account.externalId);
        let inserted = 0;
        let duplicates = 0;
        for (const item of [...page.data].reverse()) {
            if (item.chat_jid === 'status@broadcast')
                continue;
            let context: Record<string, unknown> = {};
            try {
                context = JSON.parse(item.context_metadata ?? '{}') as Record<string, unknown>;
            }
            catch { /* Old provider rows may lack context metadata. */ }
            const type = item.media_type === 'text' || !item.media_type ? 'chat' : item.media_type;
            const normalized = this.adapter.normalizeInboundMessage(account, { data: { id: item.id, chatId: crmJid(item.chat_jid), from: crmJid(item.sender_jid), author: crmJid(item.sender_jid), isGroup: item.chat_jid.endsWith('@g.us'), fromMe: item.is_from_me, body: item.content, type, timestamp: item.timestamp, contact: { pushname: item.sender_display_name }, quotedMessage: context.replied_to_id ? { id: context.replied_to_id } : undefined, media: ['image', 'video', 'audio', 'document', 'sticker'].includes(type) ? { mimetype: type === 'document' ? 'application/octet-stream' : `${type}/${type === 'image' ? 'jpeg' : type === 'video' ? 'mp4' : 'ogg'}`, filename: item.filename } : undefined } });
            if (!normalized)
                continue;
            normalized.presentation = { imported: true, reactions: Object.fromEntries((item.reactions ?? []).map(r => [crmJid(r.sender_jid), r.emoji])) };
            const result = await this.locks.withLock(`conversation:${account.id}:${normalized.externalConversationId}`, 30000, () => this.messages.persist(account, normalized, null, { historical: true }), { onBusy: 'wait', waitTimeoutMs: 20000 });
            if (!result)
                throw new ConflictException('The conversation is busy. Retry the import.');
            if (result.duplicate)
                duplicates++;
            else {
                inserted++;
                if (result.message)
                    await this.messages.markProcessed(result.message.id, MessageProcessingStatus.PROCESSED);
            }
        }
        this.realtime.emitWhatsAppEvent('whatsapp.message.received', { channelAccountId: accountId, externalConversationId: chat });
        return { inserted, duplicates, total: page.pagination.total, nextOffset: offset + page.data.length, hasMore: offset + page.data.length < page.pagination.total };
    }
    async feed(accountId: string) { const rows = await this.db.query<Array<{
        id: string;
        eventType: string;
        createdAt: Date;
        rawPayload: Record<string, unknown>;
    }>>(`SELECT id,"eventType","createdAt","rawPayload" FROM provider_events WHERE "channelAccountId"=$1 AND ("eventType" IN ('newsletter.message','call.offer') OR "rawPayload"->'data'->>'isStatusBroadcast'='true') AND "createdAt">now()-interval '24 hours' AND "rawPayload" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 100`, [accountId]); return { items: rows.map(row => { const p = (row.rawPayload.providerPayload ?? {}) as Record<string, unknown>; return { id: row.id, event: row.eventType, receivedAt: row.createdAt, from: crmJid(p.from), name: p.sender_display_name ?? p.from_name, body: p.body ?? '', timestamp: p.timestamp, call: p.call_id ? { id: p.call_id, caller: p.caller_jid ?? p.from } : null, type: p.image ? 'image' : p.video ? 'video' : p.audio ? 'audio' : 'text' }; }) }; }
}
