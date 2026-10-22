import { Link } from 'react-router-dom';
import { workspace } from '../../api/workspace';
import { Card, Empty, ErrorState, Loading, PageHeader, RelativeTime, errorMessage, useToast } from '../../components/ui';
import { useResource } from './shared';

export function NotificationsPage() {
  const { data, error, busy, refresh } = useResource(workspace.notifications); const toast = useToast();
  async function read(id?: string) { try { if (id) await workspace.readNotification(id); else await workspace.readAll(); await refresh(); } catch (e) { toast.error(errorMessage(e, 'Could not update notifications.')); } }
  return <><PageHeader title="Notifications" description="Updates for you, in one quiet place." actions={<button onClick={() => void read()} disabled={!data?.unread}>Mark all as read</button>} />{error && <ErrorState message={error} onRetry={() => void refresh()} />}{busy && !data ? <Loading /> : <Card title={`${data?.unread ?? 0} unread`}>{data?.items.length ? data.items.map(n => <div className={`notification-row ${n.readAt ? '' : 'unread'}`} key={n.id}><span className="timeline-dot" /><div><strong>{n.title}</strong><p>{n.body}</p><span className="small muted"><RelativeTime value={n.createdAt} /></span>{n.href?.startsWith('/') && !n.href.startsWith('//') && <Link to={n.href} onClick={() => void read(n.id)} className="notification-open">Open →</Link>}</div>{!n.readAt && <button onClick={() => void read(n.id)}>Mark read</button>}</div>) : <Empty title="You’re all caught up" hint="Release announcements and leave decisions will appear here." />}</Card>}</>;
}
