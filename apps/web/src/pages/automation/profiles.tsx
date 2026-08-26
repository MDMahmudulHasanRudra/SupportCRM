import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { automation, decisions, settings, type AutomationProfile } from '../../api/client';
import { useAuth } from '../../auth-context';
import { errorMessage, useToast } from '../../components/ui';

/**
 * Profiles, and the settings the decision engine actually reads.
 *
 * Two things live here because they are the same question at two scales: a profile says how one set
 * of groups should behave, and the settings below say what happens when no profile has an opinion.
 * The engine resolves them in exactly that order — profile, then setting, then a code default — and
 * the screen says so, because a threshold that appears to be set in two places and is honoured in
 * one is how people end up debugging the wrong number.
 */

const NUMBER_SETTINGS: Array<{ key: string; label: string; hint: string; step?: string }> = [
  {
    key: 'ai.auto_reply_min_confidence',
    label: 'Reply without a human at or above',
    hint: 'Self-reported confidence. Objective signals can still block a reply above this line.',
    step: '0.01',
  },
  {
    key: 'ai.escalate_below_confidence',
    label: 'Always escalate below',
    hint: 'Below this, a person answers. Nothing goes to the customer.',
    step: '0.01',
  },
  {
    key: 'ai.max_knowledge_chunks',
    label: 'Knowledge passages per answer',
    hint: 'How much published knowledge the AI may be shown for one question.',
  },
  {
    key: 'ai.max_history_messages',
    label: 'Conversation history messages',
    hint: 'How far back the AI can see in the conversation.',
  },
  {
    key: 'automation.auto_replies_per_conversation',
    label: 'Automatic replies per conversation',
    hint: 'A budget, per window. The loop guard that stops two systems talking to each other.',
  },
  {
    key: 'automation.auto_reply_window_seconds',
    label: 'Reply budget window (seconds)',
    hint: '',
  },
  {
    key: 'automation.repeat_suppression_seconds',
    label: 'Repeat suppression (seconds)',
    hint: 'How long the same answer is withheld from being sent to the same person twice.',
  },
];

