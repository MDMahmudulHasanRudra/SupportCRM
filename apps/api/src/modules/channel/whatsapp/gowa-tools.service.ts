import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { StorageService } from '../../../common/storage/storage.service';
import { redact } from '../../../common/logging/redact';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { User } from '../../auth/entities/user.entity';
import { JobsService } from '../../jobs/jobs.service';
import { JobType } from '../../jobs/entities/job.entity';
import { QUEUES } from '../../jobs/queues';
import { MessageService } from '../../messaging/message.service';
import { DeliveryStatus } from '../../messaging/message-types';
import { OutboundMessage } from '../../messaging/entities/outbound-message.entity';
import { EMERGENCY_STOPS, SettingsService } from '../../settings/settings.service';
import { RateLimitService } from '../../../common/redis/rate-limit.service';
import { ChannelAccount } from '../entities/channel-account.entity';
import type { ChannelCommand } from '../channel-adapter.interface';
import { GoWaCatalogue, type OperationInput } from './gowa-catalogue';
import { GoWaCommandExecutor } from './gowa-command.executor';
import { GOWA_OPERATIONS } from './gowa-operations.generated';
import { GoWaScheduleService, commandRecipient, commandContent } from './gowa-schedule.service';
import { GoWaHistoryService } from './gowa-history.service';
import { GOWA_WORKSPACE_OPERATIONS } from './gowa-workspace.operations';
import { GoWaIntegrationService } from './gowa-integration.service';
import { GoWaMediaService, safeMime } from './gowa-media.service';
import { MessagePresentationService } from '../../messaging/message-presentation.service';
import { GoWaError } from './gowa.client';
import type { ToolUploadFile } from './gowa-operation.types';
interface OperationRow {
    id: string;
    accountId: string;
    userId: string;
    operationId: string;
    requestKey: string;
    fingerprint: string;
    encryptedInput: string;
    status: string;
    jobId: string | null;
    outboundId: string | null;
    result: Record<string, unknown> | null;
    error: string | null;
    createdAt: Date;
}
function canonical(value: unknown): string { if (value === undefined)
    return 'null'; if (value === null || typeof value !== 'object')
    return JSON.stringify(value); if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`; return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`; }
