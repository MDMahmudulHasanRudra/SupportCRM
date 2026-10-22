import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, conversations, type Conversation, type ConversationStatusValue } from '../../api/client';
import { workspace, type Person } from '../../api/workspace';
import { useAuth } from '../../auth-context';
import { Badge, Card, Empty, ErrorState, Loading, PageHeader, RelativeTime, TableWrap, errorMessage, humanise, useToast } from '../../components/ui';
import { downloadCsv, useResource } from './shared';

export function SupportQueuePage() {
  const { user, can } = useAuth(); const toast = useToast();
  const [params, setParams] = useSearchParams();
  const requestedView = params.get('view') || 'waiting';
  const view = ['waiting','mine','unassigned','completed'].includes(requestedView) ? requestedView : 'waiting';
  const setView = (value: string) => setParams({ view: value });
  const [people, setPeople] = useState<Person[]>([]); const [chosen, setChosen] = useState<string[]>([]); const [assignee, setAssignee] = useState(''); const [working, setWorking] = useState(false);
  const loader = useCallback(() => {
    const q = new URLSearchParams({ limit: '100' });
    if (view === 'waiting') q.set('status', 'WAITING_FOR_HUMAN');
    if (view === 'mine') q.set('assignedToUserId', user?.id || '');
    if (view === 'completed') q.set('status', 'RESOLVED');
    if (view === 'unassigned') q.set('unassignedOnly', 'true');
    if (view !== 'completed') q.set('activeOnly', 'true');
    return api.get<{ items: Conversation[]; total: number }>(`/conversations?${q}`);
  }, [view, user?.id]);
  const { data, busy, error, refresh } = useResource(loader);
  useEffect(() => { if (can('conversations.manage')) void workspace.people().then(p => setPeople(p.items)).catch(e => toast.error(errorMessage(e, 'Could not load assignees.'))); }, [can, toast]);
  const rows = data?.items ?? [];
  async function assign() {
    if (!assignee || !chosen.length || working) return; setWorking(true);
    const results: PromiseSettledResult<unknown>[] = [];
    for (let offset = 0; offset < chosen.length; offset += 5) {
      results.push(...await Promise.allSettled(chosen.slice(offset, offset + 5).map(id => api.post(`/conversations/${id}/assign`, { userId: assignee }))));
    }
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) toast.error(`${failed} assignments failed. Refresh the queue and retry.`);
    if (results.length > failed) toast.success(`${results.length - failed} conversations assigned.`);
    setChosen([]); setWorking(false); await refresh();
  }
  async function resolve(c: Conversation) { try { await conversations.setStatus(c.id, 'RESOLVED' as ConversationStatusValue); toast.success('Conversation resolved.'); await refresh(); } catch (e) { toast.error(errorMessage(e, 'Could not resolve.')); } }
  return <><PageHeader title="Support queue" description="Turn conversations into clear responsibilities." actions={<button onClick={() => void refresh()} disabled={busy}>Refresh</button>} /><div className="workspace-toolbar"><div className="workspace-tabs" role="tablist" aria-label="Support queue views">{[['waiting','Waiting for a human'],['mine','My assignments'],['unassigned','Unassigned'],['completed','Completed']].map(([id,label]) => <button role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} key={id} onClick={() => { setView(id); setChosen([]); }}>{label}</button>)}</div>{can('reports.export') && <button onClick={() => downloadCsv('support-queue.csv', rows.map(c => ({ subject: c.subject, status: c.status, priority: c.priority, assignedTo: c.assignedToUserId, lastInboundAt: c.lastInboundAt })))}>Export CSV</button>}</div>{error && <ErrorState message={error} onRetry={() => void refresh()} />}
    {can('conversations.manage') && <div className="queue-bulk"><strong>{chosen.length} selected</strong><select value={assignee} onChange={e => setAssignee(e.target.value)} aria-label="Assign selected conversations"><option value="">Select a teammate</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="primary" disabled={!assignee || !chosen.length || working} onClick={() => void assign()}>{working ? 'Assigning…' : 'Assign selected'}</button></div>}
    {busy && !data ? <Loading /> : <Card title={`${data?.total ?? 0} conversations`}>{rows.length ? <TableWrap><table><thead><tr>{can('conversations.manage') && <th><input type="checkbox" aria-label="Select all visible conversations" checked={rows.length > 0 && chosen.length === rows.length} onChange={e => setChosen(e.target.checked ? rows.map(c => c.id) : [])} /></th>}<th>Conversation</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Last customer activity</th><th /></tr></thead><tbody>{rows.map(c => <tr key={c.id}>{can('conversations.manage') && <td><input type="checkbox" checked={chosen.includes(c.id)} aria-label={`Select ${c.subject || 'conversation'}`} onChange={e => setChosen(ids => e.target.checked ? [...ids, c.id] : ids.filter(id => id !== c.id))} /></td>}<td><Link to={`/conversations?conversation=${c.id}`}><strong>{c.subject || 'Untitled conversation'}</strong></Link><div className="small muted">{humanise(c.kind)}</div></td><td><Badge tone={['HIGH','URGENT'].includes(c.priority) ? 'warn' : 'neutral'}>{humanise(c.priority)}</Badge></td><td>{humanise(c.status)}</td><td>{c.assignedToUserId ? people.find(p => p.id === c.assignedToUserId)?.name || 'Assigned user' : c.assignedToTeamId ? 'Assigned team' : 'Unassigned'}</td><td><RelativeTime value={c.lastInboundAt} /></td><td>{can('conversations.manage') && !['RESOLVED','CLOSED'].includes(c.status) && <button onClick={() => void resolve(c)}>Resolve</button>}</td></tr>)}</tbody></table></TableWrap> : <Empty title="This queue is clear" hint="Try another view or come back when new conversations arrive." />}<p className="small muted">First 100 matching conversations. Last customer activity is not the duration of an unanswered support request.</p></Card>}
  </>;
}
