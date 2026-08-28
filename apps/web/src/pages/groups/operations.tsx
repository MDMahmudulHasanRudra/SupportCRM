import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  bulk,
  groupOperations,
  knowledge,
  whatsapp,
  type BulkOperation,
  type GroupOperationsFilter,
  type GroupOperationsRow,
  type GroupOperationsSummary,
  type KnowledgeProfile,
  type WhatsAppAccount,
} from '../../api/client';
import { useAuth } from '../../auth-context';
import { IconAlertCircle, IconRadio, IconRefresh, IconSparkles, IconZap } from '../../components/icons';
import {
  Badge,
  ConfirmDialog,
  Empty,
  ErrorState,
  PageHeader,
  RelativeTime,
  Skeleton,
  Stat,
  StatGrid,
  TableWrap,
  errorMessage,
  humanise,
  useToast,
} from '../../components/ui';

/** A tri-state filter: unset means "either", which is not the same as false. */
type Tri = '' | 'true' | 'false';
const tri = (value: Tri): boolean | undefined => (value === '' ? undefined : value === 'true');

const PAGE_SIZES = [25, 50, 100];

interface SortState {
  key: string;
  direction: 'ASC' | 'DESC';
}

/**
 * Group operations — the console for a few thousand WhatsApp groups.
 *
 * ## Everything happens on the server
 *
 * Search, filtering, sorting, counting and the per-group activity figures are all SQL. The browser
 * holds one page of rows and never sees the rest, because at three thousand groups the alternative
 * is downloading the whole table to hide most of it — and the activity counters aggregate over a
 * message table that only grows.
 *
 * ## "Select all matching" means matching, not visible
 *
 * Ticking the header box selects the page. Choosing "select all N matching" asks the server which
 * ids the current filter covers, so a selection spanning sixty pages is exactly the set the
 * operator was looking at rather than the fifty rows that happened to be loaded. The bulk pipeline
 * then re-resolves and applies them as a job.
 */
