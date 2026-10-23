import { useCallback, useEffect, useState } from 'react';
import { Link,useSearchParams } from 'react-router-dom';
import { whatsappTools } from '../api/whatsapp-tools';
import { useAuth } from '../auth-context';
import { Empty, ErrorState, Loading, errorMessage } from '../components/ui';
import { MessageText } from '../components/message-text';
import { WhatsAppIcon } from '../components/whatsapp-icons';
import { WhatsAppChatTool } from '../components/whatsapp-chat';
import { WhatsAppResult } from './whatsapp-tools';
type Item = Record<string, unknown>;
function itemId(item: Item) { return String(item.jid ?? item.id ?? item.JID ?? item.ID ?? ''); }
function itemName(item: Item) { const metadata = (item.thread_metadata ?? item.ThreadMeta ?? {}) as {
    name?: {
        text?: string;
    };
    Name?: {
        Text?: string;
    };
}; return String(item.name ?? item.Name ?? metadata.name?.text ?? metadata.Name?.Text ?? itemId(item)); }
export function WhatsAppExplorePage({ accountId, channels = false }: {
    accountId: string;
    channels?: boolean;
}) {
    const { can } = useAuth();
    const [params]=useSearchParams();const requestedChat=params.get('chat');
    const [items, setItems] = useState<Item[] | null>(null);
    const [selected, setSelected] = useState<Item | null>(null);
    const [messages, setMessages] = useState<Item[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const [messageOffset, setMessageOffset] = useState(0);
    const [more, setMore] = useState(false);
    const [tool, setTool] = useState<string | null>(null);
    const [download, setDownload] = useState<unknown>();
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => { if (!accountId)
        return; try {
        const result = await whatsappTools.read(accountId, channels ? 'userMyNewsletter' : 'listChats', { parameters: channels ? {} : { limit: 50, offset, search }, body: {} }) as {
            data?: Item[];
            pagination?: {
                total: number;
            };
        } | Item[];
        const data = Array.isArray(result) ? result : result.data ?? [];
        setItems(data);
        setTotal(Array.isArray(result) ? result.length : result.pagination?.total ?? data.length);
        setError(null);
    }
    catch (e) {
        setError(errorMessage(e, 'Could not load the directory.'));
    } }, [accountId, channels, offset, search]);
    useEffect(() => { setItems(null); setSelected(null); setMessages(null); void load(); }, [load]);
    useEffect(()=>{if(!channels&&requestedChat){setSelected({jid:requestedChat,name:requestedChat});setMessageOffset(0);}},[requestedChat,channels,accountId]);
    useEffect(() => { setOffset(0); }, [accountId, search, channels]);
    useEffect(() => { if (!selected || !accountId)
        return; let live = true; setMessages(null); setDownload(undefined); void whatsappTools.read(accountId, channels ? 'getNewsletterMessages' : 'getChatMessages', { parameters: channels ? { newsletter_id: itemId(selected), count: 50, ...(messageOffset ? { before: messageOffset } : {}) } : { chat_jid: itemId(selected), limit: 50, offset: messageOffset }, body: {} }).then(p => { if (!live)
        return; const page = p as {
        data?: Item[];
        pagination?: {
            total: number;
        };
    }; setMessages(page.data ?? []); setMore((page.data?.length ?? 0) === 50); }).catch(e => { if (live)
        setError(errorMessage(e, 'Messages could not be loaded.')); }); return () => { live = false; }; }, [selected, accountId, channels, messageOffset]);
    async function media(message: Item) { if (!selected || busy)
        return; setBusy(true); try {
        setDownload(await whatsappTools.read(accountId, channels ? 'downloadNewsletterMessageMedia' : 'downloadMessageMedia', { parameters: channels ? { newsletter_id: itemId(selected), server_id: message.server_id } : { message_id: message.id, phone: itemId(selected) }, body: {} }));
    }
    catch (e) {
        setError(errorMessage(e, 'Media could not be retrieved.'));
    }
    finally {
        setBusy(false);
    } }
    return <div className={`wa-explore${selected ? ' has-selection' : ''}`}><aside><header><h1>{channels ? 'Channels' : 'WhatsApp chat history'}</h1><p>{channels ? 'Updates from channels you follow.' : 'Browse chats synchronized by your linked device.'}</p></header><div className="wa-search"><WhatsAppIcon name="search" size={18}/><input aria-label="Search directory" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)}/></div>{!accountId ? <Empty title="Choose an account"/> : items === null && !error ? <Loading /> : <div className="wa-explore-list">{(items ?? []).filter(i => !channels || itemName(i).toLowerCase().includes(search.toLowerCase())).map((item, i) => <button className={selected === item ? 'active' : ''} key={itemId(item) || i} onClick={() => { setSelected(item); setMessageOffset(0); setError(null); }}><span className="wa-directory-avatar"><WhatsAppIcon name={channels ? 'channels' : itemId(item).endsWith('@g.us') ? 'groups' : 'chat'}/></span><span><strong>{itemName(item)}</strong><small>{itemId(item)}</small></span></button>)}{items?.length === 0 && <Empty title={channels ? 'No followed channels' : 'No synchronized chats yet'} hint={channels ? 'Follow a channel on your phone, then refresh.' : 'After linking, WhatsApp may take time to synchronize history.'}/>}</div>}{!channels && <div className="row wa-directory-pager"><button disabled={!offset} onClick={() => setOffset(v => Math.max(0, v - 50))}>Previous</button><button disabled={offset + 50 >= total} onClick={() => setOffset(v => v + 50)}>Next</button></div>}<button className="wa-directory-refresh" onClick={() => void load()}>Refresh directory</button></aside><main>{error && <ErrorState message={error} onRetry={() => void load()}/>} {!selected ? <div className="wa-tools-welcome"><WhatsAppIcon name={channels ? 'channels' : 'chat'} size={60}/><h2>{channels ? 'WhatsApp Channels' : 'Your synced conversations'}</h2><p>{channels ? 'Select a channel to read its latest updates.' : 'Choose a chat to view provider history and import it into your support inbox.'}</p><Link to={`/whatsapp?account=${accountId}`}>Open inbox</Link></div> : <><header className="wa-explore-head"><button className="wa-explore-back" aria-label="Back to directory" onClick={() => setSelected(null)}><WhatsAppIcon name="back"/></button><div><strong>{itemName(selected)}</strong><small>{itemId(selected)}</small></div>{channels ? can('channels.manage') && <button onClick={() => setTool('unfollowNewsletter')}>Unfollow</button> : can('conversations.manage') && <button onClick={() => setTool('importChatHistory')}>Import into inbox</button>}</header><div className="wa-explore-messages">{messages === null ? <Loading /> : !messages.length ? <Empty title="No messages available"/> : messages.map((message, i) => <article className={`wa-explore-message${message.is_from_me ? ' outbound' : ''}`} key={String(message.id ?? message.server_id ?? i)}><strong>{String(message.sender_display_name ?? '')}</strong><MessageText body={String(message.text ?? message.content ?? '')}/>{!['text', 'conversation', '', undefined].includes((message.type ?? message.media_type) as string | undefined) && <button disabled={busy} onClick={() => void media(message)}>Open {String(message.type ?? message.media_type)} media</button>}<small>{String(message.timestamp ?? '')}{message.views_count !== undefined ? ` · ${message.views_count} views` : ''}</small></article>)}{download !== undefined && <div className="wa-tool-result"><WhatsAppResult value={download}/></div>}</div><footer><button disabled={!messageOffset} onClick={() => setMessageOffset(0)}>Latest</button><button disabled={!more || !messages?.length} onClick={() => setMessageOffset(channels ? Math.min(...(messages ?? []).map(m => Number(m.server_id))) : messageOffset + 50)}>Older messages</button></footer></>}{tool && selected && <WhatsAppChatTool accountId={accountId} operation={tool} phone={itemId(selected)} prefill={channels ? { 'body.newsletter_id': itemId(selected) } : { 'parameters.chat_jid': itemId(selected), 'body.limit': 100, 'body.offset': messageOffset }} onClose={() => setTool(null)} onQueued={() => undefined}/>}</main></div>;
}
