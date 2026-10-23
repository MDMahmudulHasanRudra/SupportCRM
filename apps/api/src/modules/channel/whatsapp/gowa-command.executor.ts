import { BadRequestException,Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../../common/storage/storage.service';
import type { ChannelCommand } from '../channel-adapter.interface';
import { GoWaCatalogue, type OperationInput } from './gowa-catalogue';
import { GoWaClient } from './gowa.client';
import { SCHEDULE_FIELDS } from './gowa-scheduling';
import { providerJid, providerMessageId } from './gowa-identifiers';
@Injectable()
export class GoWaCommandExecutor {
    constructor(private readonly catalogue: GoWaCatalogue, private readonly client: GoWaClient, private readonly storage: StorageService,private readonly config:ConfigService) { }
    async execute(device: string, command: ChannelCommand, sendingOnly = false) {
        const op = this.catalogue.operation(command.name);
        const input = structuredClone(command.args) as unknown as OperationInput;
        if (sendingOnly && op.mode !== 'send')
            throw Error('Only send commands may use the outbound message worker.');
        if (this.catalogue.reason(op))
            throw Error(this.catalogue.reason(op)!);
        this.catalogue.validate(op, input);
        if (SCHEDULE_FIELDS.some(key => input.body[key] !== undefined))
            throw Error('Schedules must be dispatched by CRM.');
        for (const area of [input.body, input.parameters])
            for (const key of ['phone', 'group_id', 'chat_jid', 'to', 'participant'])
                if (typeof area[key] === 'string')
                    area[key] = providerJid(area[key] as string);
        for (const area of [input.body, input.parameters])
            for (const key of ['participants', 'mentions'])
                if (Array.isArray(area[key]))
                    area[key] = (area[key] as unknown[]).map(v => typeof v === 'string' ? providerJid(v) : v);
        if (typeof input.parameters.message_id === 'string')
            input.parameters.message_id = providerMessageId(input.parameters.message_id);
        if (typeof input.body.reply_message_id === 'string')
            input.body.reply_message_id = providerMessageId(input.body.reply_message_id);
        if(op.id==='sendLink'){
            let url:URL;try{url=new URL(String(input.body.link));}catch{throw new BadRequestException('Enter a valid link.');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new BadRequestException('Use an HTTP or HTTPS link without embedded credentials.');
            const allowed=this.config.get<string[]>('gowa.linkPreviewHosts',[]);if(url.protocol!=='https:'||!allowed.includes(url.hostname.toLowerCase()))return this.client.request<Record<string,unknown>>('POST','/send/message',{phone:input.body.phone,message:[input.body.caption,input.body.link].filter(Boolean).join('\n'),...(input.body.is_forwarded!==undefined?{is_forwarded:input.body.is_forwarded}:{}),...(input.body.duration!==undefined?{duration:input.body.duration}:{})},device);
        }
        let form: FormData | undefined;
        if (op.multipart) {
            form = new FormData();
            for (const [name, value] of Object.entries(input.body)) {
                if (command.files?.[name])
                    continue;
                if (Array.isArray(value))
                    for (const item of value)
                        form.append(name, String(item));
                else if (value !== undefined && value !== null)
                    form.append(name, String(value));
            }
            for (const [name, file] of Object.entries(command.files ?? {})) {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of this.storage.read(file.ref)) {
                    size += (chunk as Buffer).length;
                    if (size > 25 * 1024 * 1024)
                        throw Error('Upload exceeds 25 MiB.');
                    chunks.push(chunk as Buffer);
                }
                form.set(name, new Blob([Buffer.concat(chunks)], { type: file.mime }), file.name);
            }
        }
        return this.client.request<Record<string, unknown>>(op.method, this.catalogue.route(op, input).replaceAll('{device_id}', encodeURIComponent(device)), op.method === 'GET' ? undefined : input.body, device, form);
    }
}