interface Submission extends OperationInput {
    requestKey: string;
    confirmed: boolean;
    files?: Record<string, string>;
    scheduledFor?: string;
}
@Injectable()
export class GoWaToolsService {
    constructor(private readonly db: DataSource, private readonly catalogue: GoWaCatalogue, private readonly commands: GoWaCommandExecutor, private readonly crypto: CryptoService, private readonly storage: StorageService, private readonly messages: MessageService, private readonly jobs: JobsService, private readonly settings: SettingsService, private readonly rate: RateLimitService, private readonly schedules: GoWaScheduleService, private readonly media: GoWaMediaService, private readonly presentation: MessagePresentationService, private readonly integration: GoWaIntegrationService, private readonly history: GoWaHistoryService, 
    @InjectQueue(QUEUES.MESSAGE_OUTGOING)
    private readonly outgoing: Queue, 
    @InjectQueue(QUEUES.JOB_CENTER)
    private readonly jobQueue: Queue) { }
    async account(id: string) { const a = await this.db.getRepository(ChannelAccount).findOneBy({ id }); if (!a || a.channelKey !== 'whatsapp')
        throw new NotFoundException('WhatsApp account not found.'); return a; }
    catalogueFor(user: AuthenticatedUser) { return { provider: 'Go WhatsApp', version: '9.6.0', operations: [...GOWA_OPERATIONS, ...GOWA_WORKSPACE_OPERATIONS].map(op => ({ id: op.id, title: op.title, category: op.category, mode: op.mode, multipart: op.multipart, parameters: op.parameters, body: op.body, permissions: this.catalogue.permissions(op), disabledReason: this.catalogue.reason(op) ?? (!user.isSuperAdmin && this.catalogue.permissions(op).some(p => !user.permissions.has(p)) ? 'Your role cannot use this tool.' : null) })) }; }
    private async ready(id: string, write: boolean) { const account = await this.account(id); if (write && !account.ownershipEnabled)
        throw new ConflictException('Enable CRM ownership before changing this account.'); if (!account.externalId)
        throw new ConflictException('Link this account first.'); if (account.status !== 'CONNECTED')
        throw new ConflictException('The WhatsApp account must be connected.'); return account; }
    private supported(id: string, user: AuthenticatedUser) { const op = this.catalogue.operation(id); this.catalogue.assertPermission(op, user); const reason = this.catalogue.reason(op); if (reason)
        throw new BadRequestException(reason); return op; }
    async read(accountId: string, id: string, input: OperationInput, user: AuthenticatedUser) { const op = this.supported(id, user); if (id.startsWith('chatwoot')) {
        await this.account(accountId);
        return this.integration.read(accountId, id, user);
    } if (op.mode === 'schedule' && op.method === 'GET') {
        this.catalogue.validate(op, input);
        return this.schedules.read(accountId, id, input, user);
    } if (op.mode !== 'read')
        throw new BadRequestException('This tool must be submitted as an audited action.'); this.catalogue.validate(op, input); const account = await this.ready(accountId, false); const result = await this.commands.execute(account.externalId!, { name: id, args: input as unknown as Record<string, unknown> }); return ['downloadMessageMedia', 'downloadNewsletterMessageMedia'].includes(id) ? this.media.retain(accountId, user, result) : result; }
    async upload(accountId: string, file: ToolUploadFile, user: AuthenticatedUser) {
        await this.account(accountId);
        if (!user.isSuperAdmin && !user.permissions.has('messages.send') && !user.permissions.has('channels.manage') && !user.permissions.has('groups.update'))
            throw new ForbiddenException('File upload is not permitted.');
        if (!file?.buffer?.length || file.size > 25 * 1024 * 1024)
            throw new BadRequestException('Choose a file between 1 byte and 25 MiB.');
        const name = file.originalname.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 255);
        const mime = safeMime(file.buffer, file.mimetype.slice(0, 128));
        if (mime === 'image/png' && !file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw new BadRequestException('Invalid PNG image.');
        if (mime === 'image/jpeg' && (file.buffer[0] !== 255 || file.buffer[1] !== 216))
            throw new BadRequestException('Invalid JPEG image.');
        const stored = await this.storage.put(file.buffer, name);
        const id = randomUUID();
        try {
            await this.db.query('INSERT INTO whatsapp_uploads (id,"accountId","userId",ref,name,mime,size) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, accountId, user.id, stored.ref, name, mime, file.size]);
        }
        catch (e) {
            await this.storage.delete(stored.ref);
            throw e;
        }
        return { id, name, mime, size: file.size };
    }
    async submit(accountId: string, id: string, input: Submission, user: AuthenticatedUser) {
        if (!isUUID(input.requestKey))
            throw new BadRequestException('A UUID request key is required.');
        const op = this.supported(id, user);
        if (!['send', 'action', 'schedule'].includes(op.mode))
            throw new BadRequestException('This is not an action tool.');
        if (input.confirmed !== true)
            throw new BadRequestException('Review and confirm the action before submitting.');
        this.catalogue.validate(op, { body: input.body, parameters: input.parameters });
        if (op.mode === 'schedule') {
            if (op.method === 'GET')
                throw new BadRequestException('Use the read endpoint.');
            return this.schedules.change(accountId, id, input, user);
        }
        await this.ready(accountId, true);
        const fingerprint = createHash('sha256').update(canonical({ id, body: input.body, parameters: input.parameters, files: input.files ?? {}, scheduledFor: input.scheduledFor ?? null })).digest('hex');
        const command: ChannelCommand = { name: id, args: { body: input.body, parameters: input.parameters }, files: {} };
        const properties = (op.body.properties ?? {}) as Record<string, {
            format?: string;
        }>;
        for (const [field, fileId] of Object.entries(input.files ?? {})) {
            if (typeof fileId !== 'string' || !(/^[0-9a-f-]{36}$/i).test(fileId))
                throw new BadRequestException('Invalid upload reference.');
            if (properties[field]?.format !== 'binary')
                throw new BadRequestException('Unexpected file field.');
            const [file] = await this.db.query<Array<{
                ref: string;
                name: string;
                mime: string;
            }>>('SELECT ref,name,mime FROM whatsapp_uploads WHERE id=$1 AND "userId"=$2 AND "accountId"=$3', [fileId, user.id, accountId]);
            if (!file)
                throw new BadRequestException('Upload belongs to a different account or user.');
            command.files![field] = file;
        }
        for (const [field, schema] of Object.entries(properties))
            if (schema.format === 'binary' && input.body[field] && !command.files?.[field])
                throw new BadRequestException('Choose an uploaded file, not a file path.');
        const requiredFile: Record<string, string> = { sendImage: 'image', sendVideo: 'video', sendAudio: 'audio', sendFile: 'file', sendSticker: 'sticker', userChangeAvatar: 'avatar', setGroupPhoto: 'photo' };
        if (requiredFile[id] && !command.files?.[requiredFile[id]])
            throw new BadRequestException('Upload a file for this action.');
        if (op.mode === 'send')
            commandRecipient(command);
        if (op.mode === 'send' && (input.scheduledFor || input.body.scheduled_at))
            return this.schedules.create(accountId, command, input.requestKey, fingerprint, user, input.scheduledFor);
        const proposed = randomUUID();
        const encrypted = this.crypto.encryptSecret(JSON.stringify({ command, scheduledFor: input.scheduledFor }), `whatsapp-operation:${proposed}`);
        await this.db.query(`INSERT INTO whatsapp_operations (id,"accountId","userId","operationId","requestKey",fingerprint,"encryptedInput") VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT ("userId","accountId","requestKey") DO NOTHING`, [proposed, accountId, user.id, id, input.requestKey, fingerprint, encrypted]);
        const [row] = await this.db.query<OperationRow[]>('SELECT * FROM whatsapp_operations WHERE "userId"=$1 AND "accountId"=$2 AND "requestKey"=$3', [user.id, accountId, input.requestKey]);
        if (row.fingerprint !== fingerprint)
            throw new ConflictException('This request key was already used for different content.');
        if (op.mode === 'send' && !row.outboundId) {
            const outbound = await this.messages.send({ channelAccountId: accountId, externalConversationId: commandRecipient(command), ...commandContent(command), channelCommand: command, idempotencyKey: `wa-${row.id}`, createdById: user.id });
            await this.db.query('UPDATE whatsapp_operations SET "outboundId"=$2,"updatedAt"=now() WHERE id=$1', [row.id, outbound.id]);
            if (outbound.status === DeliveryStatus.QUEUED)
                await this.outgoing.add('send', { outboundMessageId: outbound.id }, { jobId: `om-${outbound.id}`, delay: Math.max(0, (outbound.scheduledFor?.getTime() ?? 0) - Date.now()), attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
        }
        else if (op.mode === 'action' && !row.jobId) {
            const job = await this.jobs.create({ type: JobType.WHATSAPP_ACTION, name: op.title, payload: { accountId, operationId: id }, items: [{ reference: row.id, payload: { operationId: row.id } }], createdById: user.id, idempotencyKey: `wa-${row.id}` });
            await this.db.query('UPDATE whatsapp_operations SET "jobId"=$2,"updatedAt"=now() WHERE id=$1', [row.id, job.id]);
            await this.jobQueue.add(job.type, { jobId: job.id }, { jobId: job.id, attempts: 1 });
        }
        return this.get(accountId, row.id, user);
    }
    async get(accountId: string, id: string, user: AuthenticatedUser) { const [row] = await this.db.query<OperationRow[]>('SELECT * FROM whatsapp_operations WHERE id=$1 AND "accountId"=$2', [id, accountId]); if (!row || row.userId !== user.id && !user.isSuperAdmin)
        throw new NotFoundException('Action not found.'); const outbound = row.outboundId ? await this.db.getRepository(OutboundMessage).findOneBy({ id: row.outboundId }) : null; return { id: row.id, operationId: row.operationId, status: outbound?.status ?? row.status, jobId: row.jobId, outboundId: row.outboundId, result: row.result, error: outbound?.failureReason ?? row.error, createdAt: row.createdAt }; }
    async events(accountId: string, user: AuthenticatedUser) { await this.account(accountId); if (!user.isSuperAdmin && !user.permissions.has('messages.read'))
        throw new ForbiddenException('Message history permission is required.'); return { items: await this.db.query('SELECT id,"eventType",status,"createdAt" AS "receivedAt",error FROM provider_events WHERE "channelAccountId"=$1 ORDER BY "createdAt" DESC LIMIT 100', [accountId]) }; }
    async list(accountId: string, user: AuthenticatedUser) { await this.account(accountId); const rows = await this.db.query<Array<{
        id: string;
    }>>('SELECT id FROM whatsapp_operations WHERE "accountId"=$1 AND "userId"=$2 ORDER BY "createdAt" DESC LIMIT 50', [accountId, user.id]); return { items: await Promise.all(rows.map(r => this.get(accountId, r.id, user))) }; }
    async cancel(accountId: string, id: string, user: AuthenticatedUser) { const row = await this.get(accountId, id, user); if (row.outboundId)
        await this.messages.cancel(row.outboundId);
    else {
        const changed = await this.db.query<Array<{
            id: string;
        }>>("UPDATE whatsapp_operations SET status='CANCELLED',\"updatedAt\"=now() WHERE id=$1 AND status='QUEUED' RETURNING id", [id]);
        if (!changed.length)
            throw new ConflictException('Only queued actions can be cancelled.');
    } return this.get(accountId, id, user); }
    async execute(id: string) {
        const [row] = await this.db.query<OperationRow[]>('SELECT * FROM whatsapp_operations WHERE id=$1', [id]);
        if (!row)
            throw new NotFoundException('Action not found.');
        if (['COMPLETED', 'CANCELLED'].includes(row.status))
            return { status: row.status };
        if (['FAILED', 'UNKNOWN'].includes(row.status))
            return { status: row.status };
        if (row.status !== 'QUEUED')
            throw new ConflictException('The previous outcome may be uncertain. Inspect WhatsApp history before creating another action.');
        const op = this.catalogue.operation(row.operationId);
        if (op.mode !== 'action')
            throw new BadRequestException('Messages use the outbound message worker.');
        try {
            await this.preflight(row);
        }
        catch (error) {
            await this.db.query("UPDATE whatsapp_operations SET status='FAILED',error=$2,\"updatedAt\"=now() WHERE id=$1 AND status='QUEUED'", [id, (error as Error).message.slice(0, 1000)]);
            throw error;
        }
        const account = await this.ready(row.accountId, true);
        const [claimed] = await this.db.query<Array<{
            id: string;
        }>>("UPDATE whatsapp_operations SET status='RUNNING',\"updatedAt\"=now() WHERE id=$1 AND status='QUEUED' RETURNING id", [id]);
        if (!claimed)
            return { status: 'NOT_CLAIMED' };
        const payload = JSON.parse(this.crypto.decryptSecret(row.encryptedInput, `whatsapp-operation:${id}`)) as {
            command: ChannelCommand;
        };
        try {
            const result = redact(row.operationId === 'importChatHistory' ? await this.history.import(row.accountId, payload.command.args as unknown as OperationInput) : row.operationId.startsWith('chatwoot') ? await this.integration.execute(row.accountId, row.operationId, payload.command.args as unknown as OperationInput, await this.integration.actor(row.userId)) : await this.commands.execute(account.externalId!, payload.command)) as Record<string, unknown>;
            await this.applyLocal(row.accountId, payload.command);
            await this.db.query("UPDATE whatsapp_operations SET status='COMPLETED',result=$2,\"updatedAt\"=now() WHERE id=$1", [id, result ?? null]);
            return { status: 'COMPLETED', operationId: row.operationId };
        }
        catch (error) {
            const status = error instanceof GoWaError && error.status >= 400 && error.status < 500 ? 'FAILED' : 'UNKNOWN';
            await this.db.query('UPDATE whatsapp_operations SET status=$2,error=$3,"updatedAt"=now() WHERE id=$1', [id, status, (error as Error).message.slice(0, 1000)]);
            throw error;
        }
    }
    private async applyLocal(accountId: string, command: ChannelCommand) { const kinds: Record<string, 'edit' | 'revoke' | 'delete' | 'reaction' | 'star'> = { updateMessage: 'edit', revokeMessage: 'revoke', deleteMessage: 'delete', reactMessage: 'reaction', starMessage: 'star', unstarMessage: 'star' }; const kind = kinds[command.name]; if (!kind)
        return; const input = command.args as unknown as OperationInput; await this.presentation.apply(accountId, { externalId: String(input.parameters.message_id), conversation: commandRecipient(command), at: new Date().toISOString(), kind, body: String(input.body.message ?? ''), actor: 'self', emoji: String(input.body.emoji ?? ''), starred: command.name === 'starMessage' }); }
    private async preflight(row: OperationRow) {
        const op = this.catalogue.operation(row.operationId);
        const actor = await this.db.getRepository(User).findOne({ where: { id: row.userId }, relations: { roles: { permissions: true } } });
        if (!actor?.isActive)
            throw new ForbiddenException('The action creator is no longer active.');
        this.catalogue.assertPermission(op, { isSuperAdmin: actor.roles.some(r => r.isSuperAdmin), permissions: new Set(actor.roles.flatMap(r => r.permissions.map(p => p.key))) });
        const account = await this.ready(row.accountId, true);
        if (await this.settings.isStopped(EMERGENCY_STOPS.OUTGOING_MESSAGES_STOPPED))
            throw new ConflictException('Outgoing actions are stopped by the emergency control.');
        const limit = await this.settings.get<number>('channel.rate_limit.account_per_minute', 20);
        if (!(await this.rate.consume(`account:${account.id}`, limit, 60000)).allowed)
            throw new ConflictException('Account rate limit reached.');
    }
    async syncIntegrations() { await this.integration.sweep(); return { processed: true }; }
    async sweep() { await this.db.query("UPDATE whatsapp_operations SET status='UNKNOWN',error='Worker stopped before the outcome was recorded. Inspect WhatsApp before retrying.',\"updatedAt\"=now() WHERE status='RUNNING' AND \"updatedAt\"<now()-interval '10 minutes'"); await this.schedules.startDue(); const [enabled] = await this.db.query('SELECT 1 FROM whatsapp_integrations WHERE enabled=true LIMIT 1'); if (enabled) {
        const job = await this.jobs.create({ type: JobType.WHATSAPP_INTEGRATION_SYNC, name: 'WhatsApp integration delivery', idempotencyKey: `wa-integration-${Math.floor(Date.now() / 60000)}`, items: [{ reference: 'sync' }] });
        await this.jobQueue.add(job.type, { jobId: job.id }, { jobId: job.id, attempts: 1 });
    } }
}
