import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { support, type SupportDayDetail } from '../../api/client';
import { Card, Empty, ErrorState, Loading, errorMessage } from '../../components/ui';

/** The presets an operator actually asks for, plus a custom range. */
type RangeKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

const RANGE_LABELS: Record<RangeKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  custom: 'Custom',
};

/**
 * One support member's activity, day by day, with the groups named.
 *
 * ## The question this answers
 *
 * "Which executive supported how many groups on which day, and which groups were they." A daily
 * count on its own cannot be checked by the person it describes; naming the groups makes it
 * auditable by them.
 *
 * ## Groups and messages are different numbers, everywhere
 *
 * A member who sent twenty messages in one group helped **one** group. The day header states both
 * figures separately and never derives one from the other — the per-day group count comes from the
 * server as a distinct count, not from the length of a message list.
 *
 * ## Days are the operator's days
 *
 * Dates are `YYYY-MM-DD` in the application's configured timezone, which the database session also
 * runs, so a day here is the same day the aggregates bucket on. Before that was pinned, the two
 * disagreed by six hours and early-morning messages landed on the previous day.
 */
export function MemberActivity({ memberId }: { memberId: string }) {
  const [range, setRange] = useState<RangeKey>('last7');
  const [customFrom, setCustomFrom] = useState(isoDay(addDays(new Date(), -6)));
  const [customTo, setCustomTo] = useState(isoDay(new Date()));

  const [days, setDays] = useState<SupportDayDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const bounds = range === 'custom' ? { from: customFrom, to: customTo } : presetRange(range);
      setDays((await support.memberActivity(memberId, bounds)).items);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load activity.'));
    } finally {
      setLoading(false);
    }
  }, [memberId, range, customFrom, customTo]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalMessages = days.reduce((sum, day) => sum + day.totalMessages, 0);
  // Summed across days on purpose: a group helped on two days is two days of work. The *distinct*
  // group figure for a whole window is a different question and is not claimed here.
  const groupDays = days.reduce((sum, day) => sum + day.groupCount, 0);

  return (
    <Card
      title="Activity by day"
      actions={
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {(Object.keys(RANGE_LABELS) as RangeKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={range === key ? 'page-tab active' : 'page-tab'}
              onClick={() => setRange(key)}
            >
              {RANGE_LABELS[key]}
            </button>
          ))}
        </div>
      }
    >
      {range === 'custom' && (
        <div className="row form-row" style={{ marginBottom: 12 }}>
          <label className="field">
            <span className="field-label">From</span>
            <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
          </label>
        </div>
      )}

      {loading && days.length === 0 ? (
        <Loading label="Loading activity…" />
      ) : failure ? (
        <ErrorState message={failure} onRetry={() => void load()} />
      ) : days.length === 0 ? (
        <Empty
          title="No support activity recorded for this period."
          hint="Only messages sent after this member was registered are counted."
        />
      ) : (
        <>
          <p className="muted small">
            {totalMessages.toLocaleString()} message{totalMessages === 1 ? '' : 's'} across{' '}
            {groupDays.toLocaleString()} group-day{groupDays === 1 ? '' : 's'} in this period.
          </p>

          <ol className="day-list">
            {days.map((day) => {
              const expanded = openDay === day.day;
              return (
                <li key={day.day} className="day-entry">
                  <button
                    type="button"
                    className="day-head"
                    aria-expanded={expanded}
                    onClick={() => setOpenDay(expanded ? null : day.day)}
                  >
                    <span className="day-date">{formatDay(day.day)}</span>
                    <span className="day-figures">
                      <strong>{day.groupCount}</strong> group{day.groupCount === 1 ? '' : 's'} ·{' '}
                      <strong>{day.totalMessages}</strong> message{day.totalMessages === 1 ? '' : 's'}
                    </span>
                    <span className="muted small">{expanded ? 'Hide' : 'Show groups'}</span>
                  </button>

                  {expanded && (
                    <ul className="day-groups">
                      {day.groups.map((group) => (
                        <li key={group.groupId ?? group.groupName}>
                          <span className="day-group-name">
                            {group.groupId ? (
                              <Link to={`/groups/${group.groupId}`}>{group.groupName}</Link>
                            ) : (
                              <span className="muted">{group.groupName}</span>
                            )}
                          </span>
                          <span className="muted small">
                            {group.messages} message{group.messages === 1 ? '' : 's'}
                            {group.firstAt && group.lastAt && (
                              <> · {clockTime(group.firstAt)}–{clockTime(group.lastAt)}</>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Card>
  );
}

function addDays(date: Date, delta: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + delta);
  return next;
}

/** `YYYY-MM-DD` in local time — `toISOString()` would shift the date across the UTC boundary. */
function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function presetRange(range: Exclude<RangeKey, 'custom'>): { from: string; to: string } {
  const today = new Date();
  if (range === 'today') return { from: isoDay(today), to: isoDay(today) };
  if (range === 'yesterday') {
    const yesterday = isoDay(addDays(today, -1));
    return { from: yesterday, to: yesterday };
  }
  return { from: isoDay(addDays(today, range === 'last7' ? -6 : -29)), to: isoDay(today) };
}

/** Renders a `YYYY-MM-DD` without letting the Date constructor reinterpret it as UTC. */
function formatDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function clockTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
