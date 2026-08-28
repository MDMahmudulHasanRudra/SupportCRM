import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  activityAnalytics,
  operationsReports,
  support,
  type AiBlockRow,
  type OperationsDashboard,
  type SupportMemberRow,
} from '../api/client';
import {
  Badge,
  Card,
  CoverageBar,
  Empty,
  ErrorState,
  Loading,
  RelativeTime,
  Stat,
  StatGrid,
  TableWrap,
  TrendChart,
  errorMessage,
  humanise,
} from '../components/ui';

const WINDOWS = [7, 14, 30];

/**
 * The operations half of the dashboard: groups, AI, and human support.
 *
 * ## Replies and groups are shown as different numbers
 *
 * Every activity figure appears twice — how many messages, and how many distinct groups those
 * messages reached. They are counted separately in SQL and displayed separately here, because a
 * hundred AI replies in one group is not the same as reaching a hundred groups, and showing only
 * the first invites exactly that misreading.
 *
 * ## "Configured" is not "will reply"
 *
 * The coverage bars count groups whose own switch is on. Monitoring state, an automation profile,
 * an emergency stop or a dropped session can each still withhold an AI reply, so the label says
 * "AI configured" and the per-group screen is where the effective answer lives. Naming this bar
 * "AI enabled" would be a claim the number does not support.
 *
 * ## Empty means empty
 *
 * Every figure is an aggregate over rows that exist. When there is no activity the cards read zero
 * and the charts say so, rather than rendering a plausible-looking line.
 */
