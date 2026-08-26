import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { whatsapp, type PairingFormat, type WhatsAppAccount } from '../api/client';
import { onChannelStatus, onPairingCode } from '../api/realtime';

/**
 * The WhatsApp pairing exchange, as one reusable piece.
 *
 * Two screens run it — the dialog and the inline panel on the accounts page — and pairing has
 * enough sharp edges (a code that rotates every ~20s, a socket that can drop mid-scan, a
 * session-lifecycle call that must fire exactly once) that having two copies of it would guarantee
 * they drift. So the behaviour lives here and the screens only draw it.
 *
 * The code itself is a credential: whoever scans it pairs a device to the customer's WhatsApp. It
 * is rendered and never stored, encoded in the browser rather than by any third-party image
 * service, and the subscription is dropped the moment the caller unmounts.
 */

export type PairingPhase = 'form' | 'starting' | 'pairing' | 'connected' | 'failed';

/**
 * How long to wait past a code's expiry before assuming no replacement is coming.
 *
 * WhatsApp rotates a pairing code every ~20 seconds and the gateway pushes each one, so a code
 * going stale is normal and needs no action. Silence well past that is not.
 */
const REPLACEMENT_GRACE_MS = 40_000;

/**
 * How often the caller re-reads the code over REST.
 *
 * Slower than the ~20 s rotation on purpose: the websocket is the real delivery path, and this only
 * has to catch the case where it is degraded. It runs solely while a pairing view is mounted.
 */
const PAIRING_POLL_MS = 12_000;

