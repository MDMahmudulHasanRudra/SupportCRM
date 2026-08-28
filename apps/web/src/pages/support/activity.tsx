import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { support, type SupportDayMember, type SupportTeamDay } from '../../api/client';
import { IconAlertCircle, IconMessageCircle, IconRefresh, IconUsers } from '../../components/icons';
import {
  Card,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  Stat,
  StatGrid,
  TableWrap,
  TrendChart,
  errorMessage,
} from '../../components/ui';

const WINDOWS = [7, 30, 90];

/**
 * Team-wide support activity, day by day.
 *
 * ## Three figures, three counts
 *
 * Replies, groups and people are counted separately in SQL and are never derived from one another.
 * Twenty replies might be one person in one group all afternoon, or six people across nine groups,
 * and the difference is the entire point of the screen.
 *
 * ## A day is answerable, not just a number
 *
 * Picking a day loads who replied and in which groups, by name. A bar chart nobody can drill into
 * invites the reader to invent an explanation for a spike; naming the people and the groups means
 * the answer comes from the data.
 */
export function SupportActivityPage() {
  const [items, setItems] = useState<SupportTeamDay[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayMembers, setDayMembers] = useState<SupportDayMember[] | null>(null);
  const [dayLoading, setDayLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setItems((await support.activity(days)).items);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load support activity.'));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDay = async (day: string) => {
    setSelectedDay(day);
    setDayMembers(null);
    setDayLoading(true);
    try {
      setDayMembers((await support.activityDay(day)).items);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load that day.'));
      setSelectedDay(null);
    } finally {
      setDayLoading(false);
    }
  };

  const totalReplies = items.reduce((sum, day) => sum + day.replies, 0);
  const busiest = items.reduce<SupportTeamDay | null>(
    (best, day) => (best === null || day.replies > best.replies ? day : best),
    null,
  );
  const peopleActive = Math.max(0, ...items.map((day) => day.activeMembers));

  return (
    <div className="stack">
      <PageHeader
        title="Support activity"
        description="Replies sent by registered support members, by day."
        actions={
          <>
            <Link className="page-tab" to="/support-members">
              Members
            </Link>
            <button type="button" onClick={() => void load()}>
              <IconRefresh size={15} /> Refresh
            </button>
          </>
        }
      />

      {failure && <ErrorState message={failure} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />}

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
        <Stat label={`Replies · ${days}d`} value={totalReplies} hint="Messages sent" />
        <Stat label="Busiest day" value={busiest && busiest.replies > 0 ? busiest.replies : 0} hint={busiest && busiest.replies > 0 ? busiest.day : 'No replies yet'} />
        <Stat label="Most people in a day" value={peopleActive} hint="Members who replied" />
      </StatGrid>

      <Card title={`Replies per day · last ${days} days`}>
        {loading && items.length === 0 ? (
          <Loading label="Loading activity…" />
        ) : totalReplies === 0 ? (
          <Empty
            title="No support replies recorded in this window."
            hint="Replies are only counted for registered support members. If colleagues are answering but nobody is registered, their messages are not attributed to anyone."
            icon={<IconMessageCircle size={20} />}
          />
        ) : (
          <TrendChart
            points={items.map((day) => ({
              day: day.day,
              replies: day.replies,
              groups: day.groups,
              members: day.activeMembers,
            }))}
            series={[
              { key: 'replies', label: 'Replies', color: 'var(--accent)' },
              { key: 'groups', label: 'Groups', color: 'var(--ok)' },
              { key: 'members', label: 'People', color: 'var(--warn)' },
            ]}
          />
        )}
      </Card>

      <Card title="By day">
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Replies</th>
                <th className="num">Groups</th>
                <th className="num">People</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...items].reverse().map((day) => (
                <tr key={day.day}>
                  <td className="nowrap">{day.day}</td>
                  <td className="num">{day.replies}</td>
                  <td className="num">{day.groups}</td>
                  <td className="num">{day.activeMembers}</td>
                  <td>
                    {day.replies > 0 && (
                      <button type="button" className="page-tab" onClick={() => void openDay(day.day)}>
                        Who replied
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      {selectedDay && (
        <Card
          title={`Who replied on ${selectedDay}`}
          actions={
            <button type="button" onClick={() => setSelectedDay(null)}>
              Close
            </button>
          }
        >
          {dayLoading ? (
            <Loading label="Loading…" />
          ) : !dayMembers || dayMembers.length === 0 ? (
            <Empty title="Nobody replied on this day." icon={<IconUsers size={20} />} />
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th className="num">Replies</th>
                    <th>Groups</th>
                  </tr>
                </thead>
                <tbody>
                  {dayMembers.map((row) => (
                    <tr key={row.identityId}>
                      <td>
                        <Link to={`/support-members/${row.identityId}`}>{row.displayName}</Link>
                      </td>
                      <td className="num">{row.replies}</td>
                      <td className="wrap">{row.groups.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </div>
  );
}
