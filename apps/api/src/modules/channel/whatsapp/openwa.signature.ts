import { createHmac, timingSafeEqual } from 'node:crypto';

/** Shared raw-byte HMAC SHA-256 helper. Active transport uses X-Hub-Signature-256.
 * The filename remains compatible with existing pure normalization/security fixtures.
 */
export enum SignatureFailure {
  MISSING_SECRET = 'MISSING_SECRET',
  MISSING_SIGNATURE = 'MISSING_SIGNATURE',
  MALFORMED_SIGNATURE = 'MALFORMED_SIGNATURE',
  MISMATCH = 'MISMATCH',
}

export type SignatureResult = { valid: true } | { valid: false; reason: SignatureFailure };

const PREFIX = 'sha256=';
/** SHA-256 hex is exactly 64 characters. Anything else cannot be a valid signature. */
const HEX_LENGTH = 64;

export function computeSignature(rawBody: Buffer, secret: string): string {
  return `${PREFIX}${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Verifies a delivery.
 *
 * Fails closed in every ambiguous case. In particular, a missing secret is a REJECTION, never a
 * pass: an account whose webhook secret was never provisioned must not accept unsigned traffic,
 * because that is precisely the configuration an attacker would hope to find.
 */
export function verifySignature(
  rawBody: Buffer,
  headerValue: string | string[] | undefined,
  secret: string | null | undefined,
): SignatureResult {
  if (!secret) return { valid: false, reason: SignatureFailure.MISSING_SECRET };

  const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!provided) return { valid: false, reason: SignatureFailure.MISSING_SIGNATURE };

  if (!provided.startsWith(PREFIX)) {
    return { valid: false, reason: SignatureFailure.MALFORMED_SIGNATURE };
  }

  const providedHex = provided.slice(PREFIX.length);
  // Length and charset are checked BEFORE decoding: Buffer.from(..., 'hex') silently truncates on
  // invalid input, which would let `sha256=zz` decode to an empty buffer and compare equal to
  // another empty buffer. Rejecting the shape first removes that class of bug entirely.
  if (providedHex.length !== HEX_LENGTH || !/^[0-9a-f]+$/i.test(providedHex)) {
    return { valid: false, reason: SignatureFailure.MALFORMED_SIGNATURE };
  }

  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

  const a = Buffer.from(providedHex.toLowerCase(), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return { valid: false, reason: SignatureFailure.MISMATCH };

  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: SignatureFailure.MISMATCH };
}

/**
 * Replay window check.
 *
 * The gateway stamps `timestamp` inside the signed envelope, so it cannot be altered without
 * breaking the signature — which makes it usable as a freshness bound. A captured delivery replayed
 * days later is rejected even though its signature is still perfectly valid.
 *
 * `toleranceMs` is generous by default and applies in both directions: clock skew between the
 * gateway host and this one is real, and rejecting a slightly-future timestamp would make the
 * system fail on an NTP wobble.
 *
 * A missing or unparseable timestamp is NOT treated as a replay. The signature is the security
 * control; this is a supplementary bound, and failing closed on a field the envelope may legitimately
 * omit would reject good traffic for no security gain.
 */
export function isWithinReplayWindow(
  timestamp: string | null | undefined,
  toleranceMs = 15 * 60 * 1000,
  now: number = Date.now(),
): boolean {
  if (!timestamp) return true;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return true;
  return Math.abs(now - parsed) <= toleranceMs;
}
