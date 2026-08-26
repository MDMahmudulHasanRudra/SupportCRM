import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { support, team, type SupportMemberRow } from '../../api/client';
import { useAuth } from '../../auth-context';
import { IconRefresh, IconUsers } from '../../components/icons';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
  Stat,
  StatGrid,
  TableWrap,
  errorMessage,
  useToast,
} from '../../components/ui';

/**
 * Support members and what they have actually answered.
 *
 * ## Registering somebody is what makes them countable
 *
 * A message is credited to a support member only if its sender matches a registered identity — that
 * is the same rule the classifier uses to mark a message `TEAM_MESSAGE` in the first place. So an
 * empty roster does not mean nobody is helping customers; it means nobody has been registered, and
 * the system genuinely cannot tell a colleague from a customer yet. The screen says that rather
 * than showing a confident zero.
 *
 * ## Replies and groups are different numbers
 *
 * "12 replies" and "3 groups" describe the same afternoon and neither is a substitute for the
 * other. They are counted separately in SQL and shown separately here, because reporting twelve
 * replies as twelve groups helped would overstate the work by four times.
 *
 * ## Registration is not retroactive
 *
 * Classification happens when a message arrives. Registering somebody today does not reclassify
 * what they sent yesterday, so their figures start from now — stated on the form, because otherwise
 * the first thing an admin sees after adding a colleague is a zero that looks like a bug.
 */
export function SupportMembersPage() {
  const { can } = useAuth();

  const [rows, setRows] = useState<SupportMemberRow[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setRows((await support.members(includeInactive)).items);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load support members.'));
    } finally {
      setLoading(false);
    }
  }, [includeInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  const repliesToday = rows.reduce((sum, row) => sum + row.repliesToday, 0);
  const activeToday = rows.filter((row) => row.repliesToday > 0).length;

  return (
    <div className="stack">
      <PageHeader
        title="Support members"
        description="Colleagues whose WhatsApp replies are recognised as support rather than as a customer message."
        actions={
          <>
            <Link className="page-tab" to="/support-activity">
              Activity
            </Link>
            <button type="button" onClick={() => void load()}>
              <IconRefresh size={15} /> Refresh
            </button>
          </>
        }
      />

      {failure && <ErrorState message={failure} onRetry={() => void load()} />}

      <StatGrid>
        <Stat label="Registered" value={rows.length} icon={<IconUsers size={17} />} />
        <Stat label="Replied today" value={activeToday} hint="People, not messages" />
        <Stat label="Replies today" value={repliesToday} hint="Messages sent" />
      </StatGrid>

      {can('team.manage') && <RegisterCard onRegistered={() => void load()} />}

      <Card
        title={`Members · ${rows.length}`}
        actions={
          <label className="row small" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            Include inactive
          </label>
        }
      >
        {loading && rows.length === 0 ? (
          <Loading label="Loading members…" />
        ) : rows.length === 0 ? (
          <Empty
            title="No support members registered yet."
            hint="Until a colleague's number is registered here, their replies are indistinguishable from a customer's and are not counted as support activity."
          />
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th className="num">Replies today</th>
                  <th className="num">Groups today</th>
                  <th className="num">Replies 7d</th>
                  <th className="num">Groups 7d</th>
                  <th className="num">Replies 30d</th>
                  <th className="num">Groups 30d</th>
                  <th>Last reply</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link to={`/support-members/${row.id}`}>{row.displayName}</Link>
                      <div className="muted small mono">{row.phone}</div>
                      {!row.isActive && (
                        <Badge tone="warn" title="Their new messages are no longer classified as support">
                          Inactive
                        </Badge>
                      )}
                    </td>
                    <td>{row.jobRole ?? '—'}</td>
                    <td className="num">{row.repliesToday}</td>
                    <td className="num">{row.groupsToday}</td>
                    <td className="num">{row.replies7d}</td>
                    <td className="num">{row.groups7d}</td>
                    <td className="num">{row.replies30d}</td>
                    <td className="num">{row.groups30d}</td>
                    <td className="nowrap">
                      <RelativeTime value={row.lastReplyAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="muted small">
          Replies counts messages sent. Groups counts distinct groups replied in — a member who sent
          ten messages in one group helped one group.
        </p>
      </Card>
    </div>
  );
}

/** Registering a colleague's number so their replies stop reading as a customer's. */
function RegisterCard({ onRegistered }: { onRegistered: () => void }) {
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [jobRole, setJobRole] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!phone.trim() || !displayName.trim()) return;

    setSaving(true);
    try {
      await team.register({
        channelKey: 'whatsapp',
        phone: phone.trim(),
        displayName: displayName.trim(),
        ...(jobRole.trim() ? { jobRole: jobRole.trim() } : {}),
      });
      setPhone('');
      setDisplayName('');
      setJobRole('');
      toast.success(`${displayName.trim()} registered. Their replies will be counted from now on.`);
      onRegistered();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not register this member.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Register a support member">
      <form className="row form-row" onSubmit={(event) => void submit(event)}>
        <Field label="WhatsApp number" hint="Any format; stored as digits.">
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="8801XXXXXXXXX"
            required
          />
        </Field>
        <Field label="Name">
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Full name"
            required
          />
        </Field>
        <Field label="Role" hint="Optional.">
          <input value={jobRole} onChange={(event) => setJobRole(event.target.value)} placeholder="Support" />
        </Field>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Registering…' : 'Register'}
        </button>
      </form>
      <p className="muted small">
        This changes how future messages are classified. It does not rewrite history — messages
        already received keep the classification they were given when they arrived, so this member's
        figures start from now.
      </p>
    </Card>
  );
}
