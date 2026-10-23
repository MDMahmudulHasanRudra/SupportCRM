import { useEffect, useRef, useState, type ReactNode } from 'react';
import { API_URL, type ConversationMessage } from '../api/client';
import { whatsappTools, type WhatsAppTool } from '../api/whatsapp-tools';
import { WhatsAppToolForm } from '../pages/whatsapp-tools';
import { MessageText } from './message-text';
import { ErrorState, Loading, errorMessage, humanise } from './ui';
import { WhatsAppIcon } from './whatsapp-icons';
export function WhatsAppDialog({ title, onClose, children }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open)
        dialog.showModal(); return () => dialog?.close(); }, []);
    return <dialog ref={ref} className="wa-chat-dialog" aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget)
        onClose(); }}><header><h2>{title}</h2><button aria-label="Close dialog" onClick={onClose}><WhatsAppIcon name="close"/></button></header>{children}</dialog>;
}
export function WhatsAppChatTool({ accountId, operation, phone, message, draft, prefill = {}, onClose, onQueued }: {
    accountId: string;
    operation: string;
    phone: string;
    message?: ConversationMessage;
    draft?: string;
    prefill?: Record<string, unknown>;
    onClose: () => void;
    onQueued: () => void;
}) {
    const [tool, setTool] = useState<WhatsAppTool | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { let live = true; void whatsappTools.catalogue().then(p => { if (live) {
        const found = p.operations.find(t => t.id === operation);
        if (found)
            setTool(found);
        else
            setError('This feature is not available.');
    } }).catch(e => { if (live)
        setError(e.message); }); return () => { live = false; }; }, [operation]);
    const body: Record<string, unknown> = { 'body.phone': phone, 'body.reply_message_id': message?.externalId ?? '', 'parameters.message_id': message?.externalId ?? '', 'parameters.phone': phone };
    if (operation === 'updateMessage')
        body['body.message'] = message?.body ?? '';
    else if (draft)
        body[operation === 'sendMessage' ? 'body.message' : 'body.caption'] = draft;
    return <WhatsAppDialog title={tool?.title ?? 'WhatsApp action'} onClose={onClose}>{error ? <ErrorState message={error}/> : tool ? <WhatsAppToolForm accountId={accountId} tool={tool} prefill={{ ...body, ...prefill }} onComplete={onQueued}/> : <Loading />}</WhatsAppDialog>;
}
export function WhatsAppMessageContent({ message, accountId }: {
    message: ConversationMessage;
    accountId: string;
}) {
    const [show, setShow] = useState(false);
    const p = message.presentation ?? {};
    const data = (p.details ?? {}) as Record<string, unknown>;
    const source = `${API_URL}/api/v1/channels/whatsapp/tools/accounts/${accountId}/messages/${message.id}/media`;
    if (p.revokedAt || p.deletedAt)
        return <div className="wa-deleted"><WhatsAppIcon name="close" size={15}/>{p.revokedAt ? 'This message was deleted' : 'Deleted from WhatsApp'}<details><summary>Support record</summary><MessageText body={message.body ?? ''}/></details></div>;
    const poll = p.poll as {
        question?: string;
        name?: string;
        options?: Array<string | {
            name?: string;
        }>;
    } | undefined;
    const location = (p.location ?? p.live_location) as {
        degreesLatitude?: number;
        degreesLongitude?: number;
        name?: string;
        address?: string;
    } | undefined;
    const lat = Number(location?.degreesLatitude ?? data.latitude);
    const lon = Number(location?.degreesLongitude ?? data.longitude);
    const contacts = p.contacts_array as Array<{
        displayName?: string;
        phone_number?: string;
    }> | undefined;
    const contact = p.contact as {
        displayName?: string;
        phone_number?: string;
    } | undefined;
    const text = typeof p.editedBody === 'string' ? p.editedBody : message.body ?? '';
    return <>{p.forwarded && <small className="wa-muted">↪ Forwarded</small>}
 {p.viewOnce ? <p className="wa-muted">View once media · Open on your phone</p> : ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER'].includes(message.contentType) && <div className="wa-message-media">{!show ? <button className="wa-media-load" onClick={() => setShow(true)}><WhatsAppIcon name={message.contentType === 'AUDIO' ? 'mic' : message.contentType === 'DOCUMENT' ? 'document' : 'image'}/>{message.contentType === 'AUDIO' ? 'Load voice message' : `Open ${humanise(message.contentType)}`}</button> : message.contentType === 'IMAGE' || message.contentType === 'STICKER' ? <a href={source} target="_blank" rel="noreferrer"><img src={source} loading="lazy" alt={message.body ?? 'Shared image'}/></a> : message.contentType === 'VIDEO' ? <video controls preload="metadata" src={source}/> : message.contentType === 'AUDIO' ? <audio controls preload="metadata" src={source}/> : <a href={source} target="_blank" rel="noreferrer">Download document</a>}</div>}
 {(poll || p.kind === 'sendPoll') && <div className="wa-poll-card"><strong><WhatsAppIcon name="poll" size={18}/>{poll?.question ?? poll?.name ?? String(data.question ?? 'Poll')}</strong>{(poll?.options ?? data.options as string[] ?? []).map((o, i) => <div key={i}><i />{typeof o === 'string' ? o : o.name}{p.pollVotes && <small>{Object.values(p.pollVotes).filter(v => v.includes(typeof o === 'string' ? o : o.name ?? '')).length} votes</small>}</div>)}<small>Votes received by this linked device.</small></div>}
 {(location || p.kind === 'sendLocation') && Number.isFinite(lat) && Number.isFinite(lon) && <a className="wa-location-card" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`} target="_blank" rel="noreferrer"><WhatsAppIcon name="channels" size={30}/><strong>{location?.name ?? 'Shared location'}</strong><small>{location?.address ?? `${lat}, ${lon}`}</small></a>}
 {(contacts ?? (contact ? [contact] : p.kind === 'sendContact' ? [{ displayName: String(data.contact_name ?? ''), phone_number: String(data.contact_phone ?? '') }] : [])).map((person, i) => <div key={i} className="wa-contact-card"><WhatsAppIcon name="account" size={28}/><span><strong>{person.displayName ?? 'Contact'}</strong><small>{person.phone_number}</small></span></div>)}
 {text && <MessageText body={text}/>} {!text && !['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'TEXT', 'LOCATION', 'CONTACT'].includes(message.contentType) && !poll && !p.kind && <span className="wa-muted">{humanise(message.contentType)} · View on your phone</span>}
 {p.editedAt && <small className="wa-edited">edited</small>}{p.starred && <span aria-label="Starred message">★</span>}{p.reactions && Object.keys(p.reactions).length > 0 && <div className="wa-message-reactions">{Object.entries(Object.values(p.reactions).reduce<Record<string, number>>((counts, emoji) => ({ ...counts, [emoji]: (counts[emoji] ?? 0) + 1 }), {})).map(([emoji, count]) => <span key={emoji}>{emoji}{count > 1 ? ` ${count}` : ''}</span>)}</div>}</>;
}
const shares = [['sendImage', 'image', 'Photos'], ['sendVideo', 'image', 'Videos'], ['sendFile', 'document', 'Documents'], ['sendAudio', 'mic', 'Audio'], ['sendSticker', 'smile', 'Stickers'], ['sendContact', 'account', 'Contact'], ['sendLocation', 'channels', 'Location'], ['sendPoll', 'poll', 'Poll'], ['sendMessage', 'clock', 'Schedule message']] as const;
export function WhatsAppComposerExtras({ disabled, onTool, onEmoji, accountId, phone, onQueued }: {
    disabled: boolean;
    onTool: (name: string) => void;
    onEmoji: (emoji: string) => void;
    accountId: string;
    phone: string;
    onQueued: () => void;
}) {
    const [emoji, setEmoji] = useState(false);
    const [voice, setVoice] = useState(false);
    return <><details className="wa-share-menu"><summary aria-label="Attach or share" aria-disabled={disabled}><WhatsAppIcon name="plus"/></summary><div>{shares.map(([id, icon, label]) => <button key={id} type="button" disabled={disabled} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); onTool(id); }}><WhatsAppIcon name={icon}/>{label}</button>)}<button disabled={disabled} type="button" onClick={() => setVoice(true)}><WhatsAppIcon name="mic"/>Record voice note</button></div></details><div className="wa-emoji-wrap"><button type="button" disabled={disabled} aria-label="Choose emoji" aria-expanded={emoji} onClick={() => setEmoji(v => !v)}><WhatsAppIcon name="smile"/></button>{emoji && <div className="wa-emoji-grid">{['😀', '😊', '😂', '❤️', '👍', '🙏', '🎉', '✅', '👋', '🤝', '💡', '📌', '⭐', '🔥', '💯', '😢', '🤔', '🚀', '📞', '💬', '🌹', '🙌', '😍', '👌'].map(item => <button key={item} type="button" aria-label={`Insert ${item}`} onClick={() => { onEmoji(item); setEmoji(false); }}>{item}</button>)}</div>}</div><button type="button" disabled={disabled} aria-label="Record voice note" onClick={() => setVoice(true)}><WhatsAppIcon name="mic"/></button>{voice && <WhatsAppVoiceNote accountId={accountId} phone={phone} onClose={() => setVoice(false)} onQueued={onQueued}/>}</>;
}
function WhatsAppVoiceNote({ accountId, phone, onClose, onQueued }: {
    accountId: string;
    phone: string;
    onClose: () => void;
    onQueued: () => void;
}) {
    const recorder = useRef<MediaRecorder | null>(null);
    const stream = useRef<MediaStream | null>(null);
    const chunks = useRef<BlobPart[]>([]);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const alive = useRef(true);
    const key = useRef(crypto.randomUUID());
    const [recording, setRecording] = useState(false);
    const [audio, setAudio] = useState<Blob | null>(null);
    const [url, setUrl] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current)
        clearTimeout(timer.current); if (recorder.current?.state === 'recording')
        recorder.current.stop(); stream.current?.getTracks().forEach(t => t.stop()); }; }, []);
    useEffect(() => { if (!audio)
        return; const object = URL.createObjectURL(audio); setUrl(object); return () => URL.revokeObjectURL(object); }, [audio]);
    async function start() { try {
        if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined')
            throw Error('Voice recording requires a supported browser on localhost or HTTPS.');
        const tracks = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!alive.current) {
            tracks.getTracks().forEach(t => t.stop());
            return;
        }
        stream.current = tracks;
        const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
        const rec = new MediaRecorder(tracks, mime ? { mimeType: mime } : undefined);
        recorder.current = rec;
        chunks.current = [];
        setAudio(null);
        setError(null);
        rec.ondataavailable = e => { if (e.data.size)
            chunks.current.push(e.data); };
        rec.onstop = () => { tracks.getTracks().forEach(t => t.stop()); if (timer.current)
            clearTimeout(timer.current); if (alive.current) {
            setAudio(new Blob(chunks.current, { type: rec.mimeType }));
            setRecording(false);
            key.current = crypto.randomUUID();
        } };
        rec.start();
        setRecording(true);
        timer.current = setTimeout(() => { if (rec.state === 'recording')
            rec.stop(); }, 120000);
    }
    catch (e) {
        setError(errorMessage(e, 'Microphone is unavailable.'));
    } }
    async function send() { if (!audio || busyRef.current)
        return; busyRef.current = true; setBusy(true); try {
        const ext = audio.type.includes('ogg') ? 'ogg' : audio.type.includes('mp4') ? 'm4a' : 'webm';
        const file = await whatsappTools.upload(accountId, new File([audio], `voice-note.${ext}`, { type: audio.type.split(';')[0] }));
        await whatsappTools.submit(accountId, 'sendAudio', { requestKey: key.current, confirmed: true, parameters: {}, body: { phone, ptt: true, audio: file.id }, files: { audio: file.id } });
        onQueued();
        onClose();
    }
    catch (e) {
        if (alive.current)
            setError(errorMessage(e, 'Voice note could not be queued.'));
    }
    finally {
        busyRef.current = false;
        if (alive.current)
            setBusy(false);
    } }
    return <WhatsAppDialog title="Voice message" onClose={onClose}><div className="wa-tool-form"><p>To {phone} · Up to 2 minutes</p>{recording ? <div className="wa-recording" role="status">● Recording… <button onClick={() => recorder.current?.stop()}>Stop recording</button></div> : <button disabled={busy} onClick={() => void start()}><WhatsAppIcon name="mic"/>{audio ? 'Record again' : 'Start recording'}</button>}{audio && <><audio controls src={url}/><button className="wa-primary" disabled={busy} onClick={() => void send()}>{busy ? 'Queueing…' : 'Send voice message'}</button></>}{error && <ErrorState message={error}/>}</div></WhatsAppDialog>;
}
