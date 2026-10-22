import { useState } from 'react';
import type { WhatsAppAccount } from '../api/client';
import { IconQrCode } from './icons';
import { Field } from './ui';
import { useCountdown, usePairing } from './use-pairing';

/**
 * Pairing, rendered inline on the accounts page rather than inside a dialog.
 *
 * Connecting a number is the main thing that screen exists for, so the code sits on the page next
 * to the accounts it will join — not behind a modal the operator has to summon and dismiss.
 *
 * The behaviour is `usePairing`, shared with `ConnectDialog`. Mount this with a `key` that changes
 * whenever the target changes: the hook starts a session on mount, so a fresh target needs a fresh
 * instance rather than a prop change the hook would have to reconcile.
 */
export function ConnectPanel({
  account,
  onChanged,
  onDone,
}: {
  /** An existing account to re-link, or null to create a new one from a name. */
  account: WhatsAppAccount | null;
  onChanged: () => void;
  /** Leave the pairing view — back to the idle form. */
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const { phase, error, qrImage, expiresAt, stale, abandoned, start, clearTimers } = usePairing({
    account,
    onChanged,
  });

  const secondsLeft = useCountdown(phase === 'pairing' ? expiresAt : null);

  function finish() {
    clearTimers();
    onChanged();
    onDone();
  }

  return (
    <section className="card card-pad stack pairing-panel" id="pairing" aria-label="Connect WhatsApp account">
      <div className="pairing-panel-intro"><span><IconQrCode size={20} /></span><div>
        <strong>{account ? `Reconnect ${account.name}` : 'Connect new WhatsApp account'}</strong>
        <div className="muted small" style={{ marginTop: 2 }}>
          {phase === 'connected'
            ? 'This number is linked.'
            : 'Scan the code with the phone you want Support CRM to handle messages for.'}
        </div>
      </div></div>
      <ol className="pairing-progress" aria-label="Account connection steps">{['Account details', 'Scan QR code', 'Connected'].map((label,index) => {
        const current = phase === 'connected' ? 2 : phase === 'starting' || phase === 'pairing' ? 1 : 0;
        return <li key={label} className={index <= current ? 'current' : ''} aria-current={index === current ? 'step' : undefined}>{index + 1}. {label}</li>;
      })}</ol>

      {phase === 'form' && (
        <>
          <Field label="Account name" hint="A name for your team — the phone number fills itself in once linked.">
            <input
              id="whatsapp-account-name"
              value={name}
              maxLength={120}
              placeholder="Support line"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim()) void start(name);
              }}
            />
          </Field>
          {error && <div className="alert">{error}</div>}
          <div className="row">
            <button type="button" className="primary" disabled={!name.trim()} onClick={() => void start(name)}>
              <IconQrCode size={15} /> Get QR code
            </button>
          </div>
        </>
      )}

      {phase === 'starting' && (
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          <span>Starting WhatsApp… this can take up to a minute.</span>
        </div>
      )}

      {phase === 'pairing' && (
        <>
          <ol className="qr-steps">
            <li>Open WhatsApp on your phone</li>
            <li>Tap Menu, then Linked devices</li>
            <li>Tap "Link a device"</li>
            <li>Scan the code below</li>
          </ol>

          <div className={stale ? 'qr-frame-inline stale' : 'qr-frame-inline'}>
            {qrImage ? <img src={qrImage} alt="WhatsApp pairing code" /> : <span className="spinner" aria-hidden="true" />}
          </div>

          <div className="qr-expiry" aria-live="polite">
            {abandoned
              ? 'No new code arrived. Cancel and try again.'
              : stale
                ? 'Refreshing the code…'
                : secondsLeft !== null
                  ? `This code expires in ${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}. A new one appears automatically.`
                  : 'Waiting for scan…'}
          </div>

          <div className="muted small" style={{ textAlign: 'center' }}>
            Keep the phone connected to the internet while it links.
          </div>

          <div className="row" style={{ justifyContent: 'center' }}>
            <button type="button" onClick={finish}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === 'connected' && (
        <div className="success" aria-live="polite">
          <div className="tick" aria-hidden="true">
            ✓
          </div>
          <div>
            <strong>Connected</strong>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Support CRM is now handling messages for this account.
            </p>
          </div>
          <button type="button" className="primary" onClick={finish}>
            Done
          </button>
        </div>
      )}

      {phase === 'failed' && (
        <>
          <div className="alert">{error}</div>
          <div className="row">
            <button type="button" onClick={finish}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void start(name)}>
              Try again
            </button>
          </div>
        </>
      )}
    </section>
  );
}
