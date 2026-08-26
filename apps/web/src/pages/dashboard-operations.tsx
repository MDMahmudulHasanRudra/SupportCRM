import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { operationsReports, support, type OperationsDashboard, type SupportMemberRow } from '../api/client';
import {
  Card,
  Empty,
  ErrorState,
  Loading,
  RelativeTime,
  Stat,
  StatGrid,
  TableWrap,
  TrendChart,
  errorMessage,
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
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const [operations, roster] = await Promise.all([
        operationsReports.dashboard(days),
        // Best-effort: this needs `team.manage`, which a reports-only user may not have. The rest of
        // the section is still worth showing to them.
        support.members().catch(() => ({ items: [] as SupportMemberRow[] })),
      ]);
      setData(operations);
      setMembers(roster.items);
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

        <Card title="Support members">
          {members.length === 0 ? (
            <Empty
              title="No support members registered."
              hint="Until a colleague's number is registered, their replies cannot be told apart from a customer's and are not counted as human support."
            />
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th className="num">Groups today</th>
                    <th className="num">Replies today</th>
                    <th>Last reply</th>
                  </tr>
                </thead>
                <tbody>
                  {members.slice(0, 10).map((member) => (
                    <tr key={member.id}>
                      <td>
                        <Link to={`/support-members/${member.id}`}>{member.displayName}</Link>
                      </td>
                      <td className="num">{member.groupsToday}</td>
                      <td className="num">{member.repliesToday}</td>
                      <td className="nowrap muted small">
                        <RelativeTime value={member.lastReplyAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
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
 * A proportion bar.
 *
 * Shows the count and the total beside the percentage: "64%" of an unknown denominator is not a
 * fact an operator can act on, and 64% of 9 groups reads very differently from 64% of 3,000.
 */
function CoverageBar({ label, value, total }: { label: string; value: number; total: number }) {
  // Zero groups is a real state, not a division to guess at.
  const percent = total === 0 ? 0 : Math.round((value / total) * 100);

  return (
    <div className="coverage">
      <div className="coverage-head">
        <span>{label}</span>
        <span className="muted small">
          {value.toLocaleString()} of {total.toLocaleString()} · {percent}%
        </span>
      </div>
      <div className="coverage-track">
        <div className="coverage-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
