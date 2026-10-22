import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { audit, conversations, reports, whatsapp, type ActivityTrendPoint, type AuditEntry, type Conversation, type DashboardReport, type WhatsAppAccount } from '../../api/client';
import { workspace, type QueueOverview } from '../../api/workspace';
import { useAuth } from '../../auth-context';
import { Badge, Card, Empty, ErrorState, Loading, RelativeTime, TrendChart, errorMessage, humanise } from '../../components/ui';
import { IconActivity, IconBookOpen, IconCheckCircle, IconClock, IconInbox, IconMessageCircle, IconRadio, IconRefresh, IconSparkles, IconUsers, IconZap } from '../../components/icons';

export function OverviewPage() {
  const { user, can } = useAuth();
  const [queue, setQueue] = useState<QueueOverview | null>(null);
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [trend, setTrend] = useState<ActivityTrendPoint[]>([]);
  const [recent, setRecent] = useState<Conversation[]>([]);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [activity, setActivity] = useState<AuditEntry[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [days, setDays] = useState('7');
  const load = useCallback(async () => {
    setBusy(true);
    const failures: string[] = [];
    const guarded = async <T,>(label: string, work: Promise<T>, apply: (value: T) => void) => {
      try { apply(await work); } catch (e) { failures.push(`${label}: ${errorMessage(e, 'Could not load.')}`); }
    };
    const from = new Date(Date.now() - Number(days) * 86400000).toISOString();
    await Promise.allSettled([
      can('conversations.read') && guarded('Queue', workspace.overview(), setQueue),
      can('conversations.read') && guarded('Conversations', conversations.list({ limit: 6 }), p => setRecent(p.items)),
      can('channels.read') && guarded('Connections', whatsapp.overview(), p => setAccounts(p.items)),
      can('reports.view') && guarded('Metrics', reports.dashboard({ from }), setReport),
      can('reports.view') && guarded('Activity chart', reports.activityTrend({ from }), p => setTrend(p.items)),
      can('audit.view') && guarded('Activity', audit.list({ limit: 5 }), p => setActivity(p.items)),
    ]);
    setErrors(failures); setBusy(false); setUpdated(new Date());
  }, [can, days]);
  useEffect(() => { void load(); }, [load]);
  const name = (user?.name || user?.username || 'there').split(' ')[0];
  const hour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Dhaka' }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const connected = accounts.filter(a => a.connected).length;
  const stat = (label: string, value: number | string | null | undefined, hint: string, icon: React.ReactNode, color: string, to = '/support-queue') => (
    <Link to={to} className="overview-stat overview-stat-link"><div className="overview-stat-top"><span>{label}</span><span className={`overview-icon ${color}`}>{icon}</span></div><strong>{value ?? '—'}</strong><span className="small muted">{hint}</span></Link>
  );
  return <div className="workspace-overview">
    <div className="workspace-heading"><div><div className="eyebrow">YOUR SUPPORT, IN FOCUS</div><h1>Overview</h1><p className="muted">A little clarity for a busy day.</p></div><div className="row"><span className="small muted">{new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dhaka' })}</span>{can('channels.manage') && <Link className="button-link primary" to="/channels/whatsapp#pairing">+ Connect account</Link>}<button onClick={() => void load()} disabled={busy} aria-label="Refresh dashboard"><IconRefresh size={16} /></button></div></div>
    <section className="welcome-panel"><div><span className="welcome-kicker"><span className="live-dot" /> YOUR WORKSPACE</span><h2>{greeting}, {name} <span className="welcome-wave">✦</span></h2><p>{queue ? `${queue.open} open conversations. ${queue.mine} assigned to you. Let’s make every reply count.` : 'Your conversations, people and knowledge. One connected workspace.'}</p><div className="row">{can('conversations.read') && <Link className="button-link primary" to="/conversations"><IconInbox size={16} /> Open inbox <span>↗</span></Link>}{can('reports.view') && <Link className="welcome-secondary" to="/analytics">Explore analytics →</Link>}</div></div><div className="welcome-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="art-tile art-back"><IconUsers size={28} /></div><div className="art-tile art-front"><IconMessageCircle size={40} /><span className="art-spark">✦</span></div><div className="art-note"><span className="live-dot" /> Better together</div></div></section>
    {errors.length > 0 && <ErrorState message={errors.join(' ')} onRetry={() => void load()} />}
    <div className="overview-stats">
      {can('conversations.read') && <>{stat('Open conversations', queue?.open, 'Across your support inbox', <IconInbox size={19} />, 'purple', '/conversations')}{stat('Assigned to you', queue?.mine, 'Your active conversations', <IconUsers size={19} />, 'blue', '/support-queue?view=mine')}{stat('Waiting for a human', queue?.waitingForHuman, 'Ready for a personal touch', <IconClock size={19} />, 'amber')}</>}
      {can('reports.view') && stat('Automation rate', report?.decisions.automationRate == null ? null : `${Math.round(report.decisions.automationRate * 100)}%`, `Decisions in the last ${days} days`, <IconZap size={19} />, 'green', '/reports')}
    </div>
    <div className="overview-columns"><div className="stack">
      {can('reports.view') && <Card title="Conversation activity" actions={<select aria-label="Chart period" value={days} onChange={e => setDays(e.target.value)}><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select>}><div className="chart-caption"><span className="muted small">New conversations and automated decisions over time</span><Link to="/reports" className="small">View reports ↗</Link></div>{busy && !report ? <Loading /> : trend.length ? <TrendChart points={trend as unknown as Array<Record<string, string | number>>} series={[{ key: 'conversations', label: 'Conversations', color: 'var(--accent)' }, { key: 'automated', label: 'Automated decisions', color: 'var(--ok)' }]} height={210} /> : <Empty title="Your activity starts here" hint="The chart fills in as conversations arrive." />}</Card>}
      {can('conversations.read') && <Card title="Recent conversations" actions={<Link className="small" to="/conversations">View inbox →</Link>}>{busy && !queue ? <Loading /> : recent.length === 0 ? <Empty title="A fresh inbox" hint="Connect a WhatsApp account to start receiving conversations." /> : <div className="overview-conversations">{recent.map(c => <Link key={c.id} to={`/conversations?conversation=${c.id}`} className="overview-conversation"><span className="person-avatar">{(c.subject || 'C').slice(0, 2).toUpperCase()}</span><div><strong>{c.subject || 'Conversation'}</strong><span className="small muted">{humanise(c.kind)} · <RelativeTime value={c.lastMessageAt} /></span></div><Badge tone={c.status === 'WAITING_FOR_HUMAN' ? 'warn' : c.status === 'RESOLVED' ? 'ok' : 'neutral'}>{humanise(c.status)}</Badge><span className="muted">↗</span></Link>)}</div>}</Card>}
    </div><div className="stack">
      <Card title="Quick actions"><div className="quick-action-list">{[
        ['conversations.read', '/support-queue', 'Support queue', 'Find the next conversation', <IconInbox size={19} />],
        ['customers.read', '/customers', 'Customer directory', 'Know who you’re helping', <IconUsers size={19} />],
        ['knowledge.read', '/knowledge', 'Knowledge base', 'Find a reliable answer', <IconBookOpen size={19} />],
        ['automation.read', '/automation', 'Automations', 'Make routine work lighter', <IconZap size={19} />],
      ].filter(([permission]) => can(permission as string)).map(([, href, title, sub, icon]) => <Link key={href as string} to={href as string} className="quick-action"><span className="overview-icon purple">{icon}</span><span><strong>{title}</strong><small>{sub}</small></span><span>↗</span></Link>)}</div></Card>
      {can('channels.read') && <Card title="Channel health" actions={<IconRadio size={17} />}><div className="channel-health"><span className={`health-orb ${connected > 0 ? 'connected' : ''}`}><IconMessageCircle size={23} /></span><div><strong>WhatsApp</strong><div className="small muted">{connected} of {accounts.length} accounts connected</div></div></div><div className="connection-track">{accounts.length > 0 ? accounts.map(a => <span key={a.id} className={a.connected ? 'connected' : ''} title={`${a.name}: ${a.statusText}`} />) : <span />}</div><Link to="/channels/whatsapp" className="small">Manage connections →</Link></Card>}
      {can('audit.view') && <Card title="Workspace activity" actions={<IconActivity size={17} />}>{activity.length ? <div className="activity-timeline">{activity.map(a => <div key={a.id}><span className="timeline-dot" /><div><strong>{humanise(a.action.replace(/\./g, ' '))}</strong><small>{a.actorUsername || 'System'} · <RelativeTime value={a.createdAt} /></small></div></div>)}</div> : <Empty title="All quiet for now" hint="Your team’s actions will appear here." />}</Card>}
      <div className="workspace-tip"><IconSparkles size={20} /><div><strong>A shared source of truth</strong><p>Keep your knowledge verified so your team and AI can answer with confidence.</p>{can('knowledge.read') && <Link to="/knowledge">Explore knowledge →</Link>}</div></div>
    </div></div><div className="overview-footer"><span><IconCheckCircle size={13} /> {updated ? `Updated ${updated.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka' })}` : 'Loading workspace'}</span><span>Made for meaningful conversations.</span></div>
  </div>;
}
