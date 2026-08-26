import { createHmac } from 'node:crypto';
import {
  SignatureFailure,
  computeSignature,
  isWithinReplayWindow,
  verifySignature,
} from './openwa.signature';

const SECRET = 'a-webhook-secret-from-the-gateway';
const BODY = Buffer.from(JSON.stringify({ event: 'message.received', sessionId: 's1' }));

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('webhook signature verification', () => {
  it('accepts a signature the gateway would produce', () => {
    // Computed independently of computeSignature, so a bug in our own helper cannot make this pass.
    expect(verifySignature(BODY, sign(BODY), SECRET)).toEqual({ valid: true });
  });

  it('computeSignature agrees with an independent HMAC', () => {
    expect(computeSignature(BODY, SECRET)).toBe(sign(BODY));
  });

  it('rejects a body that changed by a single byte', () => {
    const signature = sign(BODY);
    const tampered = Buffer.from(BODY);
    tampered[10] ^= 0x01;
    expect(verifySignature(tampered, signature, SECRET)).toEqual({
      valid: false,
      reason: SignatureFailure.MISMATCH,
    });
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(BODY, sign(BODY, 'someone-elses-secret'), SECRET)).toEqual({
      valid: false,
      reason: SignatureFailure.MISMATCH,
    });
  });

  it('rejects when no secret is configured — never falls back to accepting unsigned traffic', () => {
    // The critical case: an unprovisioned account must not become an open endpoint.
    expect(verifySignature(BODY, sign(BODY), null)).toEqual({
      valid: false,
      reason: SignatureFailure.MISSING_SECRET,
    });
    expect(verifySignature(BODY, sign(BODY), '')).toEqual({
      valid: false,
      reason: SignatureFailure.MISSING_SECRET,
    });
  });

  it('rejects a missing signature header', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toEqual({
      valid: false,
      reason: SignatureFailure.MISSING_SIGNATURE,
    });
  });

  it('rejects a signature without the sha256= prefix', () => {
    const bare = sign(BODY).slice('sha256='.length);
    expect(verifySignature(BODY, bare, SECRET)).toEqual({
      valid: false,
      reason: SignatureFailure.MALFORMED_SIGNATURE,
    });
  });

  it('rejects non-hex and wrong-length signatures instead of decoding them', () => {
    // Buffer.from(x, 'hex') silently truncates invalid input. Without the shape check first,
    // "sha256=zz" would decode to an empty buffer and could compare equal to another empty one.
    for (const bad of ['sha256=zz', 'sha256=', 'sha256=abcd', `sha256=${'a'.repeat(63)}`, `sha256=${'a'.repeat(65)}`]) {
      const result = verifySignature(BODY, bad, SECRET);
      expect(result.valid).toBe(false);
      expect((result as { reason: SignatureFailure }).reason).toBe(SignatureFailure.MALFORMED_SIGNATURE);
    }
  });

  it('accepts an uppercase hex signature', () => {
    expect(verifySignature(BODY, sign(BODY).toUpperCase().replace('SHA256=', 'sha256='), SECRET)).toEqual({
      valid: true,
    });
  });

  it('takes the first value when the header arrives as an array', () => {
    expect(verifySignature(BODY, [sign(BODY), 'sha256=deadbeef'], SECRET)).toEqual({ valid: true });
  });

  it('verifies over raw bytes, not a re-serialized object', () => {
    // The same logical payload with different key order produces different bytes — which is exactly
    // why the endpoint must verify against the raw body it received.
    const a = Buffer.from('{"event":"x","sessionId":"s1"}');
    const b = Buffer.from('{"sessionId":"s1","event":"x"}');
    expect(verifySignature(a, sign(a), SECRET)).toEqual({ valid: true });
    expect(verifySignature(b, sign(a), SECRET).valid).toBe(false);
  });

  it('handles an empty body without throwing', () => {
    const empty = Buffer.alloc(0);
    expect(verifySignature(empty, sign(empty), SECRET)).toEqual({ valid: true });
  });
});

describe('replay window', () => {
  const now = Date.parse('2026-08-23T12:00:00.000Z');

  it('accepts a fresh timestamp', () => {
    expect(isWithinReplayWindow('2026-08-23T11:59:30.000Z', 15 * 60_000, now)).toBe(true);
  });

  it('rejects a delivery captured and replayed much later', () => {
    expect(isWithinReplayWindow('2026-08-22T12:00:00.000Z', 15 * 60_000, now)).toBe(false);
  });

  it('tolerates clock skew in both directions', () => {
    // A slightly-future timestamp is an NTP wobble, not an attack. Rejecting it would make the
    // system fail on a healthy deployment.
    expect(isWithinReplayWindow('2026-08-23T12:05:00.000Z', 15 * 60_000, now)).toBe(true);
    expect(isWithinReplayWindow('2026-08-23T11:55:00.000Z', 15 * 60_000, now)).toBe(true);
  });

  it('rejects a far-future timestamp', () => {
    expect(isWithinReplayWindow('2026-08-23T13:00:00.000Z', 15 * 60_000, now)).toBe(false);
  });

  it('does not reject a missing or unparseable timestamp', () => {
    // The signature is the security control; this is a supplementary bound. Failing closed on a
    // field the envelope may legitimately omit would reject good traffic for no security gain.
    expect(isWithinReplayWindow(undefined, 15 * 60_000, now)).toBe(true);
    expect(isWithinReplayWindow('not a date', 15 * 60_000, now)).toBe(true);
  });
});
