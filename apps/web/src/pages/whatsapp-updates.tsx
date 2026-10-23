import { useEffect, useState } from 'react';
import { API_URL } from '../api/client';
import { whatsappTools } from '../api/whatsapp-tools';
import { useAuth } from '../auth-context';
import { WhatsAppChatTool } from '../components/whatsapp-chat';
import { WhatsAppIcon } from '../components/whatsapp-icons';
import { MessageText } from '../components/message-text';
import { Empty, ErrorState, Loading } from '../components/ui';
type Update = Awaited<ReturnType<typeof whatsappTools.feed>>['items'][number];
export function WhatsAppUpdatesPage({ accountId }: {
    accountId: string;
}) {
    const { can } = useAuth();
    const [rows, setRows] = useState<Update[] | null>(null);
    const [selected, setSelected] = useState<Update | null>(null);
    const [tool, setTool] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { setRows(null); setSelected(null); if (!accountId)
        return; let live = true; const load = () => void whatsappTools.feed(accountId).then(p => { if (live) {
        setRows(p.items);
        setError(null);
    } }).catch(e => { if (live)
        setError(e.message); }); load(); const timer = setInterval(() => { if (document.visibilityState === 'visible')
        load(); }, 30000); return () => { live = false; clearInterval(timer); }; }, [accountId]);
    const statuses = (rows ?? []).filter(r => !['call.offer', 'newsletter.message'].includes(r.event));
    const calls = (rows ?? []).filter(r => r.event === 'call.offer');
    const src = selected ? `${API_URL}/api/v1/channels/whatsapp/tools/accounts/${accountId}/events/${selected.id}/media` : '';
    return <div className="wa-updates"><aside><h1>Updates</h1><h2>Status</h2>{can('messages.send') && <div className="wa-my-status"><span className="wa-directory-avatar"><WhatsAppIcon name="plus"/></span><div><strong>My status</strong><small>Share an update with your contacts</small><div className="row"><button onClick={() => setTool('sendMessage')}>Text</button><button onClick={() => setTool('sendImage')}>Photo</button><button onClick={() => setTool('sendVideo')}>Video</button></div></div></div>}<h3>Recent updates</h3>{!accountId ? <Empty title="Select an account"/> : error ? <ErrorState message={error}/> : rows === null ? <Loading /> : !statuses.length ? <Empty title="No recent status updates" hint="Updates received by this linked device appear here for 24 hours."/> : statuses.map(row => <button key={row.id} className={selected?.id === row.id ? 'wa-status-row active' : 'wa-status-row'} onClick={() => setSelected(row)}><span className="wa-status-avatar">{(row.name ?? row.from ?? '?').slice(0, 1).toUpperCase()}</span><span><strong>{row.name ?? row.from}</strong><small>{new Date(row.timestamp ?? row.receivedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</small></span></button>)}{calls.length > 0 && <section className="wa-calls"><h3>Recent calls</h3>{calls.map(row => <div key={row.id}><strong>{row.name ?? row.from}</strong><small>{new Date(row.receivedAt).toLocaleString()}</small>{row.call && can('channels.manage') && <button onClick={() => { setSelected(row); setTool('rejectCall'); }}>Reject call</button>}</div>)}</section>}</aside><main>{selected && !selected.call ? <><header><strong>{selected.name ?? selected.from}</strong><button aria-label="Close update" onClick={() => setSelected(null)}><WhatsAppIcon name="close"/></button></header><div className="wa-status-view"><div className="wa-status-progress"/>{selected.type === 'image' ? <img src={src} alt="WhatsApp status"/> : selected.type === 'video' ? <video src={src} controls/> : selected.type === 'audio' ? <audio src={src} controls/> : null}{selected.body && <MessageText body={selected.body}/>}<small>{new Date(selected.timestamp ?? selected.receivedAt).toLocaleString()}</small></div></> : <div className="wa-tools-welcome"><WhatsAppIcon name="updates" size={65}/><h2>Stay connected</h2><p>Share a moment and see updates from your contacts.</p><small>Available updates depend on what WhatsApp delivers to this device.</small></div>}</main>{tool && (tool === 'rejectCall' ? selected?.call && <WhatsAppChatTool accountId={accountId} operation={tool} phone={selected.call.caller} prefill={{ 'body.caller_jid': selected.call.caller, 'body.call_id': selected.call.id }} onClose={() => setTool(null)} onQueued={() => undefined}/> : <WhatsAppChatTool accountId={accountId} operation={tool} phone="status@broadcast" onClose={() => setTool(null)} onQueued={() => undefined}/>)}</div>;
}
