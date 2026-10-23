import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GatewayError } from './gateway-error';
import { providerJid, providerMessageId } from './gowa-identifiers';
import type { OpenWaGroupDetail, OpenWaGroupSummary, OpenWaQrResponse, OpenWaSendResult, OpenWaSession, OpenWaWebhook } from './openwa.contracts';
interface Device {
    id: string;
    display_name?: string;
    phone_number?: string;
    jid?: string;
    state: string;
}
interface DeviceStatus {
    is_connected: boolean;
    is_logged_in: boolean;
}
interface Qr {
    qr_link: string;
    qr_duration: number;
}
type Json = Record<string, unknown>;
export class GoWaError extends GatewayError {
    constructor(status: number, path: string, detail: string) { super(status, path, detail); this.name = 'GoWaError'; this.message = detail; }
}
/** Wire transport for upstream v9.6.0. Legacy-named result interfaces are internal normalization shapes. */
@Injectable()
export class GoWaClient {
    private readonly base: URL;
    private readonly authorization: string;
    private readonly qr = new Map<string, {
        value: string;
        expires: number;
    }>();
    private readonly groups = new Map<string, {
        items: OpenWaGroupSummary[];
        expires: number;
    }>();
    readonly autonomousReplyDisabled: boolean;
    constructor(config: ConfigService) {
        this.base = new URL(config.getOrThrow<string>('gowa.baseUrl'));
        if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.hostname === '169.254.169.254' || this.base.hostname.endsWith('.metadata.internal'))
            throw new Error('Invalid GOWA_BASE_URL');
        const credentials = config.getOrThrow<string>('gowa.basicAuth');
        this.authorization = credentials ? `Basic ${Buffer.from(credentials).toString('base64')}` : '';
        this.autonomousReplyDisabled = config.get<boolean>('gowa.managedAutomationDisabled', false);
    }
    private headers(device?: string) {
        if (!this.authorization)
            throw new ServiceUnavailableException('WhatsApp service credentials are not configured.');
        return { Authorization: this.authorization, Accept: 'application/json', ...(device ? { 'X-Device-Id': device } : {}) };
    }
    async request<T = Json>(method: string, path: string, body?: unknown, device?: string, form?: FormData): Promise<T> {
        if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\'))
            throw new Error('Invalid upstream route');
        let response: Response;
        try {
            response = await fetch(`${this.base.href.replace(/\/$/, '')}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(60000), headers: { ...this.headers(device), ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
        }
        catch {
            throw new GoWaError(503, path, 'WhatsApp transport failed; the outcome of a write may be unknown. Inspect history before retrying.');
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new GoWaError(response.status, path, `WhatsApp service rejected the request (${response.status}).`);
        }
        if (response.status === 204)
            return undefined as T;
        const bytes = await this.bounded(response, 8 * 1024 * 1024);
        const text = bytes.toString('utf8');
        if (response.headers.get('content-type')?.includes('text/csv'))
            return { download: { name: 'whatsapp-participants.csv', mime: 'text/csv', text } } as T;
        try {
            const envelope = JSON.parse(text) as {
                code?: string;
                results?: T;
            };
            return (envelope.results === undefined ? envelope : envelope.results) as T;
        }
        catch {
            throw new GoWaError(502, path, 'WhatsApp service returned an invalid response.');
        }
    }
    private async bounded(response: Response, limit: number) { const chunks: Buffer[] = []; let size = 0; if (!response.body)
        return Buffer.alloc(0); const reader = response.body.getReader(); try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new GoWaError(502, 'response', 'WhatsApp response exceeds the allowed size.');
            }
            chunks.push(Buffer.from(value));
        }
    }
    finally {
        reader.releaseLock();
    } return Buffer.concat(chunks); }
    async staticMedia(location: string, limit = 25 * 1024 * 1024) {
        const url = new URL(location, this.base);
        if (url.origin !== this.base.origin || !url.pathname.startsWith(`${this.base.pathname.replace(/\/$/, '')}/statics/`) || url.search || url.hash)
            throw new GoWaError(502, 'media', 'Invalid WhatsApp media location.');
        const response = await fetch(url, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (!response.ok)
            throw new GoWaError(response.status, 'media', 'WhatsApp media is unavailable.');
        return { buffer: await this.bounded(response, limit), mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' };
    }
    async listSessions(): Promise<OpenWaSession[]> { return Promise.all((await this.request<Device[]>('GET', '/devices') ?? []).map(d => this.session(d))); }
    private async session(d: Device): Promise<OpenWaSession> {
        const status = await this.request<DeviceStatus>('GET', `/devices/${encodeURIComponent(d.id)}/status`);
        return { id: d.id, name: d.id, status: status.is_connected && status.is_logged_in ? 'ready' : this.qr.has(d.id) ? 'qr_ready' : status.is_logged_in ? 'disconnected' : 'created', phone: status.is_logged_in ? (d.phone_number || d.jid || null) : null, pushName: d.display_name || null };
    }
    async getSession(id: string): Promise<OpenWaSession> { return this.session(await this.request<Device>('GET', `/devices/${encodeURIComponent(id)}`)); }
    async createSession(name: string): Promise<OpenWaSession> { const d = await this.request<Device>('POST', '/devices', { device_id: name }); return { id: d.id, name: d.id, status: 'created' }; }
    async startSession(id: string): Promise<OpenWaSession> {
        const state = await this.getSession(id);
        if (state.status === 'ready')
            return state;
        if (state.phone) {
            await this.request('POST', `/devices/${encodeURIComponent(id)}/reconnect`);
            return this.getSession(id);
        }
        await this.getQr(id);
        return { id, name: id, status: 'qr_ready' };
    }
    async stopSession(_id: string): Promise<OpenWaSession> { throw new ConflictException('This WhatsApp provider cannot disconnect while preserving pairing. Pause CRM ownership, or explicitly log out the device.'); }
    async logoutSession(id: string): Promise<OpenWaSession> { await this.request('POST', `/devices/${encodeURIComponent(id)}/logout`); this.qr.delete(id); return { id, name: id, status: 'disconnected' }; }
    async reconnectSession(id: string): Promise<OpenWaSession> { await this.request('POST', `/devices/${encodeURIComponent(id)}/reconnect`); return this.getSession(id); }
    async getQr(id: string): Promise<OpenWaQrResponse> {
        const state = await this.request<DeviceStatus>('GET', `/devices/${encodeURIComponent(id)}/status`);
        if (state.is_logged_in)
            return { qrCode: null, status: state.is_connected ? 'ready' : 'disconnected' };
        const cached = this.qr.get(id);
        if (cached && cached.expires > Date.now())
            return { qrCode: cached.value, status: 'qr_ready' };
        const qr = await this.request<Qr>('GET', `/devices/${encodeURIComponent(id)}/login`);
        const url = new URL(qr.qr_link, this.base);
        if (url.origin !== this.base.origin || !url.pathname.startsWith(`${this.base.pathname.replace(/\/$/, '')}/statics/`))
            throw new Error('Invalid pairing image location');
        const response = await fetch(url, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok || !/^image\/(png|jpeg)$/.test(response.headers.get('content-type')?.split(';')[0] ?? ''))
            throw new Error('Pairing image unavailable');
        const bytes = await this.bounded(response, 256 * 1024);
        const value = `data:${response.headers.get('content-type')!.split(';')[0]};base64,${bytes.toString('base64')}`;
        this.qr.set(id, { value, expires: Date.now() + Math.min(Math.max(qr.qr_duration, 1), 20) * 1000 });
        return { qrCode: value, status: 'qr_ready' };
    }
    async pairCode(id: string, phone: string) { return this.request<{
        pair_code: string;
    }>('POST', `/devices/${encodeURIComponent(id)}/login/code?phone=${encodeURIComponent(phone)}`); }
    async listGroups(id: string, limit: number, offset: number): Promise<OpenWaGroupSummary[]> {
        let cached = this.groups.get(id);
        if (offset === 0 || !cached || cached.expires < Date.now()) {
            const result = await this.request<{
                data: Json[];
            }>('GET', '/user/my/groups', undefined, id);
            cached = { items: (result.data ?? []).filter(g => typeof g.JID === 'string').map(g => ({ id: String(g.JID), name: String(g.Name ?? g.JID) })), expires: Date.now() + 60000 };
            this.groups.set(id, cached);
        }
        return cached.items.slice(offset, offset + limit);
    }
    async getGroup(id: string, group: string): Promise<OpenWaGroupDetail> {
        const g = await this.request<Json>('GET', `/group/info?group_id=${encodeURIComponent(group)}`, undefined, id);
        const people = await this.request<{
            participants: Array<{
                jid: string;
                phone_number: string;
                display_name?: string;
                is_admin: boolean;
                is_super_admin: boolean;
            }>;
        }>('GET', `/group/participants?group_id=${encodeURIComponent(group)}`, undefined, id);
        return { id: String(g.JID ?? group), name: String(g.Name ?? group), description: String(g.Topic ?? ''), owner: String(g.OwnerJID ?? ''), isAnnounce: Boolean(g.IsAnnounce), participants: (people.participants ?? []).map(p => ({ id: p.jid, number: p.phone_number, name: p.display_name, isAdmin: p.is_admin, isSuperAdmin: p.is_super_admin })) };
    }
    private async sent(id: string, path: string, payload: Json): Promise<OpenWaSendResult> {
        const result = await this.request<{
            message_id?: string;
            status: string;
        }>('POST', path, payload, id);
        if (!result.message_id)
            throw new GoWaError(502, path, 'Message outcome is unknown: no provider message ID was returned. Inspect history before retrying.');
        return { messageId: result.message_id, timestamp: Math.floor(Date.now() / 1000) };
    }
    sendText(id: string, p: {
        chatId: string;
        text: string;
        quotedMessageId?: string;
        mentions?: string[];
    }) { return this.sent(id, '/send/message', { phone: providerJid(p.chatId), message: p.text, reply_message_id: providerMessageId(p.quotedMessageId), mentions: p.mentions?.map(providerJid) }); }
    reply(id: string, p: {
        chatId: string;
        text: string;
        quotedMessageId: string;
        mentions?: string[];
    }) { return this.sendText(id, p); }
    sendImage(id: string, p: {
        chatId: string;
        url?: string;
        caption?: string;
        quotedMessageId?: string;
    }) { return this.sent(id, '/send/image', { phone: providerJid(p.chatId), image_url: p.url, caption: p.caption, reply_message_id: providerMessageId(p.quotedMessageId) }); }
    sendDocument(id: string, p: {
        chatId: string;
        url?: string;
        caption?: string;
        filename?: string;
        quotedMessageId?: string;
    }) { return this.sent(id, '/send/file', { phone: providerJid(p.chatId), file_url: p.url, caption: p.caption, reply_message_id: providerMessageId(p.quotedMessageId) }); }
    async createWebhook(id: string, p: {
        url: string;
        events: string[];
        secret: string;
        retryCount?: number;
    }): Promise<OpenWaWebhook> {
        await this.request('PATCH', `/devices/${encodeURIComponent(id)}/webhook`, { webhook_url: p.url, webhook_secret: p.secret, webhook_events: '' });
        return { id: `gowa-${id}`, sessionId: id, url: p.url, events: p.events, active: true, retryCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    async deleteWebhook(id: string, _webhookId: string): Promise<void> { await this.request('PATCH', `/devices/${encodeURIComponent(id)}/webhook`, { webhook_url: '' }); }
    async listAutomationRules(_id: string): Promise<Array<{
        id: string;
        name: string;
        enabled: boolean;
    }>> {
        if (!this.autonomousReplyDisabled)
            throw new ServiceUnavailableException('The managed gateway must declare autonomous replies disabled before CRM automation can run.');
        return [];
    }
}
