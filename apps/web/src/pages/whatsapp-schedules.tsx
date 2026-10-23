import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { whatsappTools } from '../api/whatsapp-tools';
import { useAuth } from '../auth-context';
import { Empty, ErrorState, Loading, errorMessage, humanise } from '../components/ui';
import { WhatsAppIcon } from '../components/whatsapp-icons';
interface Schedule {
    schedule_id: string;
    recipient: string;
    message: string;
    status: string;
    next_run_at: string;
    recurrence: string;
    timezone: string;
    run_count: number;
    last_error: string | null;
    message_type: string;
}
export function WhatsAppSchedulesPage({ accountId }: {
    accountId: string;
}) {
    const { can } = useAuth();
    const [rows, setRows] = useState<Schedule[] | null>(null);
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [total, setTotal] = useState(0);
    const load = useCallback(async () => { if (!accountId)
        return; try {
        const result = await whatsappTools.read(accountId, 'listScheduledSends', { parameters: { limit: 25, offset: page * 25, ...(status ? { status } : {}), ...(search ? { search } : {}) }, body: {} }) as {
            items: Schedule[];
            total: number;
        };
        setRows(result.items);
        setTotal(result.total);
        setError(null);
    }
    catch (e) {
        setError(errorMessage(e, 'Schedules could not be loaded.'));
    } }, [accountId, page, search, status]);
    useEffect(() => { setRows(null); void load(); const timer = setInterval(() => { if (document.visibilityState === 'visible')
        void load(); }, 15000); return () => clearInterval(timer); }, [load]);
    useEffect(() => setPage(0), [accountId, search, status]);
    async function change(row: Schedule, operation: string) { if (busy)
        return; setBusy(row.schedule_id); try {
        await whatsappTools.submit(accountId, operation, { parameters: { schedule_id: row.schedule_id }, body: {}, requestKey: crypto.randomUUID(), confirmed: true });
        await load();
    }
    catch (e) {
        setError(errorMessage(e, 'The schedule could not be changed.'));
    }
    finally {
        setBusy(null);
    } }
    return <div className="wa-subpage"><header className="wa-tool-intro"><span className="wa-section-icon"><WhatsAppIcon name="clock"/></span><div><h1>Scheduled messages</h1><p>One-time and recurring messages, managed in your workspace.</p></div><Link className="button-link primary" to={`/whatsapp/tools?account=${accountId}&tool=sendMessage`}>Schedule a message</Link></header><div className="row"><input aria-label="Search schedules" placeholder="Search recipient or message" value={search} onChange={e => setSearch(e.target.value)}/><select aria-label="Schedule status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All schedules</option>{['active', 'paused', 'completed', 'failed', 'cancelled'].map(v => <option key={v}>{v}</option>)}</select></div>{error && <ErrorState message={error} onRetry={() => void load()}/>}{!accountId ? <Empty title="Choose an account"/> : rows === null ? <Loading /> : !rows.length ? <Empty title="No scheduled messages" hint="Choose a send tool, set Send later and choose a repeat option."/> : <div className="wa-schedule-cards">{rows.map(row => <article key={row.schedule_id}><div className="wa-schedule-icon"><WhatsAppIcon name="clock"/></div><div><strong>{row.recipient}</strong><p>{row.message || humanise(row.message_type)}</p><small>{humanise(row.recurrence)} · {new Date(row.next_run_at).toLocaleString()} · {row.timezone}</small><small>{row.run_count} queued · {humanise(row.status)}</small>{row.last_error && <p className="wa-error">{row.last_error}</p>}</div>{can('messages.send') && ['active', 'paused', 'failed'].includes(row.status) && <div className="wa-schedule-actions"><button disabled={!!busy} onClick={() => void change(row, row.status === 'active' ? 'pauseScheduledSend' : 'resumeScheduledSend')}>{row.status === 'active' ? 'Pause' : 'Resume'}</button><button disabled={!!busy} onClick={() => void change(row, 'cancelScheduledSend')}>Cancel</button></div>}</article>)}</div>}<div className="row"><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button><span className="wa-muted">Page {page + 1}</span><button disabled={(page + 1) * 25 >= total} onClick={() => setPage(p => p + 1)}>Next</button></div></div>;
}
