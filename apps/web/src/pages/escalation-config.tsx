import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { escalationConfig, groups as groupsApi, whatsapp, type EscalationPolicy, type WhatsAppGroup } from '../api/client';
import { useAuth } from '../auth-context';
import {
  Card,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  errorMessage,
  useToast,
} from '../components/ui';

/**
 * Who gets told when a customer needs a person (`PROJECT_SPEC.md` §30, §33, §34).
 *
 * Edits the **global** layer, and shows what any given group resolves to once its profile and its
 * own overrides are applied. The layers are shown separately as well as merged, because "why is
 * this group waking an executive?" is a question about which layer set it — not about the final
 * value.
 */
export function EscalationConfigPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [policy, setPolicy] = useState<EscalationPolicy | null>(null);
  const [effective, setEffective] = useState<EscalationPolicy | null>(null);
  const [groups, setGroups] = useState<WhatsAppGroup[]>([]);
  const [inspectGroupId, setInspectGroupId] = useState('');
  const [layers, setLayers] = useState<{
    defaults: EscalationPolicy;
    global: EscalationPolicy;
    profile: EscalationPolicy | null;
    group: EscalationPolicy | null;
  } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canManage = can('settings.manage');

  const load = useCallback(async () => {
    try {
      const [global, accounts] = await Promise.all([escalationConfig.global(), whatsapp.overview()]);
      setPolicy(global.stored ?? {});
      setEffective(global.effective);

      // Groups are loaded for the "what does this group resolve to?" inspector. First account only:
      // the inspector is a spot check, not a directory.
      const account = accounts.items[0];
      if (account) {
        const groupList = await groupsApi.list(account.id);
        setGroups(groupList.items.filter((group) => group.isActive));
      }
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'The escalation settings could not be loaded.'));
      setPolicy({});
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inspect = useCallback(async (groupId: string) => {
    setInspectGroupId(groupId);
    if (!groupId) {
      setLayers(null);
      return;
    }
    try {
      const result = await escalationConfig.effective(groupId);
      setLayers(result.layers);
      setEffective(result.effective);
    } catch (failure) {
      toast.error(errorMessage(failure, 'That group could not be inspected.'));
    }
  }, [toast]);

  async function save() {
    if (!policy) return;
    setSaving(true);
    try {
      const result = await escalationConfig.setGlobal(policy);
      setEffective(result.effective);
      toast.success('Escalation settings saved.');
    } catch (failure) {
      toast.error(errorMessage(failure, 'Those settings could not be saved.'));
    } finally {
      setSaving(false);
    }
  }

  const set = <K extends keyof EscalationPolicy>(key: K, value: EscalationPolicy[K]) =>
    setPolicy((current) => ({ ...(current ?? {}), [key]: value }));

  const numberField = (
    key: 'maxAiAttempts' | 'maxAiReplies' | 'maxConsecutiveAiReplies' | 'humanReplyCooldownSeconds' | 'escalationScoreThreshold',
    label: string,
    hint: string,
  ) => (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={0}
        placeholder={effective?.[key] === undefined ? '' : String(effective[key])}
        value={policy?.[key] ?? ''}
        disabled={!canManage}
        onChange={(event) => set(key, event.target.value === '' ? undefined : Number(event.target.value))}
      />
    </Field>
  );

  if (!policy) {
    return error ? <ErrorState message={error} onRetry={() => void load()} /> : <Loading />;
  }

  return (
    <>
      <PageHeader
        title="Escalation"
        description="What happens when the system decides a person is needed. These are the global settings; a support profile or an individual group can override any single one."
        actions={
          <Link to="/escalations" className="small">
            Waiting for a human →
          </Link>
        }
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      <Card title="Who gets told">
        <div className="form-grid">
          <Field
            label="Internal support group"
            hint="The WhatsApp group your staff watch. A notification carries the reason and the priority — never the customer's message."
          >
            <select
              value={policy.internalGroupId ?? ''}
              disabled={!canManage}
              onChange={(event) => set('internalGroupId', event.target.value || null)}
            >
              <option value="">None — dashboard only</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name ?? group.id}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Notify the internal group">
            <select
              value={String(policy.notifyInternalGroup ?? '')}
              disabled={!canManage}
              onChange={(event) =>
                set('notifyInternalGroup', event.target.value === '' ? undefined : event.target.value === 'true')
              }
            >
              <option value="">Default ({effective?.notifyInternalGroup ? 'yes' : 'no'})</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </Field>

          <Field
            label="Notify executives"
            hint="Off by default. Waking somebody is a decision to make deliberately, per account."
          >
            <select
              value={String(policy.notifyExecutives ?? '')}
              disabled={!canManage}
              onChange={(event) =>
                set('notifyExecutives', event.target.value === '' ? undefined : event.target.value === 'true')
              }
            >
              <option value="">Default ({effective?.notifyExecutives ? 'yes' : 'no'})</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </Field>

          <Field
            label="Tell the customer"
            hint="Whether to say 'someone will be with you'. On a busy account, every time is noise."
          >
            <select
              value={String(policy.notifyCustomer ?? '')}
              disabled={!canManage}
              onChange={(event) =>
                set('notifyCustomer', event.target.value === '' ? undefined : event.target.value === 'true')
              }
            >
              <option value="">Default ({effective?.notifyCustomer ? 'yes' : 'no'})</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </Field>
        </div>

        {policy.notifyCustomer && (
          <Field label="What to tell them">
            <input
              placeholder="Someone from our team will reply shortly."
              value={policy.customerNotice ?? ''}
              disabled={!canManage}
              onChange={(event) => set('customerNotice', event.target.value)}
            />
          </Field>
        )}
      </Card>

      <Card title="When to stop trying">
        <p className="muted small">
          Limits on how long a customer talks to a machine before a person is fetched. Leave a field
          empty to inherit the value shown as the placeholder.
        </p>
        <div className="form-grid">
          {numberField('maxAiAttempts', 'AI attempts', 'How many times the AI may try before a person is fetched regardless of confidence.')}
          {numberField('maxAiReplies', 'Automated replies per conversation', 'The total, across rules and AI.')}
          {numberField('maxConsecutiveAiReplies', 'Consecutive automated replies', 'With no human in between.')}
          {numberField('humanReplyCooldownSeconds', 'Quiet period after a human replies (seconds)', 'Automation stays silent for this long once a person has spoken.')}
          {numberField('escalationScoreThreshold', 'Escalation score threshold', 'Weaker signals compound; at this score a person is fetched.')}
        </div>
      </Card>

      {canManage && (
        <div className="row">
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save global settings'}
          </button>
        </div>
      )}

      <Card title="What does a specific group do?">
        <Field label="Group" hint="Shows each layer and the result, so you can see which one set what.">
          <select value={inspectGroupId} onChange={(event) => void inspect(event.target.value)}>
            <option value="">Choose a group…</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name ?? group.id}
              </option>
            ))}
          </select>
        </Field>

        {layers && (
          <div className="stack">
            {(
              [
                ['Built-in defaults', layers.defaults],
                ['Global', layers.global],
                ['Support profile', layers.profile],
                ['This group', layers.group],
              ] as Array<[string, EscalationPolicy | null]>
            ).map(([label, layer]) => (
              <div key={label}>
                <strong className="small">{label}</strong>
                <div className="muted small">
                  {!layer || Object.keys(layer).length === 0 ? 'sets nothing' : describe(layer)}
                </div>
              </div>
            ))}
            <div className="hint">
              Result: {effective ? describe(effective) : '—'}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

/** A policy in one readable line. Only the fields it actually sets. */
function describe(policy: EscalationPolicy): string {
  const parts: string[] = [];
  if (policy.notifyInternalGroup !== undefined) parts.push(`internal group ${policy.notifyInternalGroup ? 'on' : 'off'}`);
  if (policy.notifyExecutives !== undefined) parts.push(`executives ${policy.notifyExecutives ? 'on' : 'off'}`);
  if (policy.notifyCustomer !== undefined) parts.push(`customer notice ${policy.notifyCustomer ? 'on' : 'off'}`);
  if (policy.maxAiReplies !== undefined) parts.push(`${policy.maxAiReplies} replies max`);
  if (policy.maxAiAttempts !== undefined) parts.push(`${policy.maxAiAttempts} attempts`);
  if (policy.escalationScoreThreshold !== undefined) parts.push(`score ${policy.escalationScoreThreshold}`);
  if (policy.internalGroupId) parts.push('a specific internal group');
  return parts.length > 0 ? parts.join(', ') : 'sets nothing';
}
