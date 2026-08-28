import { useCallback, useEffect, useState } from 'react';
import {
  reports,
  type ActivityTrendPoint,
  type AiPerformanceReport,
  type BroadcastReportRow,
  type DashboardReport,
  type TeamPerformanceRow,
} from '../api/client';
import { useAuth } from '../auth-context';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Donut,
  Stat,
  StatGrid,
  TableWrap,
  TrendChart,
  errorMessage,
  humanise,
  useToast,
} from '../components/ui';

type Tab = 'overview' | 'team' | 'ai' | 'broadcasts' | 'gaps';

const RANGES = [
  { label: 'Last 24 hours', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

/**
 * Reporting (`PROJECT_SPEC.md` §100–§106).
 *
 * Every figure here is counted from raw rows at query time, and the screen is careful to preserve
 * one distinction the API makes: **null is not zero**. An automation rate over no decisions is
 * undefined, not 0%, and rendering a dash rather than a number is the difference between "nothing
 * has happened yet" and "everything is failing".
 */
export function ReportsPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dashboard, setDashboard] = useState<DashboardReport | null>(null);
  const [team, setTeam] = useState<TeamPerformanceRow[]>([]);
  const [ai, setAi] = useState<AiPerformanceReport | null>(null);
  const [campaigns, setCampaigns] = useState<BroadcastReportRow[]>([]);
  const [gaps, setGaps] = useState<Array<{ detail: string | null; count: number }>>([]);
  const [issues, setIssues] = useState<Array<{ reason: string; count: number }>>([]);
  const [trend, setTrend] = useState<ActivityTrendPoint[] | null>(null);

  const window = useCallback(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const range = window();
      const [dash, teamRows, aiReport, campaignRows, gapRows, issueRows, trendRows] = await Promise.all([
        reports.dashboard(range),
        reports.team(range),
        reports.aiPerformance(range),
        reports.broadcasts(range),
        reports.knowledgeGaps(range),
        reports.topIssues(range),
        reports.activityTrend(range),
      ]);

      setTrend(trendRows.items);
      setDashboard(dash);
      setTeam(teamRows.items);
      setAi(aiReport);
      setCampaigns(campaignRows.items);
      setGaps(gapRows.items);
      setIssues(issueRows.items);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'Those reports could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => {
    void load();
  }, [load]);

  function download(report: string) {
    // A plain navigation rather than fetch-and-blob: the session cookie goes with it, the browser
    // owns the download, and a 50k-row CSV never lands in JavaScript memory.
    globalThis.location.href = reports.exportUrl(report, window());
    toast.info('Preparing your download…');
  }

  const seconds = (value: number | null) =>
    value === null ? null : value < 90 ? `${value}s` : `${Math.round(value / 60)}m`;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Counted from what actually happened, at the moment you ask. A dash means the figure cannot be computed yet — which is not the same as zero."
        actions={
          can('reports.export') ? (
            <>
              <button type="button" onClick={() => download('conversations')}>
                Export conversations
              </button>
              <button type="button" onClick={() => download('decisions')}>
                Export decisions
              </button>
            </>
          ) : null
        }
      />

      <div className="toolbar">
        <Field label="Range">
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {RANGES.map((range) => (
              <option key={range.days} value={range.days}>
                {range.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="spacer" />
        <div className="chip-row">
          {(['overview', 'team', 'ai', 'broadcasts', 'gaps'] as Tab[]).map((name) => (
            <button
              key={name}
              type="button"
              className={tab === name ? 'primary' : undefined}
              onClick={() => setTab(name)}
            >
              {name === 'ai' ? 'AI' : humanise(name)}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading && !dashboard && <Loading label="Counting…" />}

      {tab === 'overview' && dashboard && (
        <div className="stack">
          <StatGrid>
            <Stat label="Conversations" value={dashboard.conversations.total} />
            <Stat label="Handled by a person" value={dashboard.conversations.humanHandled} />
            <Stat label="Decisions" value={dashboard.decisions.total} />
            <Stat
              label="Answered automatically"
              value={
                dashboard.decisions.automationRate === null
                  ? null
                  : `${Math.round(dashboard.decisions.automationRate * 100)}%`
              }
              hint={
                dashboard.decisions.automationRate === null
                  ? 'No decisions in this range'
                  : `${dashboard.decisions.answeredAutomatically} of ${dashboard.decisions.total}`
              }
              tone={dashboard.decisions.automationRate === null ? undefined : 'ok'}
            />
            <Stat
              label="Escalations"
              value={dashboard.escalations.total}
              hint={`${dashboard.escalations.openNow} open now`}
              tone={dashboard.escalations.openNow > 0 ? 'warn' : undefined}
            />
            <Stat
              label="First response"
              value={seconds(dashboard.timing.firstResponseSeconds)}
              hint="Average, excluding conversations nobody has answered"
            />
            <Stat label="Resolution time" value={seconds(dashboard.timing.resolutionSeconds)} />
            <Stat
              label="Failed jobs"
              value={dashboard.health.failedJobs}
              tone={dashboard.health.failedJobs > 0 ? 'bad' : 'ok'}
            />
          </StatGrid>

          {trend && trend.length > 0 && (
            <div style={{ marginTop: 'var(--space-6)' }}>
              <Card title="Activity over time" actions={<span className="muted small">Counted per day</span>}>
                <TrendChart
                  points={trend as unknown as Array<Record<string, string | number>>}
                  series={[
                    { key: 'conversations', label: 'Conversations', color: 'var(--blue)' },
                    { key: 'automated', label: 'Answered automatically', color: 'var(--ok)' },
                    { key: 'escalations', label: 'Escalated', color: 'var(--danger)' },
                  ]}
                />
              </Card>
            </div>
          )}

          <div className="split" style={{ marginTop: 'var(--space-6)' }}>
            <Card title="Decisions by outcome">
              {Object.keys(dashboard.decisions.byOutcome).length === 0 ? (
                <Empty title="No decisions in this range" hint="Nothing has come in, or automation has not been switched on for any conversation yet." />
              ) : (
                <Donut
                  centerLabel="Decisions"
                  segments={Object.entries(dashboard.decisions.byOutcome)
                    .sort((a, b) => b[1] - a[1])
                    .map(([outcome, count]) => ({ label: humanise(outcome), value: count }))}
                />
              )}
            </Card>

            <Card title="Why conversations reached a person">
              {Object.keys(dashboard.escalations.byReason).length === 0 ? (
                <Empty title="No escalations" hint="Nothing needed a human in this range." />
              ) : (
                <TableWrap>
                  <table>
                    <tbody>
                      {Object.entries(dashboard.escalations.byReason)
                        .sort((a, b) => b[1] - a[1])
                        .map(([reason, count]) => (
                          <tr key={reason}>
                            <td>{humanise(reason)}</td>
                            <td style={{ textAlign: 'right' }}>{count}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </div>

          <Card title="What customers needed most">
            {issues.length === 0 ? (
              <Empty title="Nothing to rank yet" hint="Top issues are grouped by the reason each decision recorded." />
            ) : (
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th style={{ textAlign: 'right' }}>Times</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((issue) => (
                      <tr key={issue.reason}>
                        <td>{humanise(issue.reason)}</td>
                        <td style={{ textAlign: 'right' }}>{issue.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </div>
      )}

      {tab === 'team' && (
        <Card
          title="Team performance"
          actions={
            can('reports.export') ? (
              <button type="button" onClick={() => download('conversations')}>
                Export
              </button>
            ) : null
          }
        >
          <p className="muted small">
            Deliberately not message count. Counting messages rewards five short replies over one
            that solved the problem, and every support team learns to game it within a month.
          </p>
          {team.length === 0 ? (
            <Empty title="Nobody has been assigned a conversation yet" hint="Assign one from the inbox and it will appear here." />
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Conversations</th>
                    <th>Resolved</th>
                    <th>Groups</th>
                    <th>Customers</th>
                    <th>Active days</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((row) => (
                    <tr key={row.userId ?? row.name ?? 'unknown'}>
                      <td>{row.name ?? 'Unknown'}</td>
                      <td>{row.conversations}</td>
                      <td>{row.resolved}</td>
                      <td>{row.groupsSupported}</td>
                      <td>{row.uniqueCustomers}</td>
                      <td>{row.activeDays}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {tab === 'ai' && ai && (
        <div className="stack">
          <Card title="AI outcomes">
            {Object.keys(ai.byOutcome).length === 0 ? (
              <Empty
                title="The AI has not answered anything in this range"
                hint="Either no provider is configured, or nothing reached the AI stage."
              />
            ) : (
              <div className="stack">
                {/* The ring shows the split; the table keeps the timings, which a ring cannot carry. */}
                <Donut
                  centerLabel="AI answers"
                  segments={Object.entries(ai.byOutcome).map(([outcome, value]) => ({
                    label: humanise(outcome),
                    value: value.count,
                  }))}
                />
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>Outcome</th>
                        <th>Count</th>
                        <th>Average time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(ai.byOutcome).map(([outcome, value]) => (
                        <tr key={outcome}>
                          <td>{humanise(outcome)}</td>
                          <td>{value.count}</td>
                          <td>{value.averageMs === null ? '—' : `${value.averageMs} ms`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>
            )}
          </Card>

          <Card title="Human verdicts on AI answers">
            <p className="muted small">{ai.note}</p>
            {Object.keys(ai.humanVerdicts).length === 0 ? (
              <Empty title="No agent has reviewed an AI answer yet" hint="Verdicts are recorded from the conversation view." />
            ) : (
              <div className="chip-row">
                {Object.entries(ai.humanVerdicts).map(([verdict, count]) => (
                  <Badge
                    key={verdict}
                    tone={verdict === 'CORRECT' ? 'ok' : verdict === 'WRONG' ? 'bad' : 'warn'}
                  >
                    {humanise(verdict)}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'broadcasts' && (
        <Card title="Campaigns">
          {campaigns.length === 0 ? (
            <Empty title="No campaigns in this range" hint="Broadcast outcomes are counted per recipient, not from a running total." />
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Status</th>
                    <th>Sent</th>
                    <th>Failed</th>
                    <th>Skipped</th>
                    <th>Success</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>
                        <Badge tone={row.status === 'COMPLETED' ? 'ok' : row.status === 'FAILED' ? 'bad' : 'busy'}>
                          {humanise(row.status)}
                        </Badge>
                      </td>
                      <td>{row.sent}</td>
                      <td>{row.failed}</td>
                      <td>{row.skipped}</td>
                      <td>{row.successRate === null ? '—' : `${Math.round(row.successRate * 100)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {tab === 'gaps' && (
        <Card title="Where the knowledge base fell short">
          <p className="muted small">
            Questions that reached a person because nothing published could answer them. Each one is
            an article worth writing.
          </p>
          {gaps.length === 0 ? (
            <Empty
              title="No knowledge gaps recorded"
              hint="Either the knowledge base covered everything asked, or the AI path has not run in this range."
            />
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>What was missing</th>
                    <th style={{ textAlign: 'right' }}>Times</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((gap, index) => (
                    <tr key={`${gap.detail}-${index}`}>
                      <td>{gap.detail ?? 'Not recorded'}</td>
                      <td style={{ textAlign: 'right' }}>{gap.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </>
  );
}
