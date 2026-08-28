import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { groups as groupsApi, whatsapp, type WhatsAppAccount, type WhatsAppGroup } from '../api/client';
import { useAuth } from '../auth-context';
import { IconUsers } from '../components/icons';
import { RelativeTime } from '../components/status-badge';
import { Empty, Skeleton } from '../components/ui';

/**
 * The groups of one WhatsApp account.
 *
 * Participant synchronization lives here, per group, and nowhere else. The account-wide sync would
 * pull every member of every group — in the real validation that would have been nine groups of
 * other people's phone numbers from a single click — so the UI does not offer it. An operator picks
 * the group they actually care about.
 */
export function GroupsPage() {
  const { accountId = '' } = useParams();
  const { can } = useAuth();

  const [account, setAccount] = useState<WhatsAppAccount | null>(null);
  const [items, setItems] = useState<WhatsAppGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncingList, setSyncingList] = useState(false);

  const manage = can('groups.update');

  const load = useCallback(async () => {
    try {
      const [overview, list] = await Promise.all([whatsapp.overview(), groupsApi.list(accountId)]);
      setAccount(overview.items.find((item) => item.id === accountId) ?? null);
      setItems(list.items);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load groups.');
      setItems([]);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncList() {
    setSyncingList(true);
    setError(null);
    setNotice(null);

    try {
      const result = await groupsApi.syncGroups(accountId);
      setNotice(
        `${result.discovered} group${result.discovered === 1 ? '' : 's'} found, ${result.created} new.`,
      );
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The group list could not be refreshed.');
    } finally {
      setSyncingList(false);
    }
  }

  async function syncParticipants(group: WhatsAppGroup) {
    setBusyId(group.id);
    setError(null);
    setNotice(null);

    try {
      const result = await groupsApi.syncParticipants(group.id, accountId);
      setNotice(`${group.name ?? 'Group'}: ${result.active} participants.`);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Participants could not be synchronized.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Groups</h1>
        {manage && items !== null && items.length > 0 && (
          <button type="button" onClick={() => void syncList()} disabled={syncingList}>
            {syncingList ? 'Refreshing…' : 'Refresh group list'}
          </button>
        )}
      </div>
      <p className="page-sub">
        {account ? account.name : 'WhatsApp account'} ·{' '}
        <Link to="/channels/whatsapp">Back to accounts</Link>
      </p>

      {error && (
        <div className="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="card card-pad small" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      )}

      <div className="card">
        {items === null ? (
          <div style={{ padding: 14 }}>
            <Skeleton lines={5} />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title="No groups yet"
            hint="Refresh the group list to pull this account’s groups from WhatsApp."
            icon={<IconUsers size={20} />}
            action={
              manage && (
                <button type="button" className="primary" onClick={() => void syncList()} disabled={syncingList}>
                  {syncingList ? 'Refreshing…' : 'Refresh group list'}
                </button>
              )
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Participants</th>
                  <th>Participants synced</th>
                  <th>Last message</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {items.map((group) => (
                  <tr key={group.id}>
                    <td>
                      <div>{group.name ?? 'Unnamed group'}</div>
                      {group.description && (
                        <div className="muted small">{group.description.slice(0, 80)}</div>
                      )}
                    </td>
                    <td>
                      {group.participantCount ?? <span className="muted">not synced</span>}
                    </td>
                    <td className="small">
                      <RelativeTime value={group.participantsSyncedAt} />
                    </td>
                    <td className="small">
                      <RelativeTime value={group.lastMessageAt} />
                    </td>
                    {manage && (
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            disabled={busyId === group.id}
                            onClick={() => void syncParticipants(group)}
                            title="Imports this group's members into Support CRM"
                          >
                            {busyId === group.id ? 'Syncing…' : 'Sync participants'}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="hint" style={{ marginTop: 14 }}>
        Synchronizing participants imports the phone numbers of everyone in that group. Nobody is
        turned into a customer by it — that stays a decision you make.
      </p>
    </>
  );
}
