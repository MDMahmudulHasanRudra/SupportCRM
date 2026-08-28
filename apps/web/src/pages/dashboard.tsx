import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  activityAnalytics,
  audit,
  health as healthApi,
  reports,
  whatsapp,
  type ActivityTrendPoint,
  type AuditEntry,
  type BroadcastReportRow,
  type DashboardReport,
  type HealthReport,
  type WhatsAppAccount,
} from '../api/client';
import { onChannelStatus } from '../api/realtime';
import { useAuth } from '../auth-context';
import { RelativeTime, StatusBadge } from '../components/status-badge';
import {
  IconAlertCircle,
  IconCheckCircle,
  IconClock,
  IconLightbulb,
  IconMegaphone,
  IconMessageCircle,
  IconRadio,
  IconSend,
  IconUserCircle,
} from '../components/icons';
import {
  Badge,
  Card,
  CoverageBar,
  Donut,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  Stat,
  StatGrid,
  TrendChart,
  errorMessage,
  humanise,
} from '../components/ui';
import { DashboardOperations } from './dashboard-operations';

/** What the pattern-detection panel needs — the same shape `/reports/patterns` returns. */
type PatternsReport = Awaited<ReturnType<typeof activityAnalytics.patterns>>;

/**
 * The landing page.
 *
 * Answers the questions somebody actually asks, in order: is anything on fire, is WhatsApp working,
 * what has the system been doing, and is the machinery underneath it healthy. Every figure is real
 * — there is no tile here that renders a placeholder, because a dashboard with one is a dashboard
 * people stop reading.
 *
 * Each panel is permission-gated independently. Somebody without `reports.view` sees the channel
 * state and nothing that pretends to be missing.
 */
