import { useCallback, useEffect, useState } from 'react';
import { onboarding, whatsapp, automation, type AutomationProfile, type OnboardingRule, type WhatsAppAccount } from '../../api/client';
import { useAuth } from '../../auth-context';
import {
  Badge,
  Card,
  ConfirmDialog,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
  TableWrap,
  errorMessage,
  useToast,
} from '../../components/ui';

/**
 * Rules for groups that have not arrived yet (`PROJECT_SPEC.md` §98, §99, §134).
 *
 * At three thousand groups, configuring each new one by hand is a backlog rather than a workflow.
 * A rule says once what a class of groups should look like — "anything with VIP in the name gets
 * the Premium profile" — and every group discovered afterwards is set up the moment it appears.
 *
 * Preview before saving, for the same reason bulk actions preview: a rule that matches far more
 * groups than its author expected is the same mistake as a bulk filter with a typo.
 */
export function OnboardingRulesPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [rules, setRules] = useState<OnboardingRule[] | null>(null);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [profiles, setProfiles] = useState<AutomationProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<OnboardingRule | null>(null);

  const [draft, setDraft] = useState({
    name: '',
    nameContains: '',
    channelAccountId: '',
    priority: 100,
    automationProfileId: '',
    monitoringState: '',
    automationEnabled: '',
    aiEnabled: '',
  });
  const [preview, setPreview] = useState<{ total: number; sample: Array<{ id: string; name: string | null }> } | null>(
    null,
  );

  const canEdit = can('groups.update');

  const load = useCallback(async () => {
    try {
      const [ruleList, accountList, profileList] = await Promise.all([
        onboarding.list(),
        whatsapp.overview(),
        automation.profiles(),
      ]);
      setRules(ruleList.items);
      setAccounts(accountList.items);
      setProfiles(profileList.items);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'Onboarding rules could not be loaded.'));
      setRules([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runPreview() {
    setBusy(true);
    try {
      setPreview(
        await onboarding.preview({
          nameContains: draft.nameContains || undefined,
          channelAccountId: draft.channelAccountId || undefined,
        }),
      );
    } catch (failure) {
      toast.error(errorMessage(failure, 'That could not be previewed.'));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    try {
      await onboarding.create({
        name: draft.name.trim(),
        nameContains: draft.nameContains.trim() || undefined,
        channelAccountId: draft.channelAccountId || undefined,
        priority: draft.priority,
        automationProfileId: draft.automationProfileId || undefined,
        monitoringState: draft.monitoringState || undefined,
        automationEnabled: draft.automationEnabled === '' ? undefined : draft.automationEnabled === 'true',
        aiEnabled: draft.aiEnabled === '' ? undefined : draft.aiEnabled === 'true',
      });
      toast.success('Rule added. It applies to groups discovered from now on.');
      setDraft({
        name: '',
        nameContains: '',
        channelAccountId: '',
        priority: 100,
        automationProfileId: '',
        monitoringState: '',
        automationEnabled: '',
        aiEnabled: '',
      });
      setPreview(null);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That rule could not be added.'));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule: OnboardingRule, isActive: boolean) {
    try {
      await onboarding.update(rule.id, { isActive });
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That change was refused.'));
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await onboarding.remove(removing.id);
      toast.success('Rule removed. Groups it already configured are untouched.');
      setRemoving(null);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That rule could not be removed.'));
    } finally {
      setBusy(false);
    }
  }

  const profileName = (id: string | null) =>
    id ? (profiles.find((profile) => profile.id === id)?.name ?? '—') : '—';
  const accountName = (id: string | null) =>
    id ? (accounts.find((account) => account.id === id)?.name ?? '—') : 'Every account';

  return (
    <>
      <PageHeader
        title="Group onboarding"
        description="What a newly discovered group should be configured as. Rules are checked in priority order and the first match wins; a group is only ever onboarded once, so a later change you make by hand is never overwritten."
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {rules === null ? (
        <Loading label="Loading rules…" />
      ) : rules.length === 0 ? (
        <Empty
          title="No onboarding rules"
          hint="Without one, every newly discovered group arrives unmonitored with automation off — safe, but it means configuring each by hand."
        />
      ) : (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Matches</th>
                <th>Account</th>
                <th>Applies</th>
                <th>Used</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    {rule.name}
                    <div className="muted small">priority {rule.priority}</div>
                  </td>
                  <td className="small">
                    {rule.nameContains ? (
                      <>
                        name contains <span className="mono">{rule.nameContains}</span>
                      </>
                    ) : (
                      <span className="muted">every group (catch-all)</span>
                    )}
                  </td>
                  <td className="small">{accountName(rule.channelAccountId)}</td>
                  <td className="small">
                    <div className="chip-row">
                      {rule.automationProfileId && <Badge>{profileName(rule.automationProfileId)}</Badge>}
                      {rule.monitoringState && <Badge>{rule.monitoringState.toLowerCase()}</Badge>}
                      {rule.automationEnabled !== null && (
                        <Badge tone={rule.automationEnabled ? 'ok' : 'neutral'}>
                          automation {rule.automationEnabled ? 'on' : 'off'}
                        </Badge>
                      )}
                      {rule.aiEnabled !== null && (
                        <Badge tone={rule.aiEnabled ? 'ok' : 'neutral'}>AI {rule.aiEnabled ? 'on' : 'off'}</Badge>
                      )}
                    </div>
                  </td>
                  <td className="small">
                    {rule.matchCount}
                    {rule.lastMatchedAt && (
                      <div className="muted small">
                        <RelativeTime value={rule.lastMatchedAt} />
                      </div>
                    )}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={rule.isActive}
                      disabled={!canEdit}
                      aria-label={`Activate ${rule.name}`}
                      onChange={(event) => void toggle(rule, event.target.checked)}
                    />
                  </td>
                  <td>
                    {canEdit && (
                      <button type="button" onClick={() => setRemoving(rule)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {canEdit && (
        <Card title="Add a rule">
          <div className="form-grid">
            <Field label="Name" hint="What this rule is for, in your words.">
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="Group name contains" hint="Leave empty to match every group — a catch-all.">
              <input
                placeholder="VIP"
                value={draft.nameContains}
                onChange={(event) => setDraft({ ...draft, nameContains: event.target.value, })}
              />
            </Field>
            <Field label="Account">
              <select
                value={draft.channelAccountId}
                onChange={(event) => setDraft({ ...draft, channelAccountId: event.target.value })}
              >
                <option value="">Every account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority" hint="Lower runs first. The first matching rule wins.">
              <input
                type="number"
                value={draft.priority}
                onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })}
              />
            </Field>
          </div>

          <div className="form-grid">
            <Field label="Automation profile">
              <select
                value={draft.automationProfileId}
                onChange={(event) => setDraft({ ...draft, automationProfileId: event.target.value })}
              >
                <option value="">Leave unset</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Monitoring">
              <select
                value={draft.monitoringState}
                onChange={(event) => setDraft({ ...draft, monitoringState: event.target.value })}
              >
                <option value="">Leave unset</option>
                <option value="MONITORED">Monitored</option>
                <option value="IGNORED">Ignored</option>
              </select>
            </Field>
            <Field label="Automation">
              <select
                value={draft.automationEnabled}
                onChange={(event) => setDraft({ ...draft, automationEnabled: event.target.value })}
              >
                <option value="">Leave unset</option>
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            </Field>
            <Field label="AI">
              <select value={draft.aiEnabled} onChange={(event) => setDraft({ ...draft, aiEnabled: event.target.value })}>
                <option value="">Leave unset</option>
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            </Field>
          </div>

          <div className="row">
            <button type="button" disabled={busy} onClick={() => void runPreview()}>
              Preview matches
            </button>
            <button type="button" className="primary" disabled={busy || !draft.name.trim()} onClick={() => void create()}>
              Add rule
            </button>
          </div>

          {preview && (
            <div className="hint">
              {preview.total === 0
                ? 'No existing group matches this. It will still apply to groups discovered later.'
                : `${preview.total} existing group${preview.total === 1 ? '' : 's'} match this filter — ${preview.sample
                    .map((group) => group.name ?? group.id)
                    .slice(0, 4)
                    .join(', ')}${preview.total > 4 ? '…' : ''}. Existing groups are not reconfigured; this is a check on the filter itself.`}
            </div>
          )}
        </Card>
      )}

      {removing && (
        <ConfirmDialog
          title="Remove this rule?"
          confirmLabel="Remove"
          busy={busy}
          body={`"${removing.name}" will no longer be applied to newly discovered groups. Groups it has already configured keep their settings.`}
          onConfirm={() => void remove()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}