export function GroupOperationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can('groups.update') || can('groups.bulk_update');

  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [summary, setSummary] = useState<GroupOperationsSummary | null>(null);
  const [rows, setRows] = useState<GroupOperationsRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // --- query state ---------------------------------------------------------------------------
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const [monitoring, setMonitoring] = useState('');
  const [ai, setAi] = useState<Tri>('');
  const [automation, setAutomation] = useState<Tri>('');
  const [pattern, setPattern] = useState<Tri>('');
  const [active, setActive] = useState<Tri>('');
  /** Distinct from `active`: that is "not archived", this is "said something today". */
  const [activityToday, setActivityToday] = useState<Tri>('');
  const [knowledgeProfile, setKnowledgeProfile] = useState('');
  const [knowledgeContribution, setKnowledgeContribution] = useState<Tri>('');
  const [profiles, setProfiles] = useState<KnowledgeProfile[]>([]);

  const [sort, setSort] = useState<SortState>({ key: 'lastActivity', direction: 'DESC' });
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);

  // --- selection -----------------------------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** True once the operator has chosen every matching group rather than a page of them. */
  const [allMatching, setAllMatching] = useState(false);
  const [pendingBulk, setPendingBulk] = useState<{ operation: BulkOperation; label: string; count: number } | null>(
    null,
  );
  const [working, setWorking] = useState(false);

  /**
   * Drops the selection.
   *
   * Called whenever the filter changes: a selection made under one filter must not survive into
   * another, or "all matching" would carry ids the operator can no longer see — and a bulk action
   * would land on groups outside the filter they were looking at.
   */
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, []);

  const filter = useMemo<GroupOperationsFilter>(
    () => ({
      channelAccountId: account || undefined,
      monitoringState: monitoring || undefined,
      aiEnabled: tri(ai),
      automationEnabled: tri(automation),
      patternAnalysisEnabled: tri(pattern),
      isActive: tri(active),
      activeToday: tri(activityToday),
      knowledgeProfileId: knowledgeProfile || undefined,
      knowledgeContributionEnabled: tri(knowledgeContribution),
      search: search || undefined,
    }),
    [
      account,
      monitoring,
      ai,
      automation,
      pattern,
      active,
      activityToday,
      knowledgeProfile,
      knowledgeContribution,
      search,
    ],
  );

  /*
   * Tabs are shortcuts that *set* the filters below, rather than a second filter applied on top.
   *
   * The alternative — a tab that narrows independently — allows "AI enabled" to be selected while
   * the AI dropdown reads "AI disabled", and then the table agrees with neither. Writing through to
   * the filters keeps one source of truth, and the active tab is simply whichever preset the
   * current filters happen to match.
   */
  const applyTab = (tab: TabKey) => {
    const preset = TAB_PRESETS[tab];
    setMonitoring(preset.monitoring ?? '');
    setAi(preset.ai ?? '');
    setActivityToday(preset.activityToday ?? '');
    setOffset(0);
    clearSelection();
  };

  const activeTab: TabKey =
    (TAB_ORDER.find((tab) => {
      const preset = TAB_PRESETS[tab];
      return (
        (preset.monitoring ?? '') === monitoring &&
        (preset.ai ?? '') === ai &&
        (preset.activityToday ?? '') === activityToday
      );
    }) as TabKey) ?? 'all';

  // Debounced: an operator types a group name a character at a time, and each keystroke would
  // otherwise be a query across every group.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    void whatsapp
      .overview()
      .then((page) => setAccounts(page.items))
      .catch(() => setAccounts([]));
    // Best-effort: the filter degrades to "any profile" if these cannot be read, rather than
    // blocking the whole page on a secondary dropdown.
    void knowledge
      .profiles()
      .then((page) => setProfiles(page.items))
      .catch(() => setProfiles([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [page, totals] = await Promise.all([
        groupOperations.list(filter, { limit: pageSize, offset, sort: sort.key, direction: sort.direction }),
        groupOperations.summary(startOfToday()),
      ]);
      setRows(page.items);
      setTotal(page.total);
      setSummary(totals);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'Groups could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [filter, pageSize, offset, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  // A changed filter invalidates a selection built against the previous one — silently keeping it
  // would apply a bulk change to groups the operator can no longer see.
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [filter]);

  const pageIds = rows?.map((row) => row.id) ?? [];
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectionCount = allMatching ? total : selected.size;

  function toggleRow(id: string) {
    setAllMatching(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setAllMatching(false);
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function askBulk(operation: BulkOperation, label: string) {
    if (selectionCount === 0) return;
    setPendingBulk({ operation, label, count: selectionCount });
  }

  async function runBulk() {
    if (!pendingBulk) return;
    setWorking(true);
    try {
      // "All matching" is resolved server-side at the moment of applying, so the set cannot drift
      // between the operator reading the count and the job running.
      const groupIds = allMatching ? (await groupOperations.matchingIds(filter)).ids : [...selected];

      const result = await bulk.apply({ operation: pendingBulk.operation, groupIds });
      toast.success(`${pendingBulk.label} queued for ${result.totalItems} group${result.totalItems === 1 ? '' : 's'}.`);

      setSelected(new Set());
      setAllMatching(false);
      setPendingBulk(null);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That bulk change could not be queued.'));
    } finally {
      setWorking(false);
    }
  }

  const sortable = (key: string, label: string) => (
    <th
      role="button"
      tabIndex={0}
      className="sortable"
      onClick={() => setSort((s) => ({ key, direction: s.key === key && s.direction === 'DESC' ? 'ASC' : 'DESC' }))}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setSort((s) => ({ key, direction: s.key === key && s.direction === 'DESC' ? 'ASC' : 'DESC' }));
        }
      }}
    >
      {label}
      {sort.key === key && <span className="sort-arrow">{sort.direction === 'DESC' ? '↓' : '↑'}</span>}
    </th>
  );

  return (
    <>
      <PageHeader
        title="Groups"
        description="Every WhatsApp community Support CRM has synced, and what automation is allowed in each."
        actions={
          <button type="button" onClick={() => void load()} disabled={loading}>
            <IconRefresh size={15} /> Refresh
          </button>
        }
      />

      {error && <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />}

      {summary && (
        <StatGrid>
          <Stat label="Total groups" value={summary.total} icon={<IconRadio size={17} />} iconColor="accent" />
          <Stat
            label="Collecting messages"
            value={summary.collecting}
            hint="Monitored"
            icon={<IconRadio size={17} />}
            iconColor="blue"
          />
          <Stat label="AI enabled" value={summary.aiMonitored} icon={<IconSparkles size={17} />} iconColor="ok" />
          <Stat label="AI disabled" value={summary.aiDisabled} icon={<IconSparkles size={17} />} iconColor="orange" />
          <Stat label="Active today" value={summary.activeToday} icon={<IconZap size={17} />} iconColor="blue" />
          <Stat
            label="AI supported today"
            value={summary.aiSupportedToday}
            hint="Unique groups, not replies"
            icon={<IconSparkles size={17} />}
            iconColor="ok"
          />
          <Stat
            label="Human supported today"
            value={summary.humanSupportedToday}
            hint="Unique groups"
            icon={<IconZap size={17} />}
            iconColor="accent"
          />
          <Stat
            label="Pattern analysis"
            value={summary.patternAnalysis}
            icon={<IconZap size={17} />}
            iconColor="orange"
          />
        </StatGrid>
      )}

      {/* --- tabs: presets that write through to the filters below --------------------------- */}
      <nav className="page-tabs" style={{ marginTop: 16 }} role="tablist">
        {TAB_ORDER.slice()
          .sort((a, b) => DISPLAY_ORDER.indexOf(a) - DISPLAY_ORDER.indexOf(b))
          .map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={activeTab === tab ? 'page-tab active' : 'page-tab'}
              onClick={() => applyTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
      </nav>

      {/* --- filters ------------------------------------------------------------------------- */}
      <div className="toolbar" style={{ marginTop: 12 }}>
        <input
          placeholder="Search name or group id…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          style={{ maxWidth: 260 }}
          aria-label="Search groups"
        />
        {accounts.length > 1 && (
          <select value={account} onChange={(e) => { setAccount(e.target.value); setOffset(0); }} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <select
          value={knowledgeContribution}
          onChange={(e) => { setKnowledgeContribution(e.target.value as Tri); setOffset(0); clearSelection(); }}
          aria-label="Knowledge contribution"
        >
          <option value="">Any knowledge source</option>
          <option value="true">Contributing knowledge</option>
          <option value="false">Not contributing</option>
        </select>
        <select
          value={activityToday}
          onChange={(e) => { setActivityToday(e.target.value as Tri); setOffset(0); clearSelection(); }}
          aria-label="Activity"
        >
          <option value="">Any activity</option>
          <option value="true">Active today</option>
          <option value="false">Quiet today</option>
        </select>
        {profiles.length > 0 && (
          <select
            value={knowledgeProfile}
            onChange={(e) => { setKnowledgeProfile(e.target.value); setOffset(0); clearSelection(); }}
            aria-label="Knowledge profile"
          >
            <option value="">Any knowledge profile</option>
            <option value="none">No profile</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        )}
        <select value={monitoring} onChange={(e) => { setMonitoring(e.target.value); setOffset(0); }} aria-label="Monitoring">
          <option value="">Any monitoring</option>
          <option value="MONITORED">Monitored</option>
          <option value="IGNORED">Not monitored</option>
          <option value="PENDING">Pending</option>
        </select>
        <select value={ai} onChange={(e) => { setAi(e.target.value as Tri); setOffset(0); }} aria-label="AI">
          <option value="">Any AI</option>
          <option value="true">AI enabled</option>
          <option value="false">AI disabled</option>
        </select>
        <select value={automation} onChange={(e) => { setAutomation(e.target.value as Tri); setOffset(0); }} aria-label="Automation">
          <option value="">Any automation</option>
          <option value="true">Automation on</option>
          <option value="false">Automation off</option>
        </select>
        <select value={pattern} onChange={(e) => { setPattern(e.target.value as Tri); setOffset(0); }} aria-label="Pattern analysis">
          <option value="">Any pattern analysis</option>
          <option value="true">Pattern analysis on</option>
          <option value="false">Pattern analysis off</option>
        </select>
        <select value={active} onChange={(e) => { setActive(e.target.value as Tri); setOffset(0); }} aria-label="Status">
          <option value="">Any status</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </div>

      {/* --- bulk toolbar -------------------------------------------------------------------- */}
      {canManage && selectionCount > 0 && (
        <div className="bulk-bar">
          <strong className="small">
            {selectionCount.toLocaleString()} group{selectionCount === 1 ? '' : 's'} selected
          </strong>
          {!allMatching && total > pageIds.length && (
            <button type="button" className="link" onClick={() => setAllMatching(true)}>
              Select all {total.toLocaleString()} matching
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={() => askBulk('ENABLE_MONITORING', 'Enable monitoring')}>Monitor</button>
          <button type="button" onClick={() => askBulk('DISABLE_MONITORING', 'Disable monitoring')}>Stop monitoring</button>
          <button type="button" onClick={() => askBulk('ENABLE_AI', 'Enable AI')}>Enable AI</button>
          <button type="button" className="danger" onClick={() => askBulk('DISABLE_AI', 'Disable AI')}>Disable AI</button>
          <button type="button" onClick={() => askBulk('ENABLE_PATTERN_ANALYSIS', 'Enable pattern analysis')}>Pattern on</button>
          <button type="button" onClick={() => askBulk('DISABLE_PATTERN_ANALYSIS', 'Disable pattern analysis')}>Pattern off</button>
          <button type="button" onClick={() => askBulk('ENABLE_KNOWLEDGE_COLLECTION', 'Enable knowledge collection')}>
            Knowledge on
          </button>
          <button type="button" onClick={() => askBulk('DISABLE_KNOWLEDGE_COLLECTION', 'Disable knowledge collection')}>
            Knowledge off
          </button>
          <button type="button" onClick={() => askBulk('CLEAR_KNOWLEDGE_PROFILE', 'Remove knowledge profile')}>
            Remove profile
          </button>
          <button
            type="button"
            className="link"
            onClick={() => {
              setSelected(new Set());
              setAllMatching(false);
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* --- table --------------------------------------------------------------------------- */}
      <div className="card" style={{ marginTop: 14 }}>
        {loading && !rows ? (
          <div style={{ padding: 18 }}>
            <Skeleton lines={8} height={40} />
          </div>
        ) : rows && rows.length === 0 ? (
          <Empty
            title="No groups match"
            hint={
              search ||
              account ||
              monitoring ||
              ai ||
              automation ||
              pattern ||
              active ||
              activityToday ||
              knowledgeProfile
                ? 'Try widening the filters.'
                : 'Sync an account’s groups from the WhatsApp screen to see them here.'
            }
            icon={<IconRadio size={20} />}
          />
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  {canManage && (
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        onChange={togglePage}
                        aria-label="Select this page"
                      />
                    </th>
                  )}
                  {sortable('name', 'Group')}
                  {accounts.length > 1 && <th>Account</th>}
                  {sortable('members', 'Members')}
                  <th>Monitoring</th>
                  <th>AI</th>
                  <th>Automation</th>
                  <th>Pattern</th>
                  {sortable('messagesToday', 'Messages today')}
                  {sortable('aiRepliesToday', 'AI today')}
                  {sortable('humanSupportToday', 'Human today')}
                  {sortable('lastActivity', 'Last activity')}
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr key={row.id}>
                    {canManage && (
                      <td>
                        <input
                          type="checkbox"
                          checked={allMatching || selected.has(row.id)}
                          onChange={() => toggleRow(row.id)}
                          aria-label={`Select ${row.name ?? row.externalId}`}
                        />
                      </td>
                    )}
                    <td>
                      <Link to={`/groups/${row.id}`}>{row.name ?? 'Unnamed group'}</Link>
                      {!row.isActive && <div className="muted small">Inactive</div>}
                    </td>
                    {accounts.length > 1 && (
                      <td className="small muted">
                        {accounts.find((a) => a.id === row.channelAccountId)?.name ?? '—'}
                      </td>
                    )}
                    <td className="small">{row.participantCount ?? '—'}</td>
                    <td>
                      <Badge tone={row.monitoringState === 'MONITORED' ? 'ok' : 'neutral'}>
                        {humanise(row.monitoringState)}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={row.aiEnabled ? 'ok' : 'bad'}>{row.aiEnabled ? 'On' : 'Off'}</Badge>
                    </td>
                    <td>
                      <Badge tone={row.automationEnabled ? 'ok' : 'neutral'}>
                        {row.automationEnabled ? 'On' : 'Off'}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={row.patternAnalysisEnabled ? 'ok' : 'neutral'}>
                        {row.patternAnalysisEnabled ? 'On' : 'Off'}
                      </Badge>
                    </td>
                    <Counter value={row.messagesToday} />
                    <Counter value={row.aiRepliesToday} />
                    <Counter value={row.humanSupportToday} />
                    <td className="small muted">
                      {row.lastMessageAt ? <RelativeTime value={row.lastMessageAt} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        {/* --- pagination -------------------------------------------------------------------- */}
        {rows && rows.length > 0 && (
          <div className="row pagination">
            <span className="muted small">
              {offset + 1}–{Math.min(offset + pageSize, total)} of {total.toLocaleString()}
            </span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setOffset(0);
              }}
              style={{ width: 'auto' }}
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} per page
                </option>
              ))}
            </select>
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
              Previous
            </button>
            <button
              type="button"
              disabled={offset + pageSize >= total}
              onClick={() => setOffset(offset + pageSize)}
            >
              Next
            </button>
          </div>
        )}
      </div>

      {pendingBulk && (
        <ConfirmDialog
          title={`${pendingBulk.label} for ${pendingBulk.count.toLocaleString()} groups?`}
          body={
            <>
              <p>
                This queues a change for <strong>{pendingBulk.count.toLocaleString()}</strong> group
                {pendingBulk.count === 1 ? '' : 's'}.
              </p>
              {pendingBulk.operation === 'DISABLE_AI' && (
                <p className="muted small">
                  AI will stop replying in these groups as soon as the change applies. Messages are still collected
                  and people can still answer by hand.
                </p>
              )}
              {pendingBulk.operation === 'DISABLE_MONITORING' && (
                <p className="muted small">
                  Messages keep arriving and are still stored. Monitoring governs what automation may do, not
                  whether history is kept.
                </p>
              )}
              {pendingBulk.operation === 'ENABLE_AI' && (
                <p className="muted small">
                  AI will only reply where every other condition already allows it — the automation profile,
                  monitoring, the emergency control and a connected session all still apply.
                </p>
              )}
              {pendingBulk.operation === 'ENABLE_KNOWLEDGE_COLLECTION' && (
                <p className="muted small">
                  Repeated questions from these groups may be proposed as knowledge candidates. Messages do not
                  become trusted knowledge — a person reviews and converts each candidate first.
                </p>
              )}
              {pendingBulk.operation === 'DISABLE_KNOWLEDGE_COLLECTION' && (
                <p className="muted small">
                  These groups stop contributing new candidates. Candidates already in the review queue are not
                  removed.
                </p>
              )}
            </>
          }
          confirmLabel={pendingBulk.label}
          tone={pendingBulk.operation.startsWith('DISABLE') ? 'danger' : 'normal'}
          busy={working}
          onCancel={() => setPendingBulk(null)}
          onConfirm={() => void runBulk()}
        />
      )}
    </>
  );
}

/** Midnight local time, as an ISO string — the boundary the operator means by "today". */
function startOfToday(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** The tab presets, expressed as the filter values each one stands for. */
type TabKey = 'all' | 'monitored' | 'aiEnabled' | 'aiDisabled' | 'activeToday';

const TAB_PRESETS: Record<TabKey, { monitoring?: string; ai?: Tri; activityToday?: Tri }> = {
  all: {},
  monitored: { monitoring: 'MONITORED' },
  aiEnabled: { ai: 'true' },
  aiDisabled: { ai: 'false' },
  activeToday: { activityToday: 'true' },
};

/**
 * Match order, most specific first.
 *
 * `all` is last because its empty preset matches whenever nothing else does — checking it first
 * would make every tab look like "All".
 */
const TAB_ORDER: TabKey[] = ['monitored', 'aiEnabled', 'aiDisabled', 'activeToday', 'all'];

const TAB_LABELS: Record<TabKey, string> = {
  all: 'All',
  monitored: 'Monitored',
  aiEnabled: 'AI enabled',
  aiDisabled: 'AI disabled',
  activeToday: 'Active today',
};

/** Left-to-right order in the tab bar, which reads differently from match precedence. */
const DISPLAY_ORDER: TabKey[] = ['all', 'monitored', 'aiEnabled', 'aiDisabled', 'activeToday'];

/**
 * One activity figure for today.
 *
 * Zero is muted rather than hidden: an empty cell reads as missing data, and "nothing happened
 * today" is a fact the operator needs.
 */
function Counter({ value }: { value: number }) {
  return (
    <td className="num">
      <span className={value > 0 ? undefined : 'muted'}>{value.toLocaleString()}</span>
    </td>
  );
}
