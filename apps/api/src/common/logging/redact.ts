/**
 * Redaction for structured logs and audit records.
 *
 * `PROJECT_SPEC.md` §129 / §180: never log API keys, passwords, access tokens or secrets. Relying
 * on every call site to remember that is how secrets end up in production logs, so redaction is
 * centralised here and applied by `AppLogger` and by `AuditService` before anything is persisted.
 *
 * The match is on the KEY NAME, case-insensitively and as a substring, because the field is called
 * `apiKey` in one place and `openwa_api_key` in another. Over-redacting a harmless field is a
 * cosmetic problem; under-redacting a secret is a breach.
 */
const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'credential',
  'privatekey',
  'private_key',
  'sessioncookie',
  'cookie',
  'signature',
  'qr',
  'passwordhash',
  'securityhash',
];

export const REDACTED = '[REDACTED]';

/** Depth cap: a cyclic or pathologically nested object must not be able to hang the logger. */
const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern.replace(/[-_]/g, '')));
}

/**
 * Returns a redacted deep copy. The input is never mutated — callers frequently pass live entities,
 * and redacting one in place would corrupt the object the request is still using.
 */
export function redact<T>(value: T): T {
  return redactInternal(value, 0, new WeakSet()) as T;
}

function redactInternal(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[TRUNCATED]';

  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}b]`;

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return value.map((item) => redactInternal(item, depth + 1, seen));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '[CIRCULAR]';
    seen.add(obj);

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactInternal(v, depth + 1, seen);
    }
    return out;
  }

  return value;
}
