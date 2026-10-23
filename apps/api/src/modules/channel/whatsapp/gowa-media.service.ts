import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { StorageService } from '../../../common/storage/storage.service';
import { GoWaClient } from './gowa.client';
import { GoWaCommandExecutor } from './gowa-command.executor';
import { ChannelAccount } from '../entities/channel-account.entity';
import { providerJid, providerMessageId } from './gowa-identifiers';
import type { AuthenticatedUser } from '../../auth/auth.service';
export function safeMime(bytes: Buffer, declared: string) { if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    return 'image/jpeg'; if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'; if (bytes.subarray(0, 6).toString().startsWith('GIF8'))
    return 'image/gif'; if (bytes.subarray(0, 4).toString() === 'OggS')
    return 'audio/ogg'; if (bytes.subarray(0, 4).toString() === '%PDF')
    return 'application/pdf'; if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp'; if (bytes.subarray(4, 8).toString() === 'ftyp')
    return declared.startsWith('audio/') ? 'audio/mp4' : 'video/mp4'; if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return declared.startsWith('audio/') ? 'audio/webm' : 'video/webm'; if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224)
    return 'audio/mpeg'; return 'application/octet-stream'; }
@Injectable()
export class GoWaMediaService {
    constructor(private readonly db: DataSource, private readonly storage: StorageService, private readonly client: GoWaClient, private readonly executor: GoWaCommandExecutor) { }
    async retain(accountId: string, user: AuthenticatedUser, result: Record<string, unknown>) {
        const source = result.file_url ?? result.file_path;
        if (typeof source !== 'string')
            throw new NotFoundException('No downloadable media was returned.');
        const path = source.startsWith('statics/') ? `/${source}` : source;
        const media = await this.client.staticMedia(path);
        const mime = safeMime(media.buffer, media.mime);
        const name = String(result.filename ?? 'whatsapp-media').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
        const stored = await this.storage.put(media.buffer, name);
        const id = randomUUID();
        try {
            await this.db.query('INSERT INTO whatsapp_uploads(id,"accountId","userId",ref,name,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, accountId, user.id, stored.ref, name, mime, media.buffer.length]);
        }
        catch (error) {
            await this.storage.delete(stored.ref);
            throw error;
        }
        return { id, name, mime, size: media.buffer.length, url: `/api/v1/channels/whatsapp/tools/accounts/${accountId}/files/${id}` };
    }
    async file(accountId: string, id: string, user: AuthenticatedUser) { const [file] = await this.db.query<Array<{
        ref: string;
        name: string;
        mime: string;
        userId: string;
    }>>('SELECT ref,name,mime,"userId" FROM whatsapp_uploads WHERE id=$1 AND "accountId"=$2', [id, accountId]); if (!file || file.userId !== user.id && !user.isSuperAdmin)
        throw new NotFoundException('Media not found.'); return this.stream(file); }
    private stream(file: {
        ref: string;
        name: string;
        mime: string;
    }) { if (!/^(image\/(png|jpeg|webp|gif)|audio\/(ogg|mpeg|mp4|webm)|video\/(mp4|webm))$/.test(file.mime))
        file = { ...file, mime: 'application/octet-stream' }; return new StreamableFile(this.storage.read(file.ref), { type: file.mime, disposition: `${/^(image|audio|video)\//.test(file.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}` }); }
    async event(accountId: string, id: string, user: AuthenticatedUser) {
        const [event] = await this.db.query<Array<{
            rawPayload: {
                providerPayload?: Record<string, unknown>;
            };
        }>>('SELECT "rawPayload" FROM provider_events WHERE id=$1 AND "channelAccountId"=$2 AND "createdAt">now()-interval \'24 hours\'', [id, accountId]);
        const payload = event?.rawPayload?.providerPayload;
        if (!payload || payload.chat_id !== 'status@broadcast' || typeof payload.id !== 'string' || payload.is_view_once || payload.view_once)
            throw new NotFoundException('This update media is unavailable.');
        const account = await this.db.getRepository(ChannelAccount).findOneBy({ id: accountId });
        if (!account?.externalId)
            throw new NotFoundException('The account is not linked.');
        const result = await this.executor.execute(account.externalId, { name: 'downloadMessageMedia', args: { parameters: { message_id: payload.id, phone: 'status@broadcast' }, body: {} } });
        const saved = await this.retain(accountId, user, result);
        return this.file(accountId, saved.id, user);
    }
    async message(accountId: string, id: string, user: AuthenticatedUser) {
        const [message] = await this.db.query<Array<{
            id: string;
            externalId: string;
            externalConversationId: string;
            presentation?: {
                viewOnce?: boolean;
            };
        }>>('SELECT id,"externalId","externalConversationId",presentation FROM messages WHERE id=$1 AND "channelAccountId"=$2', [id, accountId]);
        if (!message || message.presentation?.viewOnce)
            throw new NotFoundException('This message media is unavailable.');
        const [attachment] = await this.db.query<Array<{
            storageRef: string;
            filename: string;
            mimeType: string;
        }>>('SELECT "storageRef",filename,"mimeType" FROM message_attachments WHERE "messageId"=$1 AND "storageRef" IS NOT NULL LIMIT 1', [id]);
        if (attachment)
            return this.stream({ ref: attachment.storageRef, name: attachment.filename ?? 'media', mime: attachment.mimeType });
        const account = await this.db.getRepository(ChannelAccount).findOneBy({ id: accountId });
        if (!account?.externalId)
            throw new NotFoundException('Link the account to retrieve this media.');
        const result = await this.executor.execute(account.externalId, { name: 'downloadMessageMedia', args: { parameters: { message_id: providerMessageId(message.externalId), phone: providerJid(message.externalConversationId) }, body: {} } });
        const saved = await this.retain(accountId, user, result);
        const [file] = await this.db.query<Array<{
            ref: string;
            name: string;
            mime: string;
        }>>('SELECT ref,name,mime FROM whatsapp_uploads WHERE id=$1', [saved.id]);
        await this.db.query('INSERT INTO message_attachments(id,"messageId","mimeType",filename,"sizeBytes","omittedByProvider","storageRef") VALUES($1,$2,$3,$4,$5,false,$6)', [randomUUID(), id, file.mime, file.name, saved.size, file.ref]);
        return this.stream(file);
    }
}
