import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  groups,
  messages as messagesApi,
  type GroupDetail,
  type GroupParticipant,
  type InspectedMessage,
  type MessageClassificationValue,
} from '../../api/client';
import { useAuth } from '../../auth-context';
import { AiAutomationTab } from './ai-automation-tab';
import { IconRefresh } from '../../components/icons';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
  RelativeTime,
  Stat,
  StatGrid,
  TableWrap,
  errorMessage,
  humanise,
  useToast,
} from '../../components/ui';

const PAGE = 25;

type TabKey = 'overview' | 'messages' | 'members' | 'aiAutomation' | 'ai' | 'human' | 'settings';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'messages', label: 'Messages' },
  { key: 'members', label: 'Members' },
  { key: 'aiAutomation', label: 'AI & automation' },
  { key: 'ai', label: 'AI activity' },
  { key: 'human', label: 'Human support' },
  { key: 'settings', label: 'Settings' },
];

/**
 * One group, in depth.
 *
 * The message tabs are three views of one endpoint, separated by classification: everything, what
 * the AI sent (`BOT_MESSAGE`), and what a person sent (`TEAM_MESSAGE`). Filtering server-side rather
 * than fetching once and partitioning in the browser is what keeps a group with a long history the
 * same cost as a quiet one — and it means the counts shown are the counts in the database, not the
 * size of whatever happened to be downloaded.
 *
 * Nothing here can send a message. The settings tab changes flags; the message tabs are read-only.
 */
export function GroupDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();

  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setGroup(await groups.detail(id));
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load this group.'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !group) return <Loading label="Loading group…" />;
  if (failure && !group) return <ErrorState message={failure} onRetry={() => void load()} />;
  if (!group) return null;

  return (
    <div className="stack">
      <PageHeader
        title={group.name}
        description={group.externalId}
        actions={
          <>
            <Link className="page-tab" to="/groups">
              All groups
            </Link>
            <button type="button" onClick={() => void load()}>
              <IconRefresh size={15} /> Refresh
            </button>
          </>
        }
      />

      <nav className="page-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={tab === entry.key ? 'page-tab active' : 'page-tab'}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <Overview group={group} />}
      {tab === 'aiAutomation' && <AiAutomationTab groupId={group.id} />}
      {tab === 'messages' && <MessageTab groupId={group.id} title="All messages" />}
      {tab === 'ai' && (
        <MessageTab
          groupId={group.id}
          classification="BOT_MESSAGE"
          title="Replies sent by the AI"
          empty="The AI has not replied in this group."
          hint={
            group.aiEnabled
              ? undefined
              : 'AI is switched off for this group, so nothing new will be added here.'
          }
        />
      )}
      {tab === 'human' && (
        <MessageTab
          groupId={group.id}
          classification="TEAM_MESSAGE"
          title="Replies sent by a support member"
          empty="No support member has replied in this group."
        />
      )}
      {tab === 'members' && <MembersTab group={group} />}
      {tab === 'settings' && (
        <SettingsTab
          group={group}
          canEdit={can('groups.update')}
          onSaved={(next) => {
            setGroup(next);
            toast.success('Group updated.');
          }}
        />
      )}
    </div>
  );
}

