import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  automation,
  type AutomationProfile,
  type AutomationRule,
  type RuleAction,
  type RuleConditionSet,
} from '../../api/client';
import { useAuth } from '../../auth-context';
import { errorMessage, useToast } from '../../components/ui';
import { RuleStatusChip } from './chips';

/**
 * The rule list, and the review queue that sits inside it.
 *
 * The two permission tiers of the API are visible here rather than hidden: somebody with
 * `automation.create` can write and withdraw a rule, and only somebody with `automation.approve`
 * sees the buttons that put a rule's words in front of customers. A writer who cannot activate is
 * told so, instead of being given a button that fails.
 */
export function AutomationRulesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [profiles, setProfiles] = useState<AutomationProfile[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const canWrite = can('automation.create');
  const canApprove = can('automation.approve');

  const load = useCallback(async () => {
    try {
      const [ruleList, profileList] = await Promise.all([
        automation.listRules({ status: status || undefined }),
        automation.profiles(),
      ]);
      setRules(ruleList.items);
      setProfiles(profileList.items);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load automation rules.');
      setRules([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function transition(rule: AutomationRule, next: AutomationRule['status']) {
    setBusy(rule.id);
    setError(null);
    try {
      await automation.setRuleStatus(rule.id, next);
      toast.success(
        next === 'ACTIVE'
          ? `"${rule.name}" is live. It can now answer customers.`
          : `"${rule.name}" is now ${next.toLowerCase()}.`,
      );
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That change was refused.'));
    } finally {
      setBusy(null);
    }
  }

  async function createRule() {
    try {
      // A starter rule, not an empty one. The API refuses a rule with no conditions (it would match
      // every message) and none with no actions (it would match and do nothing), so creating a blank
      // placeholder and editing it afterwards — the pattern the knowledge editor uses — cannot work
      // here. The draft below is inert until somebody fills it in and approves it.
      const rule = await automation.createRule({
        name: 'Untitled rule',
        conditions: { match: 'ALL', conditions: [{ type: 'NORMALIZED', value: 'change me' }] },
        actions: [{ type: 'SEND_MESSAGE', value: 'Change this before activating the rule.' }],
      });
      navigate(`/automation/rules/${rule.id}`);
    } catch (failure) {
      toast.error(errorMessage(failure, 'The rule could not be created.'));
    }
  }

  const waiting = (rules ?? []).filter((rule) => rule.status === 'REVIEW');
  const profileName = (id: string | null) =>
    id ? (profiles.find((profile) => profile.id === id)?.name ?? '—') : '—';

  return (
    <>
      <div className="page-head">
        <h1>Automation</h1>
        <div className="row">
          <Link to="/automation/profiles" className="small">
            Profiles &amp; AI settings →
          </Link>
          <Link to="/automation/bulk" className="small">
            Bulk actions →
          </Link>
          {canWrite && (
            <button type="button" className="primary" onClick={() => void createRule()}>
              + New rule
            </button>
          )}
        </div>
      </div>

      <p className="page-sub">
        Rules are checked before the AI, and only <strong>Active</strong> rules are checked at all. A
        rule is data — a list of conditions and actions — never code, so nothing here can be made to
        execute something the system did not intend.
      </p>

      {error && <div className="alert">{error}</div>}

      {waiting.length > 0 && (
        <div className="card card-pad stack">
          <strong>{waiting.length} waiting for approval</strong>
          <div className="muted small">
            {canApprove
              ? 'Read the rule, then activate it. Activation is what lets its words reach customers.'
              : 'You can write and edit rules. Activating one needs the automation approval permission.'}
          </div>
          <div className="stack">
            {waiting.map((rule) => (
              <div key={rule.id} className="row">
                <Link to={`/automation/rules/${rule.id}`}>{rule.name}</Link>
                {canApprove && (
                  <>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy === rule.id}
                      onClick={() => void transition(rule, 'ACTIVE')}
                    >
                      Activate
                    </button>
                    <button
                      type="button"
                      disabled={busy === rule.id}
                      onClick={() => void transition(rule, 'DRAFT')}
                    >
                      Send back
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="row">
        <label>
          Status{' '}
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            <option value="DRAFT">Draft</option>
            <option value="REVIEW">In review</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </label>
      </div>

      {rules === null ? (
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          <span className="muted">Loading rules…</span>
        </div>
      ) : rules.length === 0 ? (
        <div className="empty">
          No rules yet. A rule answers the questions that always have the same answer, so the AI is
          only asked the ones that do not.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Action</th>
                <th>Scope</th>
                <th>Priority</th>
                <th>Profile</th>
                <th>Matched</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <Link to={`/automation/rules/${rule.id}`}>{rule.name}</Link>
                    <div className="muted small">v{rule.currentVersion}</div>
                  </td>
                  <td>
                    <RuleStatusChip status={rule.status} />
                  </td>
                  <td className="small muted" title={describeConditions(rule.conditions)}>
                    {describeConditions(rule.conditions)}
                  </td>
                  <td className="small muted" title={describeActions(rule.actions)}>
                    {describeActions(rule.actions)}
                  </td>
                  <td className="small">
                    {rule.scopeType.charAt(0) + rule.scopeType.slice(1).toLowerCase()}
                  </td>
                  <td className="small">{rule.priority}</td>
                  <td className="small">{profileName(rule.profileId)}</td>
                  <td className="small">{rule.executionCount}</td>
                  <td>
                    <div className="row">
                      {canApprove && rule.status === 'ACTIVE' && (
                        <button
                          type="button"
                          disabled={busy === rule.id}
                          onClick={() => void transition(rule, 'PAUSED')}
                        >
                          Pause
                        </button>
                      )}
                      {canApprove && rule.status === 'PAUSED' && (
                        <button
                          type="button"
                          disabled={busy === rule.id}
                          onClick={() => void transition(rule, 'ACTIVE')}
                        >
                          Resume
                        </button>
                      )}
                      {canWrite && rule.status === 'DRAFT' && (
                        <button
                          type="button"
                          disabled={busy === rule.id}
                          onClick={() => void transition(rule, 'REVIEW')}
                        >
                          Submit for review
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * A one-line summary of what makes a rule fire.
 *
 * Deliberately a summary, not the whole condition set: the table is for scanning, and the editor is
 * where the full set belongs. It never invents a description — an empty set reads as empty.
 */
function describeConditions(conditions: RuleConditionSet | null | undefined): string {
  const list = conditions?.conditions ?? [];
  if (list.length === 0) return 'No conditions';

  const first = list[0];
  const label = first.type.toLowerCase().replace(/_/g, ' ');
  const value = first.value ?? first.values?.join(', ');
  const head = value ? `${label}: ${value}` : label;

  return list.length === 1 ? head : `${head} +${list.length - 1} more`;
}

/** The same idea for the actions a rule takes. */
function describeActions(actions: RuleAction[] | null | undefined): string {
  if (!actions || actions.length === 0) return 'No actions';
  const head = actions[0].type.toLowerCase().replace(/_/g, ' ');
  return actions.length === 1 ? head : `${head} +${actions.length - 1} more`;
}
