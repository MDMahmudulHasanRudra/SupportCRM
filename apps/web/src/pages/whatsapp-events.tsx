import { useEffect, useState } from 'react';
import { whatsappTools } from '../api/whatsapp-tools';
import { Empty, ErrorState, Loading, humanise } from '../components/ui';
export function WhatsAppEventsPage({ accountId }: {
    accountId: string;
}) {
    const [rows, setRows] = useState<Awaited<ReturnType<typeof whatsappTools.history>>['items'] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { if (!accountId)
        return; let live = true; setRows(null); const load = () => void whatsappTools.history(accountId).then(p => { if (live) {
        setRows(p.items);
        setError(null);
    } }).catch(e => { if (live)
        setError(e.message); }); load(); const timer = setInterval(() => { if (document.visibilityState === 'visible')
        load(); }, 15000); return () => { live = false; clearInterval(timer); }; }, [accountId]);
    return <div className="wa-subpage"><h1>Account activity</h1><p className="wa-muted">Recent received events and their processing state.</p>{!accountId ? <Empty title="Select an account"/> : error ? <ErrorState message={error}/> : rows === null ? <Loading /> : !rows.length ? <Empty title="No activity yet"/> : <div className="wa-result-table"><table><thead><tr><th>Event</th><th>State</th><th>Received</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{humanise(row.eventType)}</td><td>{humanise(row.status)}</td><td>{new Date(row.receivedAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</div>;
}