export function usePairing({
  account,
  onChanged,
}: {
  /** An existing account to re-link, or null to create one from a name. */
  account: WhatsAppAccount | null;
  /** Called when the account list should be refetched — on start, on success. */
  onChanged: () => void;
}) {
  const [phase, setPhase] = useState<PairingPhase>(account ? 'starting' : 'form');
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(account?.id ?? null);

  const [qrImage, setQrImage] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [abandoned, setAbandoned] = useState(false);

  // The rotation timers belong to the current code and must be cleared when it is replaced —
  // otherwise a stale timer marks a fresh code stale.
  const timers = useRef<number[]>([]);
  const clearTimers = () => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  };

  const showCode = useCallback(async (payload: string, format: PairingFormat, expiry: string | null) => {
    clearTimers();
    setStale(false);
    setAbandoned(false);

    // The gateway renders the code to a PNG itself, so the usual path is "show what arrived".
    // A raw payload is encoded here, in the browser — never by a third-party image service, which
    // would hand a stranger a credential that pairs a device to a customer's WhatsApp.
    try {
      setQrImage(
        format === 'image'
          ? payload
          : await QRCode.toDataURL(payload, { margin: 1, width: 464, errorCorrectionLevel: 'M' }),
      );
    } catch {
      // A code that cannot be drawn is a dead end — say so, rather than spinning forever behind a
      // rejected promise nobody sees.
      setError('The pairing code could not be displayed. Close this and try again.');
      setPhase('failed');
      return;
    }

    const remaining = expiry ? new Date(expiry).getTime() - Date.now() : 20_000;
    setExpiresAt(Date.now() + Math.max(remaining, 1_000));
    timers.current.push(window.setTimeout(() => setStale(true), Math.max(remaining, 1_000)));
    timers.current.push(
      window.setTimeout(() => setAbandoned(true), Math.max(remaining, 1_000) + REPLACEMENT_GRACE_MS),
    );
  }, []);

  useEffect(() => clearTimers, []);

  /**
   * Set once pairing succeeds. A ref rather than the phase, because the subscription must NOT be
   * torn down and rebuilt every time the phase advances — resubscribing mid-pairing would drop the
   * room membership and lose the next rotated code.
   */
  const settled = useRef(false);

  /**
   * Set when starting the session failed.
   *
   * This matters because the panel on the accounts page stays mounted rather than being dismissed
   * like the dialog: without it, an account whose session could not start would go on polling for a
   * code every twelve seconds forever, against an endpoint that is already answering 409. The
   * operator sees the failure once and the client stops asking until they retry.
   */
  const failed = useRef(false);

  useEffect(() => {
    if (!accountId) return;

    const stopQr = onPairingCode(accountId, {
      onQr: (event) => {
        setPhase('pairing');
        void showCode(event.qr, event.format, event.expiresAt);
      },
      onCleared: () => {
        // The server closes the room once pairing succeeds.
        clearTimers();
        settled.current = true;
        setPhase('connected');
        onChanged();
      },
    });

    const stopStatus = onChannelStatus((event) => {
      if (event.channelAccountId !== accountId) return;
      if (event.state === 'CONNECTED') {
        clearTimers();
        settled.current = true;
        setPhase('connected');
        onChanged();
      }
    });

    /**
     * Reads the current code over REST.
     *
     * Called once on mount — a view opened after the code was already pushed would otherwise wait
     * for the next rotation — and then on a slow timer for as long as it stays mounted. The timer is
     * a floor under the push path, not a replacement for it: a socket that drops mid-pairing would
     * otherwise leave the operator staring at an expired code with no way to know, and a stale QR is
     * indistinguishable from a working one until they have already tried to scan it.
     */
    const pull = () => {
      // Checked before the request, not after it: the point is to stop asking, not to ignore the
      // answer.
      if (settled.current || failed.current) return;

      void whatsapp
        .qr(accountId)
        .then((payload) => {
          if (settled.current || failed.current) return;
          if (payload.qr) {
            setPhase('pairing');
            void showCode(payload.qr, payload.format, payload.expiresAt);
          } else if (payload.state === 'CONNECTED') {
            settled.current = true;
            setPhase('connected');
            onChanged();
          }
        })
        .catch(() => undefined); // no code yet is the ordinary case while the session boots
    };

    pull();
    const poll = window.setInterval(pull, PAIRING_POLL_MS);

    return () => {
      window.clearInterval(poll);
      stopQr();
      stopStatus();
    };
  }, [accountId, showCode, onChanged]);

  const start = useCallback(
    async (name?: string) => {
      setPhase('starting');
      setError(null);

      try {
        settled.current = false;
        failed.current = false;
        if (account) {
          await whatsapp.reconnect(account.id);
          setAccountId(account.id);
        } else {
          const trimmed = (name ?? '').trim();
          const created = await whatsapp.connect(slugify(trimmed), trimmed);
          setAccountId(created.id);
        }
        onChanged();
      } catch (failure) {
        failed.current = true;
        setError(failure instanceof Error ? failure.message : 'WhatsApp could not be connected.');
        setPhase('failed');
      }
    },
    [account, onChanged],
  );

  /**
   * Guards the auto-start against running twice.
   *
   * React re-invokes mount effects in development, and any future change that gives this effect a
   * dependency would do the same in production. Two starts means two session-lifecycle calls: the
   * second loses the account lock, returns 409, and the operator is shown "another operation is
   * already running" for a single click on a healthy account. Observed in the real-WhatsApp
   * validation run.
   */
  const autoStarted = useRef(false);

  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    // An account already in QR_REQUIRED has a live code; restarting would throw it away and make
    // the operator wait again. Anything else has to be started or no code is ever requested.
    if (account && account.state !== 'QR_REQUIRED') void start();
    // Mount only: this is the view opening, not a reaction to later state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { phase, error, qrImage, expiresAt, stale, abandoned, start, clearTimers };
}

/**
 * The stable identifier the account keeps for its lifetime.
 *
 * Kept separate from the display name so renaming an account later never touches the identity the
 * connection was established under.
 */
export function slugify(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return base.length > 0 ? base : `account-${Date.now()}`;
}

/** Seconds left on the current code, ticking. Null when there is no live code. */
export function useCountdown(expiresAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [expiresAt]);

  if (!expiresAt) return null;
  return Math.max(0, Math.round((expiresAt - now) / 1000));
}
