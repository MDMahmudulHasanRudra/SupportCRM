import { describe, expect, it } from 'vitest';
import { effectiveAutomation, type AutomationLayers } from './automation-stack';

/**
 * Precedence is the whole point of this function.
 *
 * Every layer can turn automation off, and the operator is looking at the panel precisely because
 * they want to know *which one did*. Reporting the wrong reason is worse than reporting none: it
 * sends somebody to change a group flag when an emergency stop is what is actually holding things.
 */

const base: AutomationLayers = {
  globallyStopped: false,
  group: true,
  conversation: true,
  controlState: 'AUTOMATION_ACTIVE',
  pausedUntil: null,
};

describe('effectiveAutomation', () => {
  it('is on when nothing stands it down', () => {
    expect(effectiveAutomation(base)).toEqual({ on: true, reason: expect.any(String) });
  });

  it('an emergency stop outranks every other layer', () => {
    // Even with the group and conversation both on, a global stop is the reason.
    const result = effectiveAutomation({ ...base, globallyStopped: true });
    expect(result.on).toBe(false);
    expect(result.reason).toMatch(/emergency stop/i);
  });

  it('a human holding the conversation outranks the flags', () => {
    const result = effectiveAutomation({ ...base, controlState: 'HUMAN_ACTIVE' });
    expect(result.on).toBe(false);
    expect(result.reason).toMatch(/taken this conversation over/i);
  });

  it('names the group when the group is what is off', () => {
    const result = effectiveAutomation({ ...base, group: false });
    expect(result.on).toBe(false);
    expect(result.reason).toMatch(/group/i);
  });

  it('names the conversation when only the conversation is off', () => {
    const result = effectiveAutomation({ ...base, conversation: false });
    expect(result.on).toBe(false);
    expect(result.reason).toMatch(/this conversation/i);
  });

  it('treats an unknown group as not blocking', () => {
    // A direct chat has no group. Null must not be read as "off" — that would report automation as
    // disabled on every one-to-one conversation in the product.
    expect(effectiveAutomation({ ...base, group: null }).on).toBe(true);
  });

  it('treats unreadable emergency stops as not blocking', () => {
    // A reader without settings.read cannot see the stops. Guessing "stopped" would tell them
    // automation is off when it is running perfectly well.
    expect(effectiveAutomation({ ...base, globallyStopped: null }).on).toBe(true);
  });
});