export function DashboardOperations() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<OperationsDashboard | null>(null);
  const [members, setMembers] = useState<SupportMemberRow[]>([]);
  const [aiBlocks, setAiBlocks] = useState<AiBlockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const [operations, roster, blocks] = await Promise.all([
        operationsReports.dashboard(days),
        // Best-effort: this needs `team.manage`, which a reports-only user may not have. The rest of
        // the section is still worth showing to them.
        support.members().catch(() => ({ items: [] as SupportMemberRow[] })),
        activityAnalytics.aiBlocks(days).catch(() => ({ items: [] as AiBlockRow[] })),
      ]);
      setData(operations);
      setMembers(roster.items);
      setAiBlocks(blocks.items);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load operations metrics.'));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <Loading label="Loading operations metrics…" />;
  if (failure) return <ErrorState message={failure} onRetry={() => void load()} />;
  if (!data) return null;

  const { coverage, today, window, daily, topGroups } = data;
  const activeMembers = members.filter((member) => member.repliesToday > 0).length;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="section-title">Group operations</h2>
        <div className="row" style={{ gap: 4 }}>
          {WINDOWS.map((option) => (
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

      <AiStatus coverage={coverage} blocks={aiBlocks} repliesToday={today.ai.replies} days={window.days} />

      <StatGrid>
        <Stat label="Total groups" value={coverage.totalGroups} />
        <Stat label="Monitored" value={coverage.monitored} hint="Collecting messages" />
        <Stat label="AI configured" value={coverage.aiConfigured} hint="Group switch on" />
        <Stat
          label="AI supported today"
          value={today.ai.groups}
          hint={`${today.ai.replies.toLocaleString()} replies`}
        />
        <Stat
          label="Human supported today"
          value={today.human.groups}
          hint={`${today.human.replies.toLocaleString()} messages`}
        />
        <Stat label="Support members active" value={activeMembers} hint="Replied today" />
      </StatGrid>

      <div className="grid-2">
        <Card title={`AI vs human · last ${window.days} days`}>
          {window.ai.replies === 0 && window.human.replies === 0 ? (
            <Empty
              title="No AI or human support activity in this window."
              hint="Human support is only counted for registered support members."
            />
          ) : (
            <>
              <div className="versus">
                <Versus
                  label="AI support"
                  replies={window.ai.replies}
                  groups={window.ai.groups}
                  tone="accent"
                />
                <Versus
                  label="Human support"
                  replies={window.human.replies}
                  groups={window.human.groups}
                  tone="ok"
                />
              </div>
              <TrendChart
                points={daily.map((day) => ({
                  day: day.day,
                  ai: day.aiReplies,
                  human: day.humanReplies,
                }))}
                series={[
                  { key: 'ai', label: 'AI replies', color: 'var(--accent)' },
                  { key: 'human', label: 'Human replies', color: 'var(--ok)' },
                ]}
              />
            </>
          )}
        </Card>

        <Card title="Group coverage">
          <p className="muted small">
            Groups whose own switch is on. A group counted here can still be withheld an AI reply by
            its profile, its monitoring state, or an emergency stop.
          </p>
          <CoverageBar label="Monitoring" value={coverage.monitored} total={coverage.totalGroups} />
          <CoverageBar label="AI configured" value={coverage.aiConfigured} total={coverage.totalGroups} />
          <CoverageBar
            label="Automation"
            value={coverage.automationConfigured}
            total={coverage.totalGroups}
          />
          <CoverageBar
            label="Pattern analysis"
            value={coverage.patternAnalysis}
            total={coverage.totalGroups}
          />
        </Card>
      </div>

      <Card title={`Unique groups reached · last ${window.days} days`}>
        {daily.every((day) => day.aiGroups === 0 && day.humanGroups === 0) ? (
          <Empty title="No groups were supported in this window." />
        ) : (
          <>
            <p className="muted small">
              Distinct groups per day, not message counts. These do not add up across the window — a
              group helped on two days is one group, counted once on each.
            </p>
            <TrendChart
              points={daily.map((day) => ({
                day: day.day,
                ai: day.aiGroups,
                human: day.humanGroups,
              }))}
              series={[
                { key: 'ai', label: 'Groups AI supported', color: 'var(--accent)' },
                { key: 'human', label: 'Groups humans supported', color: 'var(--ok)' },
              ]}
            />
          </>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Most active groups">
          {topGroups.length === 0 ? (
            <Empty title="No group activity in this window." />
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Group</th>
                    <th className="num">Messages</th>
                    <th className="num">AI</th>
                    <th className="num">Human</th>
                    <th>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {topGroups.map((group) => (
                    <tr key={group.groupId}>
                      <td>
                        <Link to={`/groups/${group.groupId}`}>{group.name ?? 'Unnamed group'}</Link>
                      </td>
                      <td className="num">{group.messages.toLocaleString()}</td>
                      <td className="num">{group.aiReplies.toLocaleString()}</td>
                      <td className="num">{group.humanSupport.toLocaleString()}</td>
                      <td className="nowrap muted small">
                        <RelativeTime value={group.lastMessageAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Support member leaderboard">
          {members.length === 0 ? (
            <Empty
              title="No support members registered."
              hint="Until a colleague's number is registered, their replies cannot be told apart from a customer's and are not counted as human support."
            />
          ) : (
            <>
              <p className="muted small">
                Ranked by groups helped over 30 days, not by message count — helping eight groups is
                broader work than sending eight messages into one.
              </p>
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th className="num">Groups 30d</th>
                      <th className="num">Replies 30d</th>
                      <th className="num">Today</th>
                      <th>Last reply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...members]
                      .sort(
                        (a, b) =>
                          b.groups30d - a.groups30d ||
                          b.replies30d - a.replies30d ||
                          a.displayName.localeCompare(b.displayName),
                      )
                      .slice(0, 10)
                      .map((member) => (
                        <tr key={member.id}>
                          <td>
                            <Link to={`/support-members/${member.id}`}>{member.displayName}</Link>
                            {!member.isActive && <div className="muted small">Inactive</div>}
                          </td>
                          <td className="num">{member.groups30d}</td>
                          <td className="num">{member.replies30d}</td>
                          <td className="num">
                            {member.groupsToday > 0 || member.repliesToday > 0
                              ? `${member.groupsToday} / ${member.repliesToday}`
                              : '—'}
                          </td>
                          <td className="nowrap muted small">
                            <RelativeTime value={member.lastReplyAt} />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

/** One side of the AI-versus-human comparison: both figures, never one standing for the other. */
function Versus({
  label,
  replies,
  groups,
  tone,
}: {
  label: string;
  replies: number;
  groups: number;
  tone: 'accent' | 'ok';
}) {
  return (
    <div className={`versus-side versus-${tone}`}>
      <div className="muted small">{label}</div>
      <div className="versus-value">{replies.toLocaleString()}</div>
      <div className="muted small">
        {replies === 1 ? 'reply' : 'replies'} across {groups.toLocaleString()}{' '}
        {groups === 1 ? 'group' : 'groups'}
      </div>
    </div>
  );
}

/**
 * Whether AI is actually doing anything, and if not, why.
 *
 * "AI: ACTIVE" because a service is running is the claim worth avoiding — the process being up says
 * nothing about whether a single customer can receive a reply. Active here means the estate is
 * configured for it *and* it has replied today. Anything else is reported as what it is, with the
 * reason drawn from the engine's own recorded decisions rather than guessed at.
 *
 * The blocks are `decision_logs` rows: each one is a time the engine declined and wrote down why.
 */
function AiStatus({
  coverage,
  blocks,
  repliesToday,
  days,
}: {
  coverage: { totalGroups: number; aiConfigured: number; aiDisabled: number };
  blocks: AiBlockRow[];
  repliesToday: number;
  days: number;
}) {
  const configured = coverage.aiConfigured > 0;
  const active = configured && repliesToday > 0;

  // The most common recorded reason, which is the one worth naming first.
  const topBlock = [...blocks].sort((a, b) => b.events - a.events)[0] ?? null;

  const explanation = !configured
    ? `No group has AI switched on. ${coverage.aiDisabled} of ${coverage.totalGroups} have it off.`
    : active
      ? `AI replied ${repliesToday} time${repliesToday === 1 ? '' : 's'} today across the estate.`
      : `${coverage.aiConfigured} group${coverage.aiConfigured === 1 ? ' has' : 's have'} AI switched on, but it has not replied today.`;

  return (
    <Card>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone={active ? 'ok' : configured ? 'warn' : 'neutral'}>
          {active ? 'AI active' : configured ? 'AI idle' : 'AI inactive'}
        </Badge>
        <span className="small">{explanation}</span>
      </div>

      {topBlock && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Most common reason AI did not answer in the last {days} days:{' '}
          <strong>{humanise(topBlock.reasonCode)}</strong> ({topBlock.events} time
          {topBlock.events === 1 ? '' : 's'}
          {topBlock.uniqueGroups > 0 &&
            `, across ${topBlock.uniqueGroups} group${topBlock.uniqueGroups === 1 ? '' : 's'}`}
          ).
        </p>
      )}
    </Card>
  );
}
