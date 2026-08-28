import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  audit,
  health as healthApi,
  reports,
  whatsapp,
  type ActivityTrendPoint,
  type AuditEntry,
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
  IconMessageCircle,
  IconRadio,
  IconSend,
} from '../components/icons';
import {
  Badge,
  Card,
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
  }, [loadAccounts, loadReport, loadSystem, loadActivity]);

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
    </>
  );
}
