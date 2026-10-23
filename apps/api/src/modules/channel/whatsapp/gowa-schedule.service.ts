import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CryptoService } from '../../../common/crypto/crypto.service';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { User } from '../../auth/entities/user.entity';
import { ChannelAccount } from '../entities/channel-account.entity';
import { MessageService } from '../../messaging/message.service';
import { MessageContentType } from '../../messaging/message-types';
import type { ChannelCommand } from '../channel-adapter.interface';
import { GoWaCatalogue, type OperationInput } from './gowa-catalogue';
import { crmJid } from './gowa-identifiers';
import { nextScheduleRun, scheduleRule, SCHEDULE_FIELDS, type ScheduleRule } from './gowa-scheduling';
interface Schedule extends ScheduleRule {
    id: string;
    accountId: string;
    userId: string;
    operationId: string;
    fingerprint: string;
    encryptedCommand: string;
    nextRunAt: Date;
    runCount: number;
    status: string;
    lastError: string | null;
    createdAt: Date;
}
export function commandRecipient(command: ChannelCommand) { const body = command.args.body as Record<string, unknown>; const phone = body?.phone; if (typeof phone !== 'string' || !/^([0-9+(). -]{7,32}|[^\s@]{1,150}@(g\.us|c\.us|s\.whatsapp\.net|lid|broadcast))$/.test(phone))
    throw new BadRequestException('Enter a valid phone number or chat address.'); return crmJid(phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`); }
export function commandContent(command: ChannelCommand) { const body = command.args.body as Record<string, unknown>; const types: Record<string, MessageContentType> = { sendMessage: MessageContentType.TEXT, sendLink: MessageContentType.TEXT, sendImage: MessageContentType.IMAGE, sendVideo: MessageContentType.VIDEO, sendAudio: MessageContentType.AUDIO, sendFile: MessageContentType.DOCUMENT, sendSticker: MessageContentType.STICKER, sendLocation: MessageContentType.LOCATION, sendContact: MessageContentType.CONTACT }; return { body: String(body.message ?? body.caption ?? body.question ?? body.link ?? ''), contentType: types[command.name] ?? MessageContentType.UNSUPPORTED }; }
@Injectable()
export class GoWaScheduleService {
    constructor(private readonly db: DataSource, private readonly crypto: CryptoService, private readonly messages: MessageService, private readonly catalogue: GoWaCatalogue) { }
    async create(accountId: string, command: ChannelCommand, requestKey: string, fingerprint: string, user: AuthenticatedUser, fallback?: string) {
        const rule = scheduleRule(command.args.body as Record<string, unknown>, fallback);
        command = structuredClone(command);
        const body = command.args.body as Record<string, unknown>;
        for (const key of SCHEDULE_FIELDS)
            delete body[key];
        commandRecipient(command);
        const id = randomUUID();
        const encrypted = this.crypto.encryptSecret(JSON.stringify(command), `whatsapp-schedule:${id}`);
        await this.db.query(`INSERT INTO whatsapp_schedules(id,"accountId","userId","requestKey",fingerprint,"operationId","encryptedCommand",recurrence,timezone,weekdays,"dayOfMonth","endAt","occurrenceLimit","nextRunAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT("userId","accountId","requestKey") DO NOTHING`, [id, accountId, user.id, requestKey, fingerprint, command.name, encrypted, rule.recurrence, rule.timezone, JSON.stringify(rule.weekdays), rule.dayOfMonth, rule.endAt, rule.occurrenceLimit, rule.nextRunAt]);
        const [row] = await this.db.query<Schedule[]>('SELECT * FROM whatsapp_schedules WHERE "accountId"=$1 AND "userId"=$2 AND "requestKey"=$3', [accountId, user.id, requestKey]);
        if (row.fingerprint !== fingerprint)
            throw new ConflictException('This request key belongs to another schedule.');
        return { id: row.id, operationId: row.operationId, status: row.status, outboundId: null, jobId: null, result: { schedule_id: row.id, next_run_at: row.nextRunAt }, error: row.lastError, createdAt: row.createdAt };
    }
    private view(row: Schedule) { const command = JSON.parse(this.crypto.decryptSecret(row.encryptedCommand, `whatsapp-schedule:${row.id}`)) as ChannelCommand; return { schedule_id: row.id, message_type: row.operationId, recipient: commandRecipient(command), message: commandContent(command).body, status: row.status, next_run_at: row.nextRunAt, recurrence: row.recurrence, timezone: row.timezone, weekdays: row.weekdays, day_of_month: row.dayOfMonth, end_at: row.endAt, occurrence_limit: row.occurrenceLimit, run_count: row.runCount, last_error: row.lastError }; }
    async read(accountId: string, id: string, input: OperationInput, user: AuthenticatedUser) {
        if (id === 'listScheduledSends') {
            const p = input.parameters;
            const rows = await this.db.query<Schedule[]>('SELECT * FROM whatsapp_schedules WHERE "accountId"=$1 AND "userId"=$2 ORDER BY "nextRunAt" ASC LIMIT 1000', [accountId, user.id]);
            const filtered = rows.map(row => this.view(row)).filter(row => (!p.status || row.status === p.status) && (!p.message_type || row.message_type.toLowerCase().includes(String(p.message_type))) && (!p.search || `${row.recipient} ${row.message}`.toLowerCase().includes(String(p.search).toLowerCase())));
            const offset = Number(p.offset ?? 0);
            return { items: filtered.slice(offset, offset + Number(p.limit ?? 25)), total: filtered.length };
        }
        const row = await this.find(accountId, String(input.parameters.schedule_id), user);
        return this.view(row);
    }
    private async find(accountId: string, id: string, user: AuthenticatedUser) { if (!/^[0-9a-f-]{36}$/i.test(id))
        throw new BadRequestException('Use a CRM schedule ID.'); const [row] = await this.db.query<Schedule[]>('SELECT * FROM whatsapp_schedules WHERE id=$1 AND "accountId"=$2 AND "userId"=$3', [id, accountId, user.id]); if (!row)
        throw new NotFoundException('Schedule not found.'); return row; }
    async change(accountId: string, operation: string, input: OperationInput, user: AuthenticatedUser) { const row = await this.find(accountId, String(input.parameters.schedule_id), user); const target = operation === 'pauseScheduledSend' ? 'paused' : operation === 'resumeScheduledSend' ? 'active' : 'cancelled'; if (!['active', 'paused', 'failed'].includes(row.status))
        throw new ConflictException('This schedule has already finished.'); await this.db.query('UPDATE whatsapp_schedules SET status=$2,"updatedAt"=now(),"lastError"=NULL WHERE id=$1', [row.id, target]); return { id: row.id, operationId: operation, status: target, outboundId: null, jobId: null, result: { schedule_id: row.id, status: target }, error: null, createdAt: row.createdAt }; }
    async startDue() {
        // A no-key-update lock allows the outbound FK insert on a separate connection.
        // Hold the schedule claim through enqueue. A crash retries the identical occurrence key, never a new send.
        await this.db.transaction(async (tx) => {
            const rows = await tx.query<Schedule[]>(`SELECT * FROM whatsapp_schedules WHERE status='active' AND "nextRunAt"<=now() ORDER BY "nextRunAt" FOR NO KEY UPDATE SKIP LOCKED LIMIT 25`);
            for (const row of rows) {
                try {
                    const actor = await tx.getRepository(User).findOne({ where: { id: row.userId }, relations: { roles: { permissions: true } } });
                    if (!actor?.isActive)
                        throw new ForbiddenException('Schedule creator is no longer active.');
                    this.catalogue.assertPermission(this.catalogue.operation(row.operationId), { isSuperAdmin: actor.roles.some(r => r.isSuperAdmin), permissions: new Set(actor.roles.flatMap(r => r.permissions.map(p => p.key))) });
                    const account = await tx.getRepository(ChannelAccount).findOneBy({ id: row.accountId });
                    if (!account?.ownershipEnabled)
                        throw new ForbiddenException('CRM ownership is paused.');
                    if (account.status !== 'CONNECTED')
                        continue;
                    if (row.endAt && new Date(row.endAt) < new Date()) {
                        await tx.query("UPDATE whatsapp_schedules SET status='completed' WHERE id=$1", [row.id]);
                        continue;
                    }
                    const command = JSON.parse(this.crypto.decryptSecret(row.encryptedCommand, `whatsapp-schedule:${row.id}`)) as ChannelCommand;
                    const occurrence = createHash('sha256').update(`${row.id}:${new Date(row.nextRunAt).toISOString()}`).digest('hex');
                    await this.messages.send({ channelAccountId: row.accountId, externalConversationId: commandRecipient(command), channelCommand: command, managedScheduleId: row.id, ...commandContent(command), createdById: row.userId, idempotencyKey: `was-${occurrence}` });
                    let next = nextScheduleRun(new Date(row.nextRunAt), { ...row, endAt: row.endAt ? new Date(row.endAt) : null });
                    let skipped = 0;
                    while (next && +next < Date.now() && skipped++ < 370)
                        next = nextScheduleRun(next, { ...row, endAt: row.endAt ? new Date(row.endAt) : null });
                    const done = !next || row.occurrenceLimit !== null && row.runCount + 1 >= row.occurrenceLimit;
                    await tx.query('UPDATE whatsapp_schedules SET "runCount"="runCount"+1,"nextRunAt"=$2,status=$3,"lastError"=NULL,"updatedAt"=now() WHERE id=$1', [row.id, next ?? row.nextRunAt, done ? 'completed' : 'active']);
                }
                catch (error) {
                    await tx.query('UPDATE whatsapp_schedules SET status=$2,"lastError"=$3,"updatedAt"=now() WHERE id=$1', [row.id, 'failed', (error as Error).message.slice(0, 1000)]);
                }
            }
        });
    }
}