/** The state of the group itself: what it is, and what the product is allowed to do in it. */
function Overview({ group }: { group: GroupDetail }) {
  return (
    <div className="stack">
      <StatGrid>
        <Stat
          label="Members"
          value={group.activeParticipants > 0 ? String(group.activeParticipants) : '—'}
          hint={group.participantsSyncedAt ? undefined : 'Never synced'}
        />
        <Stat label="Monitoring" value={humanise(group.monitoringState)} />
        <Stat label="AI" value={group.aiEnabled ? 'On' : 'Off'} tone={group.aiEnabled ? 'ok' : undefined} />
        <Stat label="Pattern analysis" value={group.patternAnalysisEnabled ? 'On' : 'Off'} />
        <Stat
          label="Knowledge contribution"
          value={group.knowledgeContributionEnabled ? 'On' : 'Off'}
          hint={group.knowledgeContributionEnabled ? 'Candidates only' : undefined}
        />
      </StatGrid>

      <Card title="Group">
        <dl className="detail-list">
          <Row label="Name" value={group.name} />
          <Row label="WhatsApp id" value={group.externalId} mono />
          <Row label="Description" value={group.description ?? '—'} />
          <Row label="Status" value={group.isActive ? 'Active' : 'Inactive'} />
          <Row label="Announce only" value={group.isAnnounceOnly ? 'Yes — only admins can post' : 'No'} />
        </dl>
      </Card>

      <Card title="Synchronisation">
        <dl className="detail-list">
          <Row label="Last message" value={<RelativeTime value={group.lastMessageAt} />} />
          <Row label="Group details synced" value={<RelativeTime value={group.lastSyncedAt} />} />
          <Row label="Members synced" value={<RelativeTime value={group.participantsSyncedAt} />} />
        </dl>
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="muted small">{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </>
  );
}

/**
 * A paginated message list, optionally narrowed to one classification.
 *
 * The total comes back with the page, so the header states how many messages match rather than how
 * many happen to be on screen.
 */
function MessageTab({
  groupId,
  classification,
  title,
  empty,
  hint,
}: {
  groupId: string;
  classification?: MessageClassificationValue;
  title: string;
  empty?: string;
  hint?: string;
}) {
  const [items, setItems] = useState<InspectedMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  // Back to the first page when the tab switches underneath this component.
  useEffect(() => setOffset(0), [groupId, classification]);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const page = await messagesApi.list({ groupId, classification, limit: PAGE, offset });
      setItems(page.items);
      setTotal(page.total);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load messages.'));
    } finally {
      setLoading(false);
    }
  }, [groupId, classification, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && items.length === 0) return <Loading label="Loading messages…" />;
  if (failure) return <ErrorState message={failure} onRetry={() => void load()} />;

  return (
    <Card title={`${title} · ${total}`} actions={hint ? <span className="muted small">{hint}</span> : undefined}>
      {items.length === 0 ? (
        <Empty title={empty ?? 'No messages yet.'} />
      ) : (
        <>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Sent</th>
                  <th>From</th>
                  <th>Kind</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {items.map((message) => (
                  <tr key={message.id}>
                    <td className="nowrap">
                      <RelativeTime value={message.sentAt} />
                    </td>
                    <td>{message.senderDisplayName ?? message.senderPhone ?? '—'}</td>
                    <td>
                      <Badge tone={toneFor(message.classification)}>{humanise(message.classification)}</Badge>
                    </td>
                    <td className="wrap">
                      {message.bodyPreview ?? <span className="muted">No text content</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <Pagination offset={offset} limit={PAGE} total={total} onChange={setOffset} />
        </>
      )}
    </Card>
  );
}

function toneFor(classification: MessageClassificationValue) {
  if (classification === 'BOT_MESSAGE') return 'busy' as const;
  if (classification === 'TEAM_MESSAGE') return 'ok' as const;
  return 'neutral' as const;
}

/**
 * Who is in the group.
 *
 * Members are only present once somebody has synced them for this group — the sync imports other
 * people's phone numbers, so it stays a deliberate action rather than something that happens on
 * load. When they have never been synced this says so, rather than showing an empty table that
 * reads as "nobody is in this group".
 */
function MembersTab({ group }: { group: GroupDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<GroupParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setItems((await groups.participants(group.id)).items);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load members.'));
    } finally {
      setLoading(false);
    }
  }, [group.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await groups.syncParticipants(group.id, group.channelAccountId);
      toast.success(`Synced ${result.active} members.`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not sync members.'));
    } finally {
      setSyncing(false);
    }
  };

  if (loading && items.length === 0) return <Loading label="Loading members…" />;
  if (failure) return <ErrorState message={failure} onRetry={() => void load()} />;

  return (
    <Card
      title={`Members · ${items.length}`}
      actions={
        can('groups.update') ? (
          <button type="button" disabled={syncing} onClick={() => void sync()}>
            <IconRefresh size={15} /> {syncing ? 'Syncing…' : 'Sync members'}
          </button>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <Empty
          title={
            group.participantsSyncedAt
              ? 'This group has no active members.'
              : 'Members have not been synced for this group yet.'
          }
          hint={
            group.participantsSyncedAt
              ? undefined
              : 'Syncing imports the phone numbers of everyone in the group, so it is a deliberate step.'
          }
        />
      ) : (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {items.map((participant) => (
                <tr key={participant.id}>
                  <td>{participant.displayName ?? '—'}</td>
                  <td className="mono">{participant.phone ?? '—'}</td>
                  <td>{participant.isAdmin ? 'Admin' : humanise(participant.participantType)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

/**
 * The per-group switches.
 *
 * Each saves on its own and sends only the field that changed, so two operators working on the same
 * group cannot overwrite each other by replaying values they had on screen. The wording states what
 * each switch actually does — in particular that turning AI off does not stop message collection,
 * and that pattern analysis counts repeated questions rather than doing anything that learns.
 */
function SettingsTab({
  group,
  canEdit,
  onSaved,
}: {
  group: GroupDetail;
  canEdit: boolean;
  onSaved: (next: GroupDetail) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);

  const save = async (field: string, patch: Parameters<typeof groups.updateConfig>[1]) => {
    setSaving(field);
    try {
      onSaved(await groups.updateConfig(group.id, patch));
    } catch (error) {
      toast.error(errorMessage(error, 'Could not save.'));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="stack">
      {!canEdit && (
        <Card>
          <span className="muted">You do not have permission to change these settings.</span>
        </Card>
      )}

      <Card title="Monitoring">
        <Toggle
          label="Collect messages from this group"
          description="When off, messages from this group are not stored and nothing downstream sees them."
          checked={group.monitoringState === 'MONITORED'}
          disabled={!canEdit || saving !== null}
          busy={saving === 'monitoring'}
          onChange={(next) => void save('monitoring', { monitoringState: next ? 'MONITORED' : 'IGNORED' })}
        />
      </Card>

      <Card title="Automation">
        <Toggle
          label="Let the AI reply in this group"
          description="Off means no automated reply is ever sent here, whatever the rules above say. Messages are still collected and people can still answer by hand."
          checked={group.aiEnabled}
          disabled={!canEdit || saving !== null}
          busy={saving === 'ai'}
          onChange={(next) => void save('ai', { aiEnabled: next })}
        />
        <Toggle
          label="Run deterministic automation rules"
          description="Rule-based replies and routing. Separate from AI — a group can run rules without ever receiving an AI answer."
          checked={group.automationEnabled}
          disabled={!canEdit || saving !== null}
          busy={saving === 'automation'}
          onChange={(next) => void save('automation', { automationEnabled: next })}
        />
      </Card>

      <Card title="Analysis">
        <Toggle
          label="Include this group in repeated-question analysis"
          description="Counts how often the same question comes up. It does not change how the AI answers, and it does not use what anyone wrote as an answer."
          checked={group.patternAnalysisEnabled}
          disabled={!canEdit || saving !== null}
          busy={saving === 'pattern'}
          onChange={(next) => void save('pattern', { patternAnalysisEnabled: next })}
        />
        <Toggle
          label="Allow messages to contribute to knowledge"
          description="Lets repeated questions from this group be proposed as knowledge candidates. Messages do not become trusted knowledge — a person must review and convert each candidate first. Requires repeated-question analysis to be on."
          checked={group.knowledgeContributionEnabled}
          disabled={!canEdit || saving !== null || !group.patternAnalysisEnabled}
          busy={saving === 'knowledge'}
          onChange={(next) => void save('knowledge', { knowledgeContributionEnabled: next })}
        />
        {group.knowledgeContributionEnabled && !group.patternAnalysisEnabled && (
          <p className="muted small">
            Knowledge contribution is switched on but repeated-question analysis is off, so nothing
            will be harvested from this group.
          </p>
        )}
      </Card>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="stack-tight">
        <strong>
          {label}
          {busy && <span className="muted small"> saving…</span>}
        </strong>
        <span className="muted small">{description}</span>
      </span>
    </label>
  );
}
