import { REDACTED, isSensitiveKey, redact } from './redact';

describe('redact', () => {
  it('redacts obviously sensitive keys', () => {
    for (const key of ['password', 'apiKey', 'api_key', 'accessToken', 'SECRET', 'authorization']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('leaves ordinary keys alone', () => {
    for (const key of ['email', 'username', 'conversationId', 'status', 'name']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('redacts values but keeps the surrounding shape', () => {
    const input = {
      username: 'admin',
      password: 'hunter2',
      nested: { apiKey: 'sk-live-123', model: 'gpt-4' },
    };
    expect(redact(input)).toEqual({
      username: 'admin',
      password: REDACTED,
      nested: { apiKey: REDACTED, model: 'gpt-4' },
    });
  });

  it('does not mutate the input', () => {
    const input = { password: 'hunter2' };
    redact(input);
    expect(input.password).toBe('hunter2');
  });

  it('redacts inside arrays', () => {
    const out = redact({ providers: [{ name: 'openai', apiKey: 'sk-1' }] }) as any;
    expect(out.providers[0]).toEqual({ name: 'openai', apiKey: REDACTED });
  });

  it('survives circular references', () => {
    const a: any = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect(redact(a)).toEqual({ name: 'a', self: '[CIRCULAR]' });
  });

  it('truncates pathological nesting instead of hanging', () => {
    let deep: any = { value: 'bottom' };
    for (let i = 0; i < 50; i++) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[TRUNCATED]');
  });

  it('preserves primitives, dates and errors usefully', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    expect(redact(date)).toBe(date);
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    const err = redact(new Error('boom')) as any;
    expect(err.message).toBe('boom');
  });

  it('never lets a buffer body reach the log', () => {
    expect(redact({ blob: Buffer.from('secret bytes') }) as any).toEqual({ blob: '[Buffer 12b]' });
  });
});