export function DashboardPage() {
  const { user, can } = useAuth();

  const [accounts, setAccounts] = useState<WhatsAppAccount[] | null>(null);
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [trend, setTrend] = useState<ActivityTrendPoint[] | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [system, setSystem] = useState<HealthReport | null>(null);
  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const [patterns, setPatterns] = useState<PatternsReport | null>(null);
  const [broadcastRows, setBroadcastRows] = useState<BroadcastReportRow[] | null>(null);

  const canSeeReports = can('reports.view');
  const canSeeAudit = can('audit.view');

  const loadAccounts = useCallback(async () => {
    const { items } = await whatsapp.overview().catch(() => ({ items: [] as WhatsAppAccount[] }));
    setAccounts(items);
  }, []);

  const loadReport = useCallback(async () => {
    if (!canSeeReports) return;
    try {
      const [dashboard, activityTrend] = await Promise.all([reports.dashboard(), reports.activityTrend()]);
      setReport(dashboard);
      setTrend(activityTrend.items);
      setReportError(null);
    } catch (failure) {
      setReportError(errorMessage(failure, 'The activity figures could not be loaded.'));
    }
  }, [canSeeReports]);

  // Best-effort, like health/audit below: the pattern-detection and broadcast panels are a bonus
  // view onto data the rest of the app already surfaces in full elsewhere (the automation candidate
  // queue, the reports page), so a failure here shouldn't take down the figures above.
  const loadPatterns = useCallback(async () => {
    if (!canSeeReports) return;
    setPatterns(await activityAnalytics.patterns(5).catch(() => null));
  }, [canSeeReports]);

  const loadBroadcasts = useCallback(async () => {
    if (!canSeeReports) return;
    const { items } = await reports.broadcasts().catch(() => ({ items: [] as BroadcastReportRow[] }));
    setBroadcastRows(items.slice(0, 5));
  }, [canSeeReports]);

  // Health and audit are best-effort: a dashboard that fails wholesale because one panel could not
  // load is worse than one panel quietly saying it has nothing.
  const loadSystem = useCallback(async () => {
    setSystem(await healthApi.full().catch(() => null));
  }, []);

  const loadActivity = useCallback(async () => {
    if (!canSeeAudit) return;
    const page = await audit.list({ limit: 8 }).catch(() => null);
    setActivity(page?.items ?? []);
  }, [canSeeAudit]);

  useEffect(() => {
    void loadAccounts();
    void loadReport();
    void loadSystem();
    void loadActivity();
    void loadPatterns();
    void loadBroadcasts();
  }, [loadAccounts, loadReport, loadSystem, loadActivity, loadPatterns, loadBroadcasts]);

  useEffect(() => onChannelStatus(() => void loadAccounts()), [loadAccounts]);

  const connected = accounts?.filter((account) => account.connected).length ?? 0;
  const needsAttention = accounts?.filter((account) => account.canConnect) ?? [];

  const seconds = (value: number | null | undefined) =>
    value === null || value === undefined ? null : value < 90 ? `${value}s` : `${Math.round(value / 60)}m`;

  return (
    <>
      <PageHeader title="Dashboard" description={`Signed in as ${user?.name ?? user?.username}.`} />

      {/* Anything genuinely wrong goes first, above the figures. */}
      {report && report.escalations.openNow > 0 && (
        <div className="alert">
          {report.escalations.openNow} conversation{report.escalations.openNow === 1 ? ' is' : 's are'} waiting for a
          person. <Link to="/escalations">Open the queue →</Link>
        </div>
      )}
      {report && report.health.failedJobs > 0 && (
        <div className="alert">
          {report.health.failedJobs} background job{report.health.failedJobs === 1 ? '' : 's'} failed.
        </div>
      )}

      {/* Group operations. Added alongside the conversation-oriented reporting below rather than
          replacing it — the two answer different questions and operators use both. */}
      {canSeeReports && <DashboardOperations />}

      {canSeeReports && (
        <>
          {reportError && <ErrorState message={reportError} onRetry={() => void loadReport()} />}
          {!report && !reportError && <Loading label="Counting the last seven days…" />}

          {report && (
            <StatGrid>
              <Stat
                label="Conversations"
                value={report.conversations.total}
                hint="Last 7 days"
                icon={<IconMessageCircle size={17} />}
                iconColor="accent"
              />
              <Stat
                label="Answered automatically"
                value={
                  report.decisions.automationRate === null
                    ? null
                    : `${Math.round(report.decisions.automationRate * 100)}%`
                }
                hint={
                  report.decisions.automationRate === null
                    ? 'Nothing has been decided yet'
                    : `${report.decisions.answeredAutomatically} of ${report.decisions.total} decisions`
                }
                tone={report.decisions.automationRate === null ? undefined : 'ok'}
                icon={<IconCheckCircle size={17} />}
                iconColor="ok"
              />
              <Stat
                label="Waiting for a human"
                value={report.escalations.openNow}
                tone={report.escalations.openNow > 0 ? 'warn' : 'ok'}
                icon={<IconAlertCircle size={17} />}
                iconColor={report.escalations.openNow > 0 ? 'warn' : 'ok'}
              />
              <Stat
                label="First response"
                value={seconds(report.timing.firstResponseSeconds)}
                hint="Average"
                icon={<IconClock size={17} />}
                iconColor="blue"
              />
              <Stat
                label="Monitored groups"
                value={report.health.monitoredGroups}
                icon={<IconRadio size={17} />}
                iconColor="orange"
              />
              <Stat
                label="Failed sends"
                value={report.health.failedOutbound}
                tone={report.health.failedOutbound > 0 ? 'bad' : 'ok'}
                icon={<IconSend size={17} />}
                iconColor={report.health.failedOutbound > 0 ? 'bad' : 'ok'}
              />
              <Stat
                label="Human handled"
                value={report.conversations.humanHandled}
                hint="Last 7 days"
                icon={<IconUserCircle size={17} />}
                iconColor="accent"
              />
              <Stat
                label="Resolution time"
                value={seconds(report.timing.resolutionSeconds)}
                hint="Average"
                icon={<IconClock size={17} />}
                iconColor="blue"
              />
            </StatGrid>
          )}
        </>
      )}

      {/* --- channel, trend, attention --------------------------------------------------------- */}
      <div className="dash-cols-3">
        <Card
          title="WhatsApp"
          actions={
            <Link to="/channels/whatsapp" className="small">
              Manage →
            </Link>
          }
        >
          {accounts === null ? (
            <Loading label="Checking connections…" />
          ) : accounts.length === 0 ? (
            <Empty
              title="No account connected"
              hint="Connect one to start receiving messages."
              action={
                <Link to="/channels/whatsapp" className="button-link">
                  Connect WhatsApp
                </Link>
              }
            />
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row">
                <Badge tone={connected === accounts.length ? 'ok' : connected === 0 ? 'bad' : 'warn'}>
                  {connected} of {accounts.length} connected
                </Badge>
                {needsAttention.length > 0 && (
                  <span className="muted small">{needsAttention.length} need attention</span>
                )}
              </div>
              <div className="rowlist">
                {accounts.map((account) => (
                  <div key={account.id} className="rowlist-item">
                    <div className="rowlist-body">
                      <div className="rowlist-text">{account.name}</div>
                      <div className="rowlist-sub">
                        {account.phoneNumber ?? 'number not known yet'} · {account.groupCount} groups
                      </div>
                    </div>
                    <StatusBadge state={account.state} label={account.statusText} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {canSeeReports && (
          <Card
            title="Activity"
            actions={<span className="muted small">Last 7 days</span>}
          >
            {!trend ? (
              <Loading label="Counting each day…" />
            ) : (
              <TrendChart
                points={trend as unknown as Array<Record<string, string | number>>}
                series={[
                  { key: 'conversations', label: 'Conversations', color: 'var(--blue)' },
                  { key: 'automated', label: 'Answered automatically', color: 'var(--ok)' },
                  { key: 'escalations', label: 'Escalated', color: 'var(--danger)' },
                ]}
                height={210}
              />
            )}
          </Card>
        )}

        <Card title="Needs attention">
          <div className="rowlist">
            {report && report.escalations.openNow > 0 && (
              <Link to="/escalations" className="rowlist-item" style={{ textDecoration: 'none' }}>
                <span className="rowlist-chip tone-warn">{report.escalations.openNow}</span>
                <div className="rowlist-body">
                  <div className="rowlist-text">Waiting for a person</div>
                  <div className="rowlist-sub">Open escalations</div>
                </div>
              </Link>
            )}
            {report && report.health.failedOutbound > 0 && (
              <div className="rowlist-item">
                <span className="rowlist-chip tone-bad">{report.health.failedOutbound}</span>
                <div className="rowlist-body">
                  <div className="rowlist-text">Failed sends</div>
                  <div className="rowlist-sub">Messages that never reached a customer</div>
                </div>
              </div>
            )}
            {report && report.health.failedJobs > 0 && (
              <div className="rowlist-item">
                <span className="rowlist-chip tone-bad">{report.health.failedJobs}</span>
                <div className="rowlist-body">
                  <div className="rowlist-text">Failed background jobs</div>
                  <div className="rowlist-sub">Retry or inspect them</div>
                </div>
              </div>
            )}
            {needsAttention.length > 0 && (
              <Link to="/channels/whatsapp" className="rowlist-item" style={{ textDecoration: 'none' }}>
                <span className="rowlist-chip tone-warn">{needsAttention.length}</span>
                <div className="rowlist-body">
                  <div className="rowlist-text">WhatsApp needs linking</div>
                  <div className="rowlist-sub">Scan a code to reconnect</div>
                </div>
              </Link>
            )}
            {report &&
              report.escalations.openNow === 0 &&
              report.health.failedOutbound === 0 &&
              report.health.failedJobs === 0 &&
              needsAttention.length === 0 && <Empty title="Nothing needs you" hint="No escalations, no failures." />}
            {!report && <Loading label="Checking…" />}
          </div>
        </Card>
      </div>

      {/* --- decisions, activity, health -------------------------------------------------------- */}
      <div className="dash-cols-even">
        {report && Object.keys(report.decisions.byOutcome).length > 0 && (
          <Card
            title="What the system decided"
            actions={
              <Link to="/decisions" className="small">
                All →
              </Link>
            }
          >
            <Donut
              centerLabel="Decisions"
              segments={Object.entries(report.decisions.byOutcome)
                .sort((a, b) => b[1] - a[1])
                .map(([outcome, count]) => ({ label: outcome.toLowerCase().replace(/_/g, ' '), value: count }))}
            />
          </Card>
        )}

        {report && Object.keys(report.conversations.byStatus).length > 0 && (
          <Card title="Conversations by status">
            <div className="stack" style={{ gap: 10 }}>
              {Object.entries(report.conversations.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <CoverageBar
                    key={status}
                    label={humanise(status)}
                    value={count}
                    total={report.conversations.total}
                  />
                ))}
            </div>
          </Card>
        )}

        {/* Why people are escalating, not just how many — the "Waiting for a human" stat and the
            Needs Attention card above say something is waiting, this says what to expect once the
            queue is open. */}
        {report && Object.keys(report.escalations.byReason).length > 0 && (
          <Card
            title="Escalation reasons"
            actions={
              <Link to="/escalations" className="small">
                Queue →
              </Link>
            }
          >
            <div className="stack" style={{ gap: 10 }}>
              {Object.entries(report.escalations.byReason)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([reason, count]) => (
                  <CoverageBar key={reason} label={humanise(reason)} value={count} total={report.escalations.total} />
                ))}
            </div>
          </Card>
        )}

        {canSeeAudit && (
          <Card title="Recent activity">
            {!activity ? (
              <Loading label="Loading…" />
            ) : activity.length === 0 ? (
              <Empty title="Nothing recorded yet" hint="Actions people take appear here." />
            ) : (
              <div className="rowlist">
                {activity.map((entry) => (
                  <div key={entry.id} className="rowlist-item">
                    <span className={entry.success ? 'rowlist-chip tone-accent' : 'rowlist-chip tone-bad'}>
                      {(entry.actorUsername ?? '?').charAt(0).toUpperCase()}
                    </span>
                    <div className="rowlist-body">
                      <div className="rowlist-text">{humanise(entry.action.replace(/\./g, ' '))}</div>
                      <div className="rowlist-sub">
                        {entry.actorUsername ?? 'system'} · <RelativeTime value={entry.createdAt} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        <Card title="System health">
          {!system ? (
            <Loading label="Checking…" />
          ) : (
            <div className="rowlist">
              {Object.entries(system.components).map(([name, component]) => (
                <div key={name} className="rowlist-item">
                  <div className="rowlist-body">
                    <div className="rowlist-text">{humanise(name)}</div>
                    {component.detail && <div className="rowlist-sub">{component.detail}</div>}
                  </div>
                  <Badge
                    tone={
                      component.status === 'HEALTHY' ? 'ok' : component.status === 'WARNING' ? 'warn' : 'bad'
                    }
                  >
                    {humanise(component.status)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* --- what the system is learning, what it has sent -------------------------------------- */}
      {canSeeReports && (
        <div className="dash-cols-even">
          <Card
            title="Pattern detection"
            actions={
              <Link to="/automation/candidates" className="small">
                Review →
              </Link>
            }
          >
            {!patterns ? (
              <Loading label="Checking…" />
            ) : patterns.summary.total === 0 ? (
              <Empty
                title="No patterns detected yet"
                hint="Repeated questions the detector notices across groups appear here."
                icon={<IconLightbulb size={20} />}
              />
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                <div className="rowlist">
                  <div className="rowlist-item">
                    <span className="rowlist-chip tone-accent">{patterns.summary.total}</span>
                    <div className="rowlist-body">
                      <div className="rowlist-text">Detected</div>
                      <div className="rowlist-sub">{patterns.summary.groupsContributing} groups contributing</div>
                    </div>
                  </div>
                  <div className="rowlist-item">
                    <span className="rowlist-chip tone-warn">{patterns.summary.pending}</span>
                    <div className="rowlist-body">
                      <div className="rowlist-text">Pending review</div>
                    </div>
                  </div>
                  <div className="rowlist-item">
                    <span className="rowlist-chip tone-ok">{patterns.summary.published}</span>
                    <div className="rowlist-body">
                      <div className="rowlist-text">Published as rules</div>
                    </div>
                  </div>
                </div>
                {patterns.items[0] && (
                  <p className="muted small">
                    Most repeated: <strong>{patterns.items[0].title}</strong> ({patterns.items[0].occurrences}×)
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card
            title="Recent broadcasts"
            actions={
              <Link to="/broadcasts" className="small">
                All →
              </Link>
            }
          >
            {!broadcastRows ? (
              <Loading label="Loading…" />
            ) : broadcastRows.length === 0 ? (
              <Empty
                title="No broadcasts sent yet"
                hint="Campaign outcomes appear here once one goes out."
                icon={<IconMegaphone size={20} />}
              />
            ) : (
              <div className="rowlist">
                {broadcastRows.map((row) => (
                  <div key={row.id} className="rowlist-item">
                    <div className="rowlist-body">
                      <div className="rowlist-text">{row.name}</div>
                      <div className="rowlist-sub">
                        {row.sent.toLocaleString()} sent
                        {row.successRate !== null && ` · ${Math.round(row.successRate * 100)}% success`}
                      </div>
                    </div>
                    <Badge tone={row.status === 'COMPLETED' ? 'ok' : row.status === 'FAILED' ? 'bad' : 'busy'}>
                      {humanise(row.status)}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
