import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  support,
  type SupportDay,
  type SupportGroupBreakdown,
  type SupportMemberRow,
} from '../../api/client';
import { IconRefresh } from '../../components/icons';
import { MemberActivity } from './member-activity';
import {
  Card,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  RelativeTime,
  Stat,
  StatGrid,
  TableWrap,
  TrendChart,
  errorMessage,
} from '../../components/ui';

const WINDOWS = [7, 30, 90];

/**
 * One support member's activity.
 *
 * The group breakdown names the groups rather than counting them. "You replied in 6 groups" is not
 * something a person can check; "you replied in Admissions candidate, Learn German, …" is, and it
 * is what makes the number auditable by the person it describes.
 */
export function SupportMemberDetailPage() {
  const { id = '' } = useParams();

  const [member, setMember] = useState<SupportMemberRow | null>(null);
  const [daily, setDaily] = useState<SupportDay[]>([]);
  const [groups, setGroups] = useState<SupportGroupBreakdown[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      // The roster carries the member's own details; there is no per-member endpoint to duplicate it.
      const [roster, dailyResult, groupResult] = await Promise.all([
        support.members(true),
        support.memberDaily(id, days),
        support.memberGroups(id, days),
      ]);
      setMember(roster.items.find((row) => row.id === id) ?? null);
      setDaily(dailyResult.items);
      setGroups(groupResult.items);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load this member.'));
    } finally {
      setLoading(false);
    }
  }, [id, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !member) return <Loading label="Loading member…" />;
  if (failure) return <ErrorState message={failure} onRetry={() => void load()} />;
  if (!member) {
    return (
      <div className="stack">
        <PageHeader title="Support member" />
        <Empty title="This member is no longer registered." />
      </div>
    );
  }

  const repliesInWindow = daily.reduce((sum, day) => sum + day.replies, 0);

  return (
    <div className="stack">
      <PageHeader
        title={member.displayName}
        description={`${member.phone}${member.jobRole ? ` · ${member.jobRole}` : ''}`}
        actions={
          <>
            <Link className="page-tab" to="/support-members">
              All members
            </Link>
            <button type="button" onClick={() => void load()}>
              <IconRefresh size={15} /> Refresh
            </button>
          </>
        }
      />

      <div className="row">
        {WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            className={days === option ? 'page-tab active' : 'page-tab'}
            onClick={() => setDays(option)}
          >
            Last {option} days
          </button>
        ))}
      </div>

      <StatGrid>
        <Stat label={`Replies · ${days}d`} value={repliesInWindow} hint="Messages sent" />
        <Stat label={`Groups · ${days}d`} value={groups.length} hint="Distinct groups replied in" />
        <Stat label="Replies today" value={member.repliesToday} />
        <Stat
          label="Last reply"
          value={member.lastReplyAt ? '' : '—'}
          hint={member.lastReplyAt ? undefined : 'No replies recorded'}
        />
      </StatGrid>

      <Card title={`Replies per day · last ${days} days`}>
        {repliesInWindow === 0 ? (
          <Empty
            title="No replies recorded in this window."
            hint="Only messages sent after this member was registered are counted."
          />
        ) : (
          <TrendChart
            points={daily.map((day) => ({ day: day.day, replies: day.replies, groups: day.groups }))}
            series={[
              { key: 'replies', label: 'Replies', color: 'var(--accent)' },
              { key: 'groups', label: 'Groups', color: 'var(--ok)' },
            ]}
          />
        )}
      </Card>

      <MemberActivity memberId={member.id} />

      <Card title={`Groups helped · ${groups.length}`}>
        {groups.length === 0 ? (
          <Empty title="No groups in this window." />
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th className="num">Replies</th>
                  <th>Last reply</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((row) => (
                  <tr key={row.groupId ?? row.groupName}>
                    <td>
                      {row.groupId ? (
                        <Link to={`/groups/${row.groupId}`}>{row.groupName}</Link>
                      ) : (
                        <span className="muted">{row.groupName}</span>
                      )}
                    </td>
                    <td className="num">{row.replies}</td>
                    <td className="nowrap">
                      <RelativeTime value={row.lastReplyAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
