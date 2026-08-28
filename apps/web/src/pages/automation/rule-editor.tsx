import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  automation,
  decisions,
  type ActionType,
  type AutomationRule,
  type AutomationRuleVersion,
  type ConditionType,
  type DryRunResult,
  type RuleAction,
  type RuleCondition,
} from '../../api/client';
import { useAuth } from '../../auth-context';
import { IconAlertCircle } from '../../components/icons';
import { ErrorState, Loading, errorMessage, useToast } from '../../components/ui';
import { RuleStatusChip } from './chips';

const CONDITION_TYPES: Array<{ value: ConditionType; label: string; hint: string }> = [
  { value: 'NORMALIZED', label: 'Message is (loosely)', hint: 'Ignores case, spacing and punctuation.' },
  { value: 'EXACT', label: 'Message is exactly', hint: 'Character for character, after trimming.' },
  { value: 'CONTAINS', label: 'Message contains', hint: 'Anywhere in the message.' },
  { value: 'PREFIX', label: 'Message starts with', hint: '' },
  { value: 'SUFFIX', label: 'Message ends with', hint: '' },
  { value: 'REGEX', label: 'Message matches pattern', hint: 'Anchored and length-capped for safety.' },
  { value: 'MESSAGE_TYPE', label: 'Message type is', hint: 'Comma-separated, e.g. TEXT, IMAGE.' },
  { value: 'HAS_ATTACHMENT', label: 'Has an attachment', hint: '' },
  { value: 'CONVERSATION_STATE', label: 'Conversation state is', hint: 'Comma-separated.' },
  { value: 'CUSTOMER_TAG', label: 'Customer is tagged', hint: 'Comma-separated.' },
  { value: 'BUSINESS_HOURS', label: 'Inside business hours', hint: 'Needs hours on the profile.' },
  { value: 'TIME_WINDOW', label: 'Between two times', hint: '24-hour HH:MM, may cross midnight.' },
];

const ACTION_TYPES: Array<{ value: ActionType; label: string; needsValue: boolean }> = [
  { value: 'SEND_MESSAGE', label: 'Send this reply', needsValue: true },
  { value: 'TRIGGER_KNOWLEDGE_AI', label: 'Hand to the knowledge AI', needsValue: false },
  { value: 'ESCALATE', label: 'Send to a human', needsValue: true },
  { value: 'IGNORE', label: 'Do nothing', needsValue: false },
  { value: 'ADD_TAG', label: 'Add a tag', needsValue: true },
  { value: 'REMOVE_TAG', label: 'Remove a tag', needsValue: true },
  { value: 'SET_CONVERSATION_STATE', label: 'Set the conversation state', needsValue: true },
  { value: 'ASSIGN_TEAM', label: 'Assign to a team', needsValue: true },
  { value: 'ASSIGN_AGENT', label: 'Assign to an agent', needsValue: true },
];

const LIST_CONDITIONS: ConditionType[] = ['MESSAGE_TYPE', 'CONVERSATION_STATE', 'CUSTOMER_TAG'];
const NO_VALUE_CONDITIONS: ConditionType[] = ['HAS_ATTACHMENT', 'BUSINESS_HOURS'];

/**
 * Writing one rule, and testing it before anybody sees it.
 *
 * The tester is the point of this screen. It runs the **same** evaluator the live engine runs, so
 * what it shows is what would happen — and it sends nothing, which is stated on the screen rather
 * than left to trust.
 *
 * Editing the behaviour of an Active rule demotes it back to Draft. That is the API's rule, not
 * this screen's, and it is surfaced here so the demotion is never a surprise.
 */
