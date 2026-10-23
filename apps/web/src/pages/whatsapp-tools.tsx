import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API_URL } from '../api/client';
import { whatsappTools, type ToolSchema, type WhatsAppAction, type WhatsAppTool } from '../api/whatsapp-tools';
import { Empty, ErrorState, Loading, errorMessage, humanise, useToast } from '../components/ui';
import { WhatsAppIcon } from '../components/whatsapp-icons';
export const WA_TOOL_GROUPS = [['all', 'All tools', 'tools'], ['send', 'Send & share', 'send'], ['message', 'Message actions', 'chat'], ['chat', 'Chat settings', 'settings'], ['group', 'Groups', 'groups'], ['user', 'Contacts & profile', 'account'], ['newsletter', 'Channels', 'channels'], ['schedule', 'Scheduled messages', 'clock'], ['chatwoot', 'Integrations', 'tools']] as const;
const scheduledFields = new Set(['scheduled_at', 'recurrence', 'timezone', 'weekdays', 'day_of_month', 'end_at', 'occurrence_limit']);
function title(key: string) { return ({ phone: 'Phone number or chat', reply_message_id: 'Reply to message', message_id: 'Message', chat_jid: 'Chat address', group_id: 'Group', image: 'Photo', video: 'Video', file: 'Document', audio: 'Audio', mentions: 'Mention people', is_forwarded: 'Mark as forwarded', view_once: 'View once', hd: 'HD quality', compress: 'Compress media', allow_reshare: 'Allow status resharing' } as Record<string, string>)[key] ?? humanise(key); }
function convert(value: string | boolean | undefined, schema: ToolSchema): unknown {
    if (value === undefined || value === '')
        return undefined;
    if (schema.type === 'boolean')
        return value === true;
    if (schema.type === 'integer' || schema.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n))
            throw Error('Enter a valid number.');
        return n;
    }
    if (schema.type === 'array') {
        if (schema.items?.type === 'object' || String(value).trim().startsWith('['))
            return JSON.parse(String(value));
        return String(value).split(/\n|,/).map(s => s.trim()).filter(Boolean).map(v => schema.items?.type === 'integer' ? Number(v) : v);
    }
    if (schema.type === 'object')
        return JSON.parse(String(value));
    return value;
}
export function WhatsAppResult({ value }: {
    value: unknown;
}) {
    if (value === undefined || value === null)
        return <div className="wa-result-empty">The request completed.</div>;
    if (typeof value !== 'object')
        return <p className="wa-result-value">{String(value)}</p>;
    if (Array.isArray(value)) {
        if (!value.length)
            return <div className="wa-result-empty">No items found.</div>;
        if (value.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
            const keys = [...new Set(value.flatMap(row => Object.keys(row)))].slice(0, 12);
            return <div className="wa-result-table"><table><thead><tr>{keys.map(k => <th key={k}>{title(k)}</th>)}</tr></thead><tbody>{value.map((row, i) => <tr key={i}>{keys.map(k => <td key={k}>{typeof row[k] === 'object' ? <details><summary>View details</summary><WhatsAppResult value={row[k]}/></details> : String(row[k] ?? '—')}</td>)}</tr>)}</tbody></table></div>;
        }
        return <div className="wa-result-list">{value.map((item, i) => <WhatsAppResult key={i} value={item}/>)}</div>;
    }
    const data = value as Record<string, unknown>;
    if (typeof data.url === 'string' && data.url.startsWith('/api/v1/channels/whatsapp/'))
        return <a href={`${API_URL}${data.url}`} target="_blank" rel="noreferrer">Open {String(data.name ?? 'media')}</a>;
    if (data.download && typeof data.download === 'object') {
        const file = data.download as {
            text: string;
            mime: string;
            name: string;
        };
        return <button onClick={() => { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([file.text], { type: file.mime })); a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download {file.name}</button>;
    }
    return <div className="wa-result-details">{Object.entries(data).map(([key, item]) => <section key={key}><h4>{title(key)}</h4><WhatsAppResult value={item}/></section>)}</div>;
}
export function WhatsAppToolForm({ accountId, tool, prefill = {}, onComplete }: {
    accountId: string;
    tool: WhatsAppTool;
    prefill?: Record<string, unknown>;
    onComplete?: (action: WhatsAppAction) => void;
}) {
    const toast = useToast();
    const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(Object.entries(prefill).map(([k, v]) => [k, typeof v === 'boolean' ? v : Array.isArray(v) ? v.join('\n') : String(v)])));
    const [files, setFiles] = useState<Record<string, string>>({});
    const [uploading, setUploading] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [schedule, setSchedule] = useState('');
    const [recurrence, setRecurrence] = useState('once');
    const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
    const [weekdays, setWeekdays] = useState<number[]>([]);
    const [monthday, setMonthday] = useState(1);
    const [endAt, setEndAt] = useState('');
    const [limit, setLimit] = useState('');
    const [failure, setFailure] = useState<string | null>(null);
    const [result, setResult] = useState<unknown>();
    const [action, setAction] = useState<WhatsAppAction | null>(null);
    const key = useRef(crypto.randomUUID());
    const lock = useRef(false);
    const alive = useRef(true);
    const dirty = () => { key.current = crypto.randomUUID(); setAction(null); setConfirmed(false); };
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const change = (name: string, value: string | boolean) => { setValues(current => ({ ...current, [name]: value })); dirty(); };
    const fields = [...tool.parameters.map(p => ({ ...p.schema, key: `parameters.${p.name}`, name: p.name, isRequired: p.required, description: p.description })), ...Object.entries(tool.body.properties ?? {}).filter(([name]) => !scheduledFields.has(name) && !['image_url', 'audio_url', 'video_url', 'file_url', 'sticker_url'].includes(name)).map(([name, s]) => ({ ...s, key: `body.${name}`, name, isRequired: tool.body.required?.includes(name) ?? false }))];
    async function upload(name: string, file?: File) { if (!file)
        return; if (file.size > 25 * 1024 * 1024) {
        setFailure('Choose a file smaller than 25 MiB.');
        return;
    } setUploading(name); setFailure(null); try {
        const stored = await whatsappTools.upload(accountId, file);
        if (!alive.current)
            return;
        setFiles(current => ({ ...current, [name]: stored.id }));
        setValues(current => ({ ...current, [`body.${name}`]: stored.id }));
        dirty();
    }
    catch (e) {
        if (alive.current)
            setFailure(errorMessage(e, 'Upload failed.'));
    }
    finally {
        if (alive.current)
            setUploading(null);
    } }
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (lock.current)
            return;
        lock.current = true;
        setPending(true);
        setFailure(null);
        try {
            const parameters: Record<string, unknown> = {};
            const body: Record<string, unknown> = {};
            for (const field of fields) {
                const value = convert(values[field.key] ?? (field.isRequired && field.type === 'boolean' ? false : undefined), field);
                if (value !== undefined)
                    (field.key.startsWith('body.') ? body : parameters)[field.name] = value;
            }
            if (tool.mode === 'read' || ['listScheduledSends', 'getScheduledSend'].includes(tool.id)) {
                setResult(await whatsappTools.read(accountId, tool.id, { parameters, body }));
            }
            else {
                if (schedule) {
                    body.scheduled_at = new Date(schedule).toISOString();
                    body.timezone = timezone;
                    body.recurrence = recurrence;
                    if (recurrence === 'weekly')
                        body.weekdays = weekdays;
                    if (recurrence === 'monthly')
                        body.day_of_month = monthday;
                    if (endAt)
                        body.end_at = new Date(endAt).toISOString();
                    if (limit)
                        body.occurrence_limit = Number(limit);
                }
                const response = await whatsappTools.submit(accountId, tool.id, { parameters, body, files, requestKey: key.current, confirmed, scheduledFor: schedule ? new Date(schedule).toISOString() : undefined });
                if (!alive.current)
                    return;
                setAction(response);
                onComplete?.(response);
                toast.success(schedule ? 'Message scheduled.' : 'Action queued.');
            }
        }
        catch (e) {
            if (alive.current)
                setFailure(errorMessage(e, 'The action could not be submitted.'));
        }
        finally {
            lock.current = false;
            if (alive.current)
                setPending(false);
        }
    }
    useEffect(() => { if (!action || !['QUEUED', 'RUNNING', 'SENDING', 'PROCESSING'].includes(action.status))
        return; let active = true; const timer = setInterval(() => { if (document.visibilityState !== 'visible')
        return; void whatsappTools.action(accountId, action.id).then(row => { if (active) {
        setAction(row);
        if (row.result)
            setResult(row.result);
    } }).catch(() => undefined); }, 2000); return () => { active = false; clearInterval(timer); }; }, [accountId, action]);
    const write = tool.mode !== 'read' && !(tool.mode === 'schedule' && ['listScheduledSends', 'getScheduledSend'].includes(tool.id));
    return <form className="wa-tool-form" onSubmit={e => void submit(e)}>
  <div className="wa-tool-intro"><span className="wa-section-icon"><WhatsAppIcon name={tool.mode === 'send' ? 'send' : tool.category === 'group' ? 'groups' : 'tools'}/></span><div><h2>{tool.title}</h2><p>{write ? 'Review your details, then confirm the action.' : 'Read the latest information from your connected account.'}</p></div></div>
  {tool.disabledReason && <div className="wa-notice">{tool.disabledReason}{tool.mode === 'account' && <Link to="/whatsapp/accounts">Manage accounts</Link>}</div>}
  <fieldset disabled={pending || Boolean(tool.disabledReason)} className="wa-fields">
  {fields.map(field => <label className="wa-field" key={field.key}><span>{title(field.name)}{field.isRequired && ' *'}</span>
   {field.format === 'binary' ? <><input type="file" disabled={Boolean(uploading)} accept={field.name === 'image' || field.name === 'photo' || field.name === 'avatar' ? 'image/jpeg,image/png,image/webp' : undefined} onChange={e => void upload(field.name, e.target.files?.[0])}/><small>{uploading === field.name ? 'Uploading…' : files[field.name] ? 'File ready to send.' : 'Upload a file. Maximum 25 MiB.'}</small></> :
                field.type === 'boolean' ? <input type="checkbox" checked={values[field.key] === true} onChange={e => change(field.key, e.target.checked)}/> :
                    field.enum ? <select value={String(values[field.key] ?? '')} required={field.isRequired} onChange={e => change(field.key, e.target.value)}><option value="">Choose…</option>{field.enum.map(v => <option key={String(v)} value={String(v)}>{humanise(String(v))}</option>)}</select> :
                        field.type === 'array' || field.type === 'object' || field.name === 'message' || field.name === 'caption' || field.name === 'topic' ? <textarea rows={field.type === 'object' ? 5 : 3} required={field.isRequired} value={String(values[field.key] ?? '')} placeholder={field.type === 'array' ? 'One value per line' : field.type === 'object' ? 'Enter structured details as JSON' : undefined} maxLength={field.maxLength ?? 16000} onChange={e => change(field.key, e.target.value)}/> :
                            <input required={field.isRequired} type={field.name === 'api_token' ? 'password' : field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} step={field.type === 'integer' ? 1 : 'any'} min={field.minimum} max={field.maximum} maxLength={field.name === 'phone' ? 190 : field.maxLength ?? 16000} value={String(values[field.key] ?? '')} onChange={e => change(field.key, e.target.value)}/>}
  </label>)}
  {tool.mode === 'send' && <label className="wa-field"><span>Send later <small>(optional)</small></span><input type="datetime-local" value={schedule} onChange={e => { setSchedule(e.target.value); dirty(); }}/><small>Your local time. Delivery follows CRM controls.</small></label>}
  {tool.mode === 'send' && schedule && <div className="wa-schedule-fields"><label className="wa-field"><span>Repeat</span><select value={recurrence} onChange={e => { setRecurrence(e.target.value); dirty(); }}>{['once', 'daily', 'weekly', 'monthly'].map(v => <option key={v} value={v}>{humanise(v)}</option>)}</select></label><label className="wa-field"><span>Timezone</span><input value={timezone} onChange={e => { setTimezone(e.target.value); dirty(); }} required/></label>{recurrence === 'weekly' && <fieldset><legend>Weekdays</legend>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => <label key={i}><input type="checkbox" checked={weekdays.includes(i)} onChange={e => { setWeekdays(v => e.target.checked ? [...v, i] : v.filter(d => d !== i)); dirty(); }}/>{label}</label>)}</fieldset>}{recurrence === 'monthly' && <label className="wa-field"><span>Day of month</span><input type="number" min={1} max={31} value={monthday} onChange={e => { setMonthday(Number(e.target.value)); dirty(); }}/></label>}{recurrence !== 'once' && <><label className="wa-field"><span>End after (optional)</span><input type="datetime-local" value={endAt} onChange={e => { setEndAt(e.target.value); dirty(); }}/></label><label className="wa-field"><span>Maximum occurrences (optional)</span><input type="number" min={1} max={10000} value={limit} onChange={e => { setLimit(e.target.value); dirty(); }}/></label></>}</div>}
  {write && <label className="wa-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/><span>I reviewed the account, recipient and details.</span></label>}
  <button type="submit" className="wa-primary" disabled={pending || Boolean(uploading) || write && !confirmed}>{pending ? 'Please wait…' : write ? tool.mode === 'send' ? schedule ? 'Schedule message' : 'Send message' : 'Confirm action' : 'Load information'}</button>
  </fieldset>
  {failure && <div className="wa-error" role="alert">{failure}</div>}
  {action && <div className="wa-action-result" role="status"><div><strong>{humanise(action.status)}</strong>{action.error && <p>{action.error}</p>}</div>{action.status === 'QUEUED' && <button type="button" onClick={() => void whatsappTools.cancel(accountId, action.id).then(setAction).catch(e => setFailure(errorMessage(e, 'Could not cancel.')))}>Cancel</button>}</div>}
  {result !== undefined && <div className="wa-tool-result"><h3>Result</h3><WhatsAppResult value={result}/></div>}
 </form>;
}
export function WhatsAppToolsPage({ accountId, category = 'all' }: {
    accountId: string;
    category?: string;
}) {
    const [params, setParams] = useSearchParams();
    const requested = params.get('tool');
    const [tools, setTools] = useState<WhatsAppTool[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [group, setGroup] = useState(category);
    const [selected, setSelected] = useState<string | null>(requested);
    const [actions, setActions] = useState<WhatsAppAction[]>([]);
    const load = useCallback(() => { void whatsappTools.catalogue().then(p => { setTools(p.operations); setError(null); }).catch(e => setError(errorMessage(e, 'Could not load WhatsApp tools.'))); }, []);
    useEffect(load, [load]);
    useEffect(() => { setGroup(category); }, [category]);
    useEffect(() => { if (requested)
        setSelected(requested); }, [requested]);
    useEffect(() => { if (!accountId)
        return; let active = true; const refresh = () => void whatsappTools.actions(accountId).then(p => { if (active)
        setActions(p.items); }).catch(() => undefined); refresh(); const timer = setInterval(() => { if (document.visibilityState === 'visible')
        refresh(); }, 5000); return () => { active = false; clearInterval(timer); }; }, [accountId]);
    const list = (tools ?? []).filter(t => (group === 'all' || t.category === group || group === 'schedule' && t.mode === 'schedule') && `${t.title} ${t.id}`.toLowerCase().includes(search.toLowerCase()));
    const current = tools?.find(t => t.id === selected);
    return <div className="wa-tools-layout"><aside className="wa-tools-list"><header><h1>WhatsApp tools</h1><p>Everything for your account, together.</p></header><div className="wa-search"><WhatsAppIcon name="search" size={18}/><input aria-label="Find a WhatsApp feature" placeholder="Search features" value={search} onChange={e => setSearch(e.target.value)}/></div><select className="wa-category" aria-label="Feature category" value={group} onChange={e => setGroup(e.target.value)}>{WA_TOOL_GROUPS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
 {error ? <ErrorState message={error} onRetry={load}/> : tools === null ? <Loading /> : <div className="wa-tool-options">{list.map(t => <button className={t.id === selected ? 'active' : ''} key={t.id} onClick={() => { setSelected(t.id); setParams({ ...Object.fromEntries(params), tool: t.id }, { replace: true }); }}><WhatsAppIcon name={t.category === 'group' ? 'groups' : t.category === 'newsletter' ? 'channels' : t.mode === 'send' ? 'send' : 'tools'} size={19}/><span><strong>{t.title}</strong><small>{t.disabledReason ? t.mode === 'account' ? 'Account controls' : t.mode === 'integration' ? 'Integration setup' : t.mode === 'schedule' ? 'CRM scheduling' : 'Configuration needed' : t.mode === 'read' ? 'View information' : t.mode === 'send' ? 'Send through WhatsApp' : 'Manage in WhatsApp'}</small></span></button>)}{!list.length && <p className="wa-muted">No matching features.</p>}</div>}
 </aside><div className="wa-tools-content">{!accountId ? <Empty title="Choose an account" hint="Select a WhatsApp account above or link a new number." action={<Link to="/whatsapp/accounts">Link a device</Link>}/> : current ? <WhatsAppToolForm key={`${accountId}:${current.id}`} accountId={accountId} tool={current} onComplete={action => setActions(rows => [action, ...rows.filter(r => r.id !== action.id)])}/> : <div className="wa-tools-welcome"><WhatsAppIcon name="tools" size={55}/><h2>Your WhatsApp workspace</h2><p>Send media, manage groups, organize chats and keep track of every action.</p><div className="wa-feature-highlights">{[['image', 'Photos & video'], ['poll', 'Polls & locations'], ['groups', 'Group management'], ['clock', 'Scheduled delivery']].map(([icon, text]) => <span key={text}><WhatsAppIcon name={icon}/>{text}</span>)}</div></div>}
 {actions.length > 0 && <section className="wa-action-history"><h3>Recent actions</h3>{actions.slice(0, 10).map(action => <div key={action.id}><span><strong>{tools?.find(t => t.id === action.operationId)?.title ?? humanise(action.operationId)}</strong><small>{new Date(action.createdAt).toLocaleString()}</small></span><span className={`wa-action-state ${action.status.toLowerCase()}`}>{humanise(action.status)}</span>{action.status === 'QUEUED' && <button onClick={() => void whatsappTools.cancel(accountId, action.id).then(changed => setActions(rows => rows.map(r => r.id === changed.id ? changed : r))).catch(e => setError(errorMessage(e, 'Could not cancel.')))}>Cancel</button>}{action.error && <p className="wa-error">{action.error}</p>}</div>)}</section>}
 </div></div>;
}
