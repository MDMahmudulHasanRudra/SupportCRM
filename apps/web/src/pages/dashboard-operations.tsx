import { useCallback, useEffect, useState } from 'react';
import {
  activityAnalytics,
  operationsReports,
  support,
  type AiBlockRow,
  type OperationsDashboard,
  type SupportMemberRow,
} from '../api/client';
import { Badge, Card, errorMessage, humanise } from '../components/ui';

export const OPERATIONS_WINDOWS = [7, 14, 30];

/**
 * Data for the operations half of the dashboard: groups, AI, and human support.
 *
 * A hook rather than a section component — the dashboard composes numbers, lists and charts into
 * their own tiers rather than rendering this as one opaque block, so the data and the layout that
 * uses it are decoupled on purpose.
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
 * The coverage figures count groups whose own switch is on. Monitoring state, an automation
 * profile, an emergency stop or a dropped session can each still withhold an AI reply, so the label
 * says "AI configured" and the per-group screen is where the effective answer lives.
 *
 * ## Empty means empty
 *
 * Every figure is an aggregate over rows that exist. When there is no activity the cards read zero
 * and the charts say so, rather than rendering a plausible-looking line.
 */
export function useOperationsDashboard(days: number) {
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
        // the dashboard is still worth showing to them.
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

  const activeMembers = members.filter((member) => member.repliesToday > 0).length;

  return { data, members, aiBlocks, activeMembers, loading, failure, reload: load };
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
export function AiStatus({
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
    <Card title="AI status">
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
