import { useCallback, useEffect, useState } from 'react';
import { emergency, type EmergencySwitch } from '../api/client';
import { useAuth } from '../auth-context';

/**
 * The emergency controls (`PROJECT_SPEC.md` §37).
 *
 * Everything on this page is loud on purpose. These switches stop the system talking to customers
 * across every conversation at once, and the two mistakes worth designing against are pressing one
 * by accident and pressing one without knowing what it will do.
 *
 * So: each switch says what it stops in a full sentence, the count of messages that would be
 * cancelled is shown *before* anything is pressed, and confirming means typing the word.
 */
export function EmergencyPage() {
  const { can } = useAuth();

  const [switches, setSwitches] = useState<EmergencySwitch[] | null>(null);
  const [pendingOutbound, setPendingOutbound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ item: EmergencySwitch; engage: boolean } | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const canManage = can('settings.manage');

  const load = useCallback(async () => {
    try {
      const payload = await emergency.list();
      setSwitches(payload.items);
      setPendingOutbound(payload.pendingOutbound);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load the emergency controls.');
      setSwitches([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply() {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await emergency.set(confirming.item.key, confirming.engage, typed);

      setResult(
        outcome.engaged
          ? `${confirming.item.label} is engaged.${outcome.cancelled > 0 ? ` ${outcome.cancelled} queued message${outcome.cancelled === 1 ? '' : 's'} cancelled.` : ''}`
          : `${confirming.item.label} is released.`,
      );
      setConfirming(null);
      setTyped('');
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That control could not be changed.');
    } finally {
      setBusy(false);
    }
  }

  const engagedCount = (switches ?? []).filter((item) => item.engaged).length;
  const word = confirming?.engage ? 'STOP' : 'RESUME';

  return (
    <>
      <div className="page-head">
        <h1>Emergency controls</h1>
      </div>

      <p className="page-sub">
        These stop the system talking to customers — everywhere, immediately. Each one is audited
        with who pressed it and when.
      </p>

      {error && <div className="alert">{error}</div>}
      {result && <div className="hint">{result}</div>}

      {engagedCount > 0 && (
        <div className="alert">
          {engagedCount} control{engagedCount === 1 ? ' is' : 's are'} currently engaged. Customers
          may be waiting without an automatic answer.
        </div>
      )}

      {switches === null ? (
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          <span className="muted">Loading…</span>
        </div>
      ) : (
        <div className="stack">
          {switches.map((item) => (
            <div key={item.key} className="card card-pad stack">
              <div className="row">
                <strong>{item.label}</strong>
                <span className="badge">
                  <span className={`dot ${item.engaged ? 'bad' : 'ok'}`} aria-hidden="true" />
                  {item.engaged ? 'Engaged' : 'Normal'}
                </span>
              </div>
              <div className="small">{item.description}</div>
              {canManage && (
                <div className="row">
                  <button
                    type="button"
                    className={item.engaged ? undefined : 'primary'}
                    onClick={() => {
                      setResult(null);
                      setTyped('');
                      setConfirming({ item, engage: !item.engaged });
                    }}
                  >
                    {item.engaged ? 'Release' : 'Engage'}
                  </button>
                  {!item.engaged && item.key.includes('outgoing') && pendingOutbound > 0 && (
                    <span className="muted small">
                      {pendingOutbound} message{pendingOutbound === 1 ? '' : 's'} queued right now — engaging
                      this cancels them.
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!canManage && (
        <div className="muted small">You can see these controls. Changing one needs settings management.</div>
      )}

      {confirming && (
        <div className="backdrop" role="dialog" aria-modal="true" aria-label="Confirm emergency control">
          <div className="dialog">
            <div className="dialog-head">
              <h2>{confirming.engage ? confirming.item.label : `Release: ${confirming.item.label}`}</h2>
            </div>
            <div className="dialog-body stack">
              <div>{confirming.item.description}</div>
              {confirming.engage && confirming.item.key.includes('outgoing') && (
                <div className="alert">
                  {pendingOutbound} queued message{pendingOutbound === 1 ? '' : 's'} will be cancelled, not
                  sent later.
                </div>
              )}
              <label>
                Type <strong>{word}</strong> to confirm
                <input value={typed} autoFocus onChange={(event) => setTyped(event.target.value)} />
              </label>
            </div>
            <div className="dialog-foot">
              <button type="button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || typed.trim().toUpperCase() !== word}
                onClick={() => void apply()}
              >
                {busy ? 'Working…' : confirming.engage ? 'Engage' : 'Release'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
