import { useState } from 'react';
import type { WhatsAppAccount } from '../api/client';
import { usePairing } from './use-pairing';

/**
 * Connect WhatsApp, as a dialog.
 *
 * The whole pairing experience without leaving Support CRM: name the account, press Connect, scan
 * the code that appears, watch it turn green. No page refresh, no polling loop, no gateway
 * dashboard, no API key (`docs/WHATSAPP_UX_ARCHITECTURE.md` §1).
 *
 * All of the pairing behaviour lives in `usePairing` — this file is the chrome around it. The
 * accounts page renders the same exchange inline through `ConnectPanel`.
 */

interface Props {
  /** An existing account to re-link, or null to create one. */
  account: WhatsAppAccount | null;
  onClose: () => void;
  /** Called when the account list should be refetched — on success and on close. */
  onChanged: () => void;
}

export function ConnectDialog({ account, onClose, onChanged }: Props) {
  const [name, setName] = useState('');
  const { phase, error, qrImage, stale, abandoned, start, clearTimers } = usePairing({ account, onChanged });

  function close() {
    clearTimers();
    onChanged();
    onClose();
  }

  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-label="Connect WhatsApp">
      <div className="dialog">
        <div className="dialog-head">
          <h2>{account ? `Reconnect ${account.name}` : 'Connect WhatsApp'}</h2>
        </div>

        <div className="dialog-body stack">
          {phase === 'form' && (
            <>
              <div>
                <label htmlFor="account-name">Account name</label>
                <input
                  id="account-name"
                  value={name}
                  autoFocus
                  placeholder="Support line"
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && name.trim()) void start(name);
                  }}
                />
                <p className="hint">
                  A name for your team. You will scan a code with the phone you want to connect.
                </p>
              </div>
              {error && <div className="alert">{error}</div>}
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
              <div className={stale ? 'qr-frame stale' : 'qr-frame'}>
                {qrImage ? (
                  <img src={qrImage} alt="WhatsApp pairing code" />
                ) : (
                  <span className="spinner" aria-hidden="true" />
                )}
              </div>

              <ol className="steps">
                <li>Open WhatsApp on your phone</li>
                <li>Go to Linked Devices</li>
                <li>Scan this QR code</li>
              </ol>

              <div className="progress" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <span>
                  {abandoned
                    ? 'No new code arrived. Close this and try again.'
                    : stale
                      ? 'Refreshing the code…'
                      : 'Waiting for scan…'}
                </span>
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
            </div>
          )}

          {phase === 'failed' && <div className="alert">{error}</div>}
        </div>

        <div className="dialog-foot">
          {phase === 'form' && (
            <>
              <button type="button" className="link" onClick={close}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={!name.trim()} onClick={() => void start(name)}>
                Connect
              </button>
            </>
          )}

          {phase === 'failed' && (
            <>
              <button type="button" className="link" onClick={close}>
                Close
              </button>
              <button type="button" className="primary" onClick={() => void start(name)}>
                Try again
              </button>
            </>
          )}

          {(phase === 'starting' || phase === 'pairing') && (
            <button type="button" className="link" onClick={close}>
              Close
            </button>
          )}

          {phase === 'connected' && (
            <button type="button" className="primary" onClick={close}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
