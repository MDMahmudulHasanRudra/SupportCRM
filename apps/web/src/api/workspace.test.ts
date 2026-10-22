import { describe, expect, it } from 'vitest';
import { money, toMinor } from './workspace';

describe('Billing currency amounts', () => {
  it('converts decimal input without binary floating point rounding', () => {
    expect(toMinor('19.99', 'BDT')).toBe(1999);
    expect(toMinor('0.29', 'USD')).toBe(29);
    expect(toMinor('100', 'JPY')).toBe(100);
    expect(toMinor('1.125', 'KWD')).toBe(1125);
  });
  it('rejects excess precision, non-positive amounts and unsafe numbers', () => {
    for (const n of ['1.001','-1','0','Infinity','1e3','999999999999999999']) expect(() => toMinor(n, 'USD')).toThrow();
    expect(() => toMinor('1.1', 'JPY')).toThrow();
  });
  it('formats zero-decimal and three-decimal currencies correctly', () => {
    expect(money('100','JPY')).toContain('100');
    expect(money('1125','KWD')).toContain('1.125');
    expect(money('9007199254740993','USD')).toBe('$90,071,992,547,409.93');
  });
});
