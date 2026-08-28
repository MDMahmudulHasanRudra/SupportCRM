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
  RelativeTime as OpsRelativeTime,
  Stat,
  StatGrid,
  TableWrap,
  TrendChart,
  errorMessage,
  humanise,
} from '../components/ui';
import { AiStatus, OPERATIONS_WINDOWS, useOperationsDashboard } from './dashboard-operations';

/** The number of rows a "log-like" list panel shows before pointing at the full page instead. */
const LIST_LIMIT = 5;

/** What the pattern-detection panel needs — the same shape `/reports/patterns` returns. */
type PatternsReport = Awaited<ReturnType<typeof activityAnalytics.patterns>>;

/**
 * The landing page.
 *
 * Three tiers, top to bottom: every number first (so "is anything on fire" is answerable without
 * scrolling), then the lists an operator actually reads line by line, then the charts that reward a
 * slower look. Every figure is real — there is no tile here that renders a placeholder, because a
 * dashboard with one is a dashboard people stop reading.
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
  const [days, setDays] = useState(14);

  const canSeeReports = can('reports.view');
  const canSeeAudit = can('audit.view');

  const ops = useOperationsDashboard(days);

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

  // Health, audit, patterns and broadcasts are all best-effort: a dashboard that fails wholesale
  // because one panel could not load is worse than one panel quietly saying it has nothing.
  const loadSystem = useCallback(async () => {
    setSystem(await healthApi.full().catch(() => null));
  }, []);

  const loadActivity = useCallback(async () => {
    if (!canSeeAudit) return;
    const page = await audit.list({ limit: LIST_LIMIT }).catch(() => null);
    setActivity(page?.items ?? []);
  }, [canSeeAudit]);

  const loadPatterns = useCallback(async () => {
    if (!canSeeReports) return;
    setPatterns(await activityAnalytics.patterns(LIST_LIMIT).catch(() => null));
  }, [canSeeReports]);

  const loadBroadcasts = useCallback(async () => {
    if (!canSeeReports) return;
    const { items } = await reports.broadcasts().catch(() => ({ items: [] as BroadcastReportRow[] }));
    setBroadcastRows(items.slice(0, LIST_LIMIT));
  }, [canSeeReports]);

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
  const opsReady = !!ops.data;

  // A negative duration isn't a smaller number, it's not a duration — treat it the same as
  // "nothing measured yet" rather than print a value nobody could act on.
  const seconds = (value: number | null | undefined) =>
    value === null || value === undefined || value < 0
      ? null
      : value < 90
        ? `${value}s`
        : `${Math.round(value / 60)}m`;

  return (
    <>
      <PageHeader title="Dashboard" description={`Signed in as ${user?.name ?? user?.username}.`} />

      {/* Anything genuinely wrong goes first, above even the numbers. */}
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

      {/* ============================================================================ TIER 1 — NUMBERS
          Every count the dashboard has, grouped by what it's counting, in the order an operator
          reaches for it: this week's conversation figures, then group operations for a chosen
          window, then what the pattern detector has found. Nothing numeric lives further down the
          page than this. */}
      {canSeeReports && (
        <div className="stack" style={{ gap: 22 }}>
          {reportError && <ErrorState message={reportError} onRetry={() => void loadReport()} icon={<IconAlertCircle size={20} />} />}
          {!report && !reportError && <Loading label="Counting the last seven days…" />}

          {report && (
            <div>
              <h2 className="section-title" style={{ marginBottom: 10 }}>
                This week
              </h2>
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
            </div>
          )}

          <div>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2 className="section-title">Group operations · last {days} days</h2>
              <div className="row" style={{ gap: 4 }}>
                {OPERATIONS_WINDOWS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={days === option ? 'page-tab active' : 'page-tab'}
                    onClick={() => setDays(option)}
                  >
                    {option}d
                  </button>
                ))}
              </div>
            </div>
            {ops.failure && <ErrorState message={ops.failure} onRetry={() => void ops.reload()} icon={<IconAlertCircle size={20} />} />}
            {!ops.data && ops.loading && <Loading label="Loading operations metrics…" />}
            {ops.data && (
              <StatGrid>
                <Stat label="Total groups" value={ops.data.coverage.totalGroups} />
                <Stat label="Monitored" value={ops.data.coverage.monitored} hint="Collecting messages" />
                <Stat label="AI configured" value={ops.data.coverage.aiConfigured} hint="Group switch on" />
                <Stat
                  label="AI supported today"
                  value={ops.data.today.ai.groups}
                  hint={`${ops.data.today.ai.replies.toLocaleString()} replies`}
                />
                <Stat
                  label="Human supported today"
                  value={ops.data.today.human.groups}
                  hint={`${ops.data.today.human.replies.toLocaleString()} messages`}
                />
                <Stat label="Support members active" value={ops.activeMembers} hint="Replied today" />
                <Stat
                  label="AI support"
                  value={ops.data.window.ai.replies}
                  hint={`across ${ops.data.window.ai.groups.toLocaleString()} groups`}
                />
                <Stat
                  label="Human support"
                  value={ops.data.window.human.replies}
                  hint={`across ${ops.data.window.human.groups.toLocaleString()} groups`}
                />
              </StatGrid>
            )}
          </div>

          {patterns && patterns.summary.total > 0 && (
            <div>
              <h2 className="section-title" style={{ marginBottom: 10 }}>
                Pattern detection
              </h2>
              <StatGrid>
                <Stat
                  label="Detected"
                  value={patterns.summary.total}
                  hint={`${patterns.summary.groupsContributing} groups contributing`}
                  icon={<IconLightbulb size={17} />}
                  iconColor="accent"
                />
                <Stat
                  label="Pending review"
                  value={patterns.summary.pending}
                  tone={patterns.summary.pending > 0 ? 'warn' : 'ok'}
                  icon={<IconClock size={17} />}
                  iconColor={patterns.summary.pending > 0 ? 'warn' : 'ok'}
                />
                <Stat
                  label="Published as rules"
                  value={patterns.summary.published}
                  tone="ok"
                  icon={<IconCheckCircle size={17} />}
                  iconColor="ok"
                />
              </StatGrid>
            </div>
          )}
        </div>
      )}

      {/* ============================================================================= TIER 2 — LISTS
          Everything an operator reads row by row. Capped at five apiece — a panel that wants to show
          more says so with a link to the page that owns the full list, not by growing. */}
      <div className="stack" style={{ gap: 14, marginTop: 26 }}>
        <div className="grid-2">
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

          {ops.data && <AiStatus coverage={ops.data.coverage} blocks={ops.aiBlocks} repliesToday={ops.data.today.ai.replies} days={days} />}
        </div>

        <div className="grid-2">
          <Card
            title="WhatsApp accounts"
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
                icon={<IconRadio size={20} />}
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
                  {accounts.slice(0, LIST_LIMIT).map((account) => (
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
                {accounts.length > LIST_LIMIT && (
                  <Link to="/channels/whatsapp" className="small">
                    {accounts.length - LIST_LIMIT} more →
                  </Link>
                )}
              </div>
            )}
          </Card>

          {canSeeAudit && (
            <Card title="Recent activity">
              {!activity ? (
                <Loading label="Loading…" />
              ) : activity.length === 0 ? (
                <Empty title="Nothing recorded yet" hint="Actions people take appear here." icon={<IconClock size={20} />} />
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
        </div>

        <div className="grid-2">
          <Card title="System health">
            {!system ? (
              <Loading label="Checking…" />
            ) : (
              <div className="rowlist">
                {Object.entries(system.components)
                  .slice(0, LIST_LIMIT)
                  .map(([name, component]) => (
                    <div key={name} className="rowlist-item">
                      <div className="rowlist-body">
                        <div className="rowlist-text">{humanise(name)}</div>
                        {component.detail && <div className="rowlist-sub">{component.detail}</div>}
                      </div>
                      <Badge
                        tone={component.status === 'HEALTHY' ? 'ok' : component.status === 'WARNING' ? 'warn' : 'bad'}
                      >
                        {humanise(component.status)}
                      </Badge>
                    </div>
                  ))}
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

        {opsReady && (
          <div className="grid-2">
            <Card title="Most active groups">
              {ops.data!.topGroups.length === 0 ? (
                <Empty title="No group activity in this window." />
              ) : (
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>Group</th>
                        <th className="num">Messages</th>
                        <th>Last activity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ops.data!.topGroups.slice(0, LIST_LIMIT).map((group) => (
                        <tr key={group.groupId}>
                          <td>
                            <Link to={`/groups/${group.groupId}`}>{group.name ?? 'Unnamed group'}</Link>
                          </td>
                          <td className="num">{group.messages.toLocaleString()}</td>
                          <td className="nowrap muted small">
                            <OpsRelativeTime value={group.lastMessageAt} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>

            <Card title="Support member leaderboard">
              {ops.members.length === 0 ? (
                <Empty
                  title="No support members registered."
                  hint="Register a colleague's number to count their replies as human support."
                />
              ) : (
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th className="num">Groups 30d</th>
                        <th>Last reply</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...ops.members]
                        .sort(
                          (a, b) =>
                            b.groups30d - a.groups30d ||
                            b.replies30d - a.replies30d ||
                            a.displayName.localeCompare(b.displayName),
                        )
                        .slice(0, LIST_LIMIT)
                        .map((member) => (
                          <tr key={member.id}>
                            <td>
                              <Link to={`/support-members/${member.id}`}>{member.displayName}</Link>
                            </td>
                            <td className="num">{member.groups30d}</td>
                            <td className="nowrap muted small">
                              <OpsRelativeTime value={member.lastReplyAt} />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </div>
        )}

        {patterns && patterns.items.length > 0 && (
          <div className="grid-2">
            <Card
              title="Top patterns"
              actions={
                <Link to="/automation/candidates" className="small">
                  Review →
                </Link>
              }
            >
              <div className="rowlist">
                {patterns.items.slice(0, LIST_LIMIT).map((pattern) => (
                  <div key={pattern.candidateId} className="rowlist-item">
                    <span className="rowlist-chip tone-accent">{pattern.occurrences}×</span>
                    <div className="rowlist-body">
                      <div className="rowlist-text">{pattern.title}</div>
                      <div className="rowlist-sub">
                        {pattern.groupName ?? 'Multiple groups'} · {humanise(pattern.status)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* ============================================================================ TIER 3 — CHARTS
          The slower read: three breakdowns side by side, then the trend lines and coverage bars
          underneath. Nothing here is a number standing alone — every chart already has its figures
          in the tiers above it, so this tier is purely "what does the shape look like". */}
      <div className="stack" style={{ gap: 14, marginTop: 26 }}>
        <h2 className="section-title">Breakdowns</h2>
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
              <Donut
                centerLabel="Conversations"
                segments={Object.entries(report.conversations.byStatus)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => ({ label: humanise(status).toLowerCase(), value: count }))}
              />
            </Card>
          )}

          {report && Object.keys(report.escalations.byReason).length > 0 && (
            <Card
              title="Escalation reasons"
              actions={
                <Link to="/escalations" className="small">
                  Queue →
                </Link>
              }
            >
              <Donut
                centerLabel="Escalations"
                segments={Object.entries(report.escalations.byReason)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => ({ label: humanise(reason).toLowerCase(), value: count }))}
              />
            </Card>
          )}
        </div>

        <div className="dash-cols-even">
          {canSeeReports && (
            <Card title="Activity · last 7 days">
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

          {opsReady && (
            <Card title={`AI vs human replies · last ${days} days`}>
              {ops.data!.window.ai.replies === 0 && ops.data!.window.human.replies === 0 ? (
                <Empty title="No AI or human support activity in this window." />
              ) : (
                <TrendChart
                  points={ops.data!.daily.map((day) => ({ day: day.day, ai: day.aiReplies, human: day.humanReplies }))}
                  series={[
                    { key: 'ai', label: 'AI replies', color: 'var(--accent)' },
                    { key: 'human', label: 'Human replies', color: 'var(--ok)' },
                  ]}
                  height={210}
                />
              )}
            </Card>
          )}

          {opsReady && (
            <Card title={`Unique groups reached · last ${days} days`}>
              {ops.data!.daily.every((day) => day.aiGroups === 0 && day.humanGroups === 0) ? (
                <Empty title="No groups were supported in this window." />
              ) : (
                <TrendChart
                  points={ops.data!.daily.map((day) => ({ day: day.day, ai: day.aiGroups, human: day.humanGroups }))}
                  series={[
                    { key: 'ai', label: 'Groups AI supported', color: 'var(--accent)' },
                    { key: 'human', label: 'Groups humans supported', color: 'var(--ok)' },
                  ]}
                  height={210}
                />
              )}
            </Card>
          )}

          {opsReady && (
            <Card title="Group coverage">
              <p className="muted small">
                Groups whose own switch is on. A group counted here can still be withheld an AI reply by its
                profile, its monitoring state, or an emergency stop.
              </p>
              <CoverageBar label="Monitoring" value={ops.data!.coverage.monitored} total={ops.data!.coverage.totalGroups} />
              <CoverageBar label="AI configured" value={ops.data!.coverage.aiConfigured} total={ops.data!.coverage.totalGroups} />
              <CoverageBar
                label="Automation"
                value={ops.data!.coverage.automationConfigured}
                total={ops.data!.coverage.totalGroups}
              />
              <CoverageBar
                label="Pattern analysis"
                value={ops.data!.coverage.patternAnalysis}
                total={ops.data!.coverage.totalGroups}
              />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