export function AutomationRuleEditorPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();

  const [rule, setRule] = useState<AutomationRule | null>(null);
  const [versions, setVersions] = useState<AutomationRuleVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [priority, setPriority] = useState(0);
  const [match, setMatch] = useState<'ALL' | 'ANY'>('ALL');
  const [conditions, setConditions] = useState<RuleCondition[]>([]);
  const [actions, setActions] = useState<RuleAction[]>([]);
  const [cooldown, setCooldown] = useState(0);

  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<DryRunResult | null>(null);
  const [testing, setTesting] = useState(false);

  const canWrite = can('automation.create');
  const canApprove = can('automation.approve');
  const canSimulate = can('automation.simulate');

  const load = useCallback(async () => {
    try {
      const [loaded, versionList] = await Promise.all([
        automation.getRule(id),
        automation.ruleVersions(id).catch(() => ({ items: [] as AutomationRuleVersion[] })),
      ]);
      setRule(loaded);
      setVersions(versionList.items);
      setName(loaded.name);
      setPriority(loaded.priority);
      setMatch(loaded.conditions?.match ?? 'ALL');
      setConditions(loaded.conditions?.conditions ?? []);
      setActions(loaded.actions ?? []);
      setCooldown(loaded.cooldownSeconds);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That rule could not be loaded.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await automation.updateRule(id, {
        name,
        priority,
        conditions: { match, conditions },
        actions,
        cooldownSeconds: cooldown,
      });
      await load();
      setSaved(true);
      toast.success('Saved.');
    } catch (failure) {
      toast.error(errorMessage(failure, 'The rule could not be saved.'));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!testText.trim()) return;
    setTesting(true);
    setError(null);
    try {
      setTestResult(await decisions.dryRun({ text: testText, ruleIds: [id] }));
    } catch (failure) {
      toast.error(errorMessage(failure, 'The test could not be run.'));
    } finally {
      setTesting(false);
    }
  }

  async function rollback(version: number) {
    setError(null);
    try {
      await automation.rollbackRule(id, version);
      toast.success(`Restored v${version} as a new draft. It needs approving before it answers anyone.`);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That version could not be restored.'));
    }
  }

  if (!rule) {
    return error ? (
      <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />
    ) : (
      <Loading />
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>{rule.name}</h1>
        <div className="row">
          <RuleStatusChip status={rule.status} />
          <Link to="/automation" className="small">
            ← All rules
          </Link>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {saved && <div className="hint">Saved.</div>}

      {rule.status === 'ACTIVE' && canWrite && (
        <div className="hint">
          This rule is live. Changing its conditions or actions returns it to Draft, so an edit never
          reaches customers without somebody approving it again.
        </div>
      )}

      <div className="card card-pad stack">
        <label>
          Name
          <input value={name} disabled={!canWrite} onChange={(event) => setName(event.target.value)} />
        </label>

        <div className="row">
          <label>
            Priority
            <input
              type="number"
              value={priority}
              disabled={!canWrite}
              onChange={(event) => setPriority(Number(event.target.value))}
            />
          </label>
          <label>
            Cooldown (seconds)
            <input
              type="number"
              min={0}
              value={cooldown}
              disabled={!canWrite}
              onChange={(event) => setCooldown(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="muted small">
          A more specific rule always beats a broader one, whatever the priority number says.
          Priority only separates rules of the same scope.
        </div>
      </div>

      <div className="card card-pad stack">
        <div className="row">
          <strong>When</strong>
          <select
            value={match}
            disabled={!canWrite}
            onChange={(event) => setMatch(event.target.value as 'ALL' | 'ANY')}
          >
            <option value="ALL">every condition holds</option>
            <option value="ANY">any condition holds</option>
          </select>
        </div>

        {conditions.length === 0 && (
          <div className="muted small">
            No conditions. A rule with no conditions matches nothing — add at least one.
          </div>
        )}

        {conditions.map((condition, index) => {
          const meta = CONDITION_TYPES.find((entry) => entry.value === condition.type);
          const isList = LIST_CONDITIONS.includes(condition.type);
          const takesNoValue = NO_VALUE_CONDITIONS.includes(condition.type);

          return (
            <div key={index} className="row">
              <select
                value={condition.type}
                disabled={!canWrite}
                onChange={(event) =>
                  setConditions(
                    conditions.map((entry, position) =>
                      position === index ? { type: event.target.value as ConditionType } : entry,
                    ),
                  )
                }
              >
                {CONDITION_TYPES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>

              {condition.type === 'TIME_WINDOW' ? (
                <>
                  <input
                    placeholder="22:00"
                    value={condition.from ?? ''}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setConditions(
                        conditions.map((entry, position) =>
                          position === index ? { ...entry, from: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <input
                    placeholder="06:00"
                    value={condition.to ?? ''}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setConditions(
                        conditions.map((entry, position) =>
                          position === index ? { ...entry, to: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                </>
              ) : takesNoValue ? null : isList ? (
                <input
                  placeholder="TEXT, IMAGE"
                  value={(condition.values ?? []).join(', ')}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setConditions(
                      conditions.map((entry, position) =>
                        position === index
                          ? {
                              ...entry,
                              values: event.target.value
                                .split(',')
                                .map((part) => part.trim())
                                .filter(Boolean),
                            }
                          : entry,
                      ),
                    )
                  }
                />
              ) : (
                <input
                  placeholder="value"
                  value={condition.value ?? ''}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setConditions(
                      conditions.map((entry, position) =>
                        position === index ? { ...entry, value: event.target.value } : entry,
                      ),
                    )
                  }
                />
              )}

              <label className="small">
                <input
                  type="checkbox"
                  checked={condition.negate ?? false}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setConditions(
                      conditions.map((entry, position) =>
                        position === index ? { ...entry, negate: event.target.checked } : entry,
                      ),
                    )
                  }
                />{' '}
                not
              </label>

              {canWrite && (
                <button
                  type="button"
                  onClick={() => setConditions(conditions.filter((_, position) => position !== index))}
                >
                  Remove
                </button>
              )}
              {meta?.hint && <span className="muted small">{meta.hint}</span>}
            </div>
          );
        })}

        {canWrite && (
          <button
            type="button"
            onClick={() => setConditions([...conditions, { type: 'NORMALIZED', value: '' }])}
          >
            + Condition
          </button>
        )}
      </div>

      <div className="card card-pad stack">
        <strong>Then</strong>

        {actions.length === 0 && (
          <div className="muted small">No actions. This rule would match and then do nothing.</div>
        )}

        {actions.map((action, index) => {
          const meta = ACTION_TYPES.find((entry) => entry.value === action.type);
          return (
            <div key={index} className="row">
              <select
                value={action.type}
                disabled={!canWrite}
                onChange={(event) =>
                  setActions(
                    actions.map((entry, position) =>
                      position === index ? { type: event.target.value as ActionType } : entry,
                    ),
                  )
                }
              >
                {ACTION_TYPES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>

              {meta?.needsValue && (
                <textarea
                  rows={action.type === 'SEND_MESSAGE' ? 3 : 1}
                  value={action.value ?? ''}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setActions(
                      actions.map((entry, position) =>
                        position === index ? { ...entry, value: event.target.value } : entry,
                      ),
                    )
                  }
                />
              )}

              {canWrite && (
                <button
                  type="button"
                  onClick={() => setActions(actions.filter((_, position) => position !== index))}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}

        {canWrite && (
          <button type="button" onClick={() => setActions([...actions, { type: 'SEND_MESSAGE', value: '' }])}>
            + Action
          </button>
        )}
      </div>

      {canWrite && (
        <div className="row">
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {canSimulate && (
        <div className="card card-pad stack">
          <strong>Test it</strong>
          <div className="muted small">
            Runs the same evaluator the live engine runs, against this rule only. Nothing is sent and
            nothing is recorded.
          </div>
          <div className="row">
            <input
              placeholder="What would a customer say?"
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
            />
            <button type="button" disabled={testing} onClick={() => void runTest()}>
              {testing ? 'Testing…' : 'Test'}
            </button>
          </div>

          {testResult && (
            <div className="stack">
              <div>
                {testResult.winner ? (
                  <>
                    <strong>This rule would act.</strong>{' '}
                    <span className="muted small">v{testResult.winner.version}</span>
                  </>
                ) : (
                  <strong>This rule would not match.</strong>
                )}
              </div>
              {testResult.wouldSend && (
                <div className="card card-pad">
                  <div className="muted small">It would reply:</div>
                  <div style={{ overflowWrap: 'anywhere' }}>{testResult.wouldSend}</div>
                </div>
              )}
              {testResult.matched
                .filter((entry) => entry.skipped)
                .map((entry) => (
                  <div key={entry.id} className="hint">
                    Matched but would be skipped: {entry.skipped?.toLowerCase().replace(/_/g, ' ')}.
                  </div>
                ))}
              {testResult.testedAsIfActive && (
                <div className="hint">
                  This rule is not active, so it answers nobody today. The result above is what it
                  would do once it is approved.
                </div>
              )}
              {testResult.aiWouldRun && (
                <div className="muted small">With no rule acting, the message would go to the AI path.</div>
              )}
              <div className="muted small">Nothing was sent. A test never can send.</div>
            </div>
          )}
        </div>
      )}

      {versions.length > 0 && (
        <div className="card card-pad stack">
          <strong>History</strong>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Name</th>
                  <th>Change</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td>v{version.version}</td>
                    <td className="small">{version.name}</td>
                    <td className="small">{version.changeSummary ?? '—'}</td>
                    <td>
                      {canApprove && version.version !== rule.currentVersion && (
                        <button type="button" onClick={() => void rollback(version.version)}>
                          Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted small">
            Restoring writes a new Draft rather than reactivating an old one, so a restored rule is
            approved before it speaks again.
          </div>
        </div>
      )}
    </>
  );
}
