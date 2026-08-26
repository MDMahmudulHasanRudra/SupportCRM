import {
  CAPABILITY_KEYS,
  ChannelCapabilityError,
  NO_CAPABILITIES,
  assertCapability,
  normalizeCapabilities,
} from './channel-capabilities';

describe('channel capabilities', () => {
  it('defaults to everything disabled', () => {
    for (const key of CAPABILITY_KEYS) {
      expect(NO_CAPABILITIES[key]).toBe(false);
    }
  });

  it('fills missing keys with false rather than undefined', () => {
    const normalized = normalizeCapabilities({ canSendText: true });
    expect(normalized.canSendText).toBe(true);
    expect(normalized.canAddGroupMember).toBe(false);
    for (const key of CAPABILITY_KEYS) {
      expect(typeof normalized[key]).toBe('boolean');
    }
  });

  it('treats null and undefined as no capabilities', () => {
    expect(normalizeCapabilities(null)).toEqual(NO_CAPABILITIES);
    expect(normalizeCapabilities(undefined)).toEqual(NO_CAPABILITIES);
  });

  it('coerces truthy non-booleans to false, not true', () => {
    // A stored row could contain a string "true" from a sloppy writer. Only a real boolean counts.
    const normalized = normalizeCapabilities({ canSendText: 'true' as unknown as boolean });
    expect(normalized.canSendText).toBe(false);
  });

  it('drops unknown keys from a future or foreign adapter', () => {
    const normalized = normalizeCapabilities({ canTeleport: true } as never);
    expect(normalized).toEqual(NO_CAPABILITIES);
    expect('canTeleport' in normalized).toBe(false);
  });

  it('does not mutate the caller’s object', () => {
    const input = { canSendText: true };
    normalizeCapabilities(input);
    expect(Object.keys(input)).toEqual(['canSendText']);
  });

  it('allows an action the account supports', () => {
    expect(() => assertCapability({ ...NO_CAPABILITIES, canSendText: true }, 'canSendText', 'acc-1')).not.toThrow();
  });

  it('throws a typed, explanatory error for an unsupported action', () => {
    try {
      assertCapability(NO_CAPABILITIES, 'canAddGroupMember', 'acc-1');
      fail('expected a ChannelCapabilityError');
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelCapabilityError);
      expect((error as ChannelCapabilityError).capability).toBe('canAddGroupMember');
      expect((error as ChannelCapabilityError).channelAccountId).toBe('acc-1');
      expect((error as Error).message).toMatch(/never fake success/);
    }
  });

  it('treats never-probed capabilities as unsupported', () => {
    // The important safety case: a brand-new account row has capabilities === null.
    expect(() => assertCapability(null, 'canSendText', 'acc-new')).toThrow(ChannelCapabilityError);
  });
});
