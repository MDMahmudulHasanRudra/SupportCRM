import { useCallback, useEffect, useState } from 'react';
import { rateLimits, type EffectiveRateLimit, type RateLimitScope } from '../../api/client';
import { useAuth } from '../../auth-context';
import { IconAlertCircle } from '../../components/icons';
import {
  Badge,
  Card,
  ConfirmDialog,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  TableWrap,
  errorMessage,
  useToast,
} from '../../components/ui';

const EXPLANATIONS: Record<RateLimitScope, string> = {
  SESSION: 'Messages one WhatsApp account may send. The limit most likely to get an account restricted if raised carelessly.',
  GROUP: 'Messages into a single group.',
  DESTINATION: 'Messages to one individual recipient. The strictest by default — repeatedly messaging one person is what reads as harassment.',
  BROADCAST: 'Send rate within one campaign.',
  AUTOMATION: 'Automated replies across the system.',
  AI: 'Calls to the AI provider.',
  API: 'Requests to this API from one caller.',
};

/**
 * Rate limits (`PROJECT_SPEC.md` §57, §175).
 *
 * The screen shows what is in force, including the scopes nobody has overridden — a settings page
 * full of blanks tells an operator nothing about what the system is actually doing.
 *
 * Raising one is confirmed, because these exist for **account safety**. Nothing here is a way past
 * a platform's own limits; it is a way to take on more risk with your own number.
 */
export function RateLimitsPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [items, setItems] = useState<EffectiveRateLimit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EffectiveRateLimit | null>(null);
  const [limit, setLimit] = useState(0);
  const [windowSeconds, setWindowSeconds] = useState(60);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const canManage = can('settings.manage');

  const load = useCallback(async () => {
    try {
      const result = await rateLimits.effective();
      setItems(result.items);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'Rate limits could not be loaded.'));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(row: EffectiveRateLimit) {
    setEditing(row);
    setLimit(row.limit);
    setWindowSeconds(row.windowSeconds);
    setNote('');
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      await rateLimits.set({ scope: editing.scope, limit, windowSeconds, note: note || undefined });
      toast.success(`${editing.scope} limit set to ${limit} per ${windowSeconds}s.`);
      setEditing(null);
      setConfirming(false);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That limit could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  const raising = editing ? limit > editing.limit || windowSeconds < editing.windowSeconds : false;

  return (
    <>
      <PageHeader
        title="Rate limits"
        description="What the system allows itself to send. These protect your WhatsApp account and the people receiving messages — they are not a way around a platform's own limits."
      />

      {error && <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />}

      {items === null ? (
        <Loading label="Loading limits…" />
      ) : (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Scope</th>
                <th>Limit</th>
                <th>Source</th>
                <th>What it protects</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.scope}>
                  <td>{row.scope.toLowerCase()}</td>
                  <td>
                    <strong>{row.limit}</strong>
                    <span className="muted"> per {row.windowSeconds}s</span>
                  </td>
                  <td>
                    <Badge tone={row.source === 'policy' ? 'warn' : 'neutral'}
                      title={
                        row.source === 'policy'
                          ? 'Somebody changed this from the built-in default.'
                          : 'The conservative built-in value.'
                      }
                    >
                      {row.source === 'policy' ? 'Customised' : 'Default'}
                    </Badge>
                  </td>
                  <td className="small">{EXPLANATIONS[row.scope]}</td>
                  <td>
                    {canManage && (
                      <button type="button" onClick={() => edit(row)}>
                        Change
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {editing && !confirming && (
        <Card title={`Change the ${editing.scope.toLowerCase()} limit`}>
          <div className="form-grid">
            <Field label="Messages allowed">
              <input type="number" min={1} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
            </Field>
            <Field label="Per (seconds)">
              <input
                type="number"
                min={1}
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(Number(event.target.value))}
              />
            </Field>
            <Field label="Why" hint="Recorded with the change, for whoever wonders later.">
              <input value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
          </div>

          {raising && (
            <div className="alert">
              This is looser than the current setting. Higher send rates are the most common cause of
              a WhatsApp account being restricted.
            </div>
          )}

          <div className="row">
            <button type="button" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || limit < 1 || windowSeconds < 1}
              onClick={() => (raising ? setConfirming(true) : void save())}
            >
              Save
            </button>
          </div>
        </Card>
      )}

      {confirming && editing && (
        <ConfirmDialog
          title="Raise this limit?"
          confirmLabel="Raise it"
          busy={busy}
          body={
            <div className="stack">
              <p>
                {editing.scope.toLowerCase()} goes from <strong>{editing.limit} per {editing.windowSeconds}s</strong> to{' '}
                <strong>
                  {limit} per {windowSeconds}s
                </strong>
                .
              </p>
              <p className="muted small">
                These limits exist to keep the account safe. Raising one accepts that risk knowingly.
              </p>
            </div>
          }
          onConfirm={() => void save()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