export function AutomationProfilesPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [profiles, setProfiles] = useState<AutomationProfile[] | null>(null);
  const [ai, setAi] = useState<{ available: boolean; provider: string; model: string | null } | null>(null);
  const [effective, setEffective] = useState<{ autoReplyMin: number; escalateBelow: number } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState('ESCALATE');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const canApprove = can('automation.approve');
  const canManageSettings = can('settings.manage');

  const load = useCallback(async () => {
    try {
      const [profileList, status, settingList] = await Promise.all([
        automation.profiles(),
        decisions.status(),
        can('settings.read') ? settings.list() : Promise.resolve({ items: [] }),
      ]);

      setProfiles(profileList.items);
      setAi(status.ai);
      setEffective(status.thresholds);

      const map: Record<string, string> = {};
      for (const row of settingList.items) {
        if (row.value !== null && row.value !== undefined) map[row.key] = String(row.value);
      }
      setValues(map);
      if (map['ai.mid_confidence_policy']) setPolicy(map['ai.mid_confidence_policy']);
      else if (status.thresholds?.midPolicy) setPolicy(status.thresholds.midPolicy);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load automation settings.');
      setProfiles([]);
    }
  }, [can]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSetting(key: string, value: unknown, valueType: string) {
    setError(null);
    try {
      await settings.set(key, value, valueType, 'automation');
      setSaved(key);
      toast.success('Saved.');
      window.setTimeout(() => setSaved(null), 2000);
    } catch (failure) {
      toast.error(errorMessage(failure, 'That setting could not be saved.'));
    }
  }

  async function createProfile() {
    if (!newName.trim()) return;
    setError(null);
    try {
      await automation.createProfile({ name: newName.trim() });
      toast.success(`Profile "${newName.trim()}" created.`);
      setNewName('');
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'The profile could not be created.'));
    }
  }

  async function toggle(profile: AutomationProfile, field: 'aiEnabled' | 'automationEnabled', next: boolean) {
    setError(null);
    try {
      await automation.updateProfile(profile.id, { [field]: next });
      toast.success(
        `${field === 'aiEnabled' ? 'AI' : 'Automation'} ${next ? 'on' : 'off'} for every group using "${profile.name}".`,
      );
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That change was refused.'));
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Profiles &amp; AI settings</h1>
        <Link to="/automation" className="small">
          ← Rules
        </Link>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="card card-pad stack">
        <strong>AI provider</strong>
        {ai === null ? (
          <span className="muted small">Checking…</span>
        ) : ai.available ? (
          <div>
            <span className="badge">
              <span className="dot ok" aria-hidden="true" />
              {ai.provider}
            </span>{' '}
            <span className="muted small">{ai.model ?? 'default model'}</span>
          </div>
        ) : (
          <div className="hint">
            No AI provider is configured. Rules still run; anything a rule cannot answer goes to a
            person instead. Nothing is guessed at.
          </div>
        )}
        <div className="muted small">
          The provider and model are shown. The API key is never sent to this browser, and never
          appears in a log, a decision or an error.
        </div>
      </div>

      <div className="card card-pad stack">
        <strong>Profiles</strong>
        <div className="muted small">
          A profile is assigned to groups in bulk. Editing it changes how every group carrying it
          behaves, which is the point — and the reason it is worth reading before saving.
        </div>

        {profiles === null ? (
          <div className="progress">
            <span className="spinner" aria-hidden="true" />
            <span className="muted">Loading…</span>
          </div>
        ) : profiles.length === 0 ? (
          <div className="empty">No profiles yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Automation</th>
                  <th>AI</th>
                  <th>Reply at or above</th>
                  <th>Escalate below</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td>{profile.name}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={profile.automationEnabled}
                        disabled={!canApprove}
                        aria-label={`Automation for ${profile.name}`}
                        onChange={(event) =>
                          void toggle(profile, 'automationEnabled', event.target.checked)
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={profile.aiEnabled}
                        disabled={!canApprove}
                        aria-label={`AI for ${profile.name}`}
                        onChange={(event) => void toggle(profile, 'aiEnabled', event.target.checked)}
                      />
                    </td>
                    <td className="small">{profile.autoReplyMinConfidence ?? 'default'}</td>
                    <td className="small">{profile.escalateBelowConfidence ?? 'default'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canApprove && (
          <div className="row">
            <input
              placeholder="New profile name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button type="button" onClick={() => void createProfile()}>
              Create
            </button>
          </div>
        )}
      </div>

      <div className="card card-pad stack">
        <strong>Defaults</strong>
        <div className="muted small">
          Used when the profile covering a conversation says nothing. Every one of these is a
          setting, not a number compiled into the system.
        </div>

        {NUMBER_SETTINGS.map((setting) => (
          <div key={setting.key} className="row">
            <label>
              {setting.label}
              <input
                type="number"
                step={setting.step}
                // An unset setting is not "no value" — the engine is deciding by a default right
                // now. Where the API can tell us that number, it is shown rather than left blank.
                placeholder={placeholderFor(setting.key, effective)}
                value={values[setting.key] ?? ''}
                disabled={!canManageSettings}
                onChange={(event) => setValues({ ...values, [setting.key]: event.target.value })}
              />
            </label>
            {canManageSettings && (
              <button
                type="button"
                onClick={() => void saveSetting(setting.key, Number(values[setting.key]), 'number')}
              >
                Save
              </button>
            )}
            {saved === setting.key && <span className="muted small">Saved.</span>}
            {setting.hint && <span className="muted small">{setting.hint}</span>}
          </div>
        ))}

        <div className="row">
          <label>
            Between the two thresholds
            <select
              value={policy}
              disabled={!canManageSettings}
              onChange={(event) => setPolicy(event.target.value)}
            >
              <option value="ESCALATE">Send to a human</option>
              <option value="SILENT">Say nothing</option>
              <option value="REPLY">Reply anyway</option>
            </select>
          </label>
          {canManageSettings && (
            <button
              type="button"
              onClick={() => void saveSetting('ai.mid_confidence_policy', policy, 'string')}
            >
              Save
            </button>
          )}
          {saved === 'ai.mid_confidence_policy' && <span className="muted small">Saved.</span>}
        </div>

        <div className="hint">
          These thresholds read a number the AI provider reports about itself. It is not measured
          against anything, so the engine treats objective signals — no knowledge found, the model
          asking for a human, no confidence given at all — as decisive on their own. Raising the
          number cannot turn one of those into a reply.
        </div>
      </div>
    </>
  );
}

/** The value in force for a setting nobody has written yet, where the API reports one. */
function placeholderFor(
  key: string,
  effective: { autoReplyMin: number; escalateBelow: number } | null,
): string {
  if (!effective) return '';
  if (key === 'ai.auto_reply_min_confidence') return `${effective.autoReplyMin} (in force)`;
  if (key === 'ai.escalate_below_confidence') return `${effective.escalateBelow} (in force)`;
  return '';
}
