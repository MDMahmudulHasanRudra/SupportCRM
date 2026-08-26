import { composePermission, primaryBlocker } from './permission-chain';

/**
 * The permission chain: the composed answer and its explanation.
 *
 * The property that matters most is the one connecting them — `effective` is true exactly when
 * `blockedBy` is empty. Two independent derivations of "is AI allowed here" would eventually
 * disagree, and the console would confidently name a switch that is not the one at fault (or worse,
 * report a block while the engine replies). These tests pin them together.
 */
describe('permission chain', () => {
  describe('composition', () => {
    it('permits when every layer that applies permits', () => {
      const chain = composePermission({ conversation: true, group: true, profile: true });
      expect(chain.effective).toBe(true);
      expect(chain.blockedBy).toEqual([]);
    });

    it.each([
      ['group', { conversation: true, group: false, profile: true }, 'GROUP'],
      ['conversation', { conversation: false, group: true, profile: true }, 'CONVERSATION'],
      ['profile', { conversation: true, group: true, profile: false }, 'PROFILE'],
    ])('a single %s veto blocks and is named', (_label, input, expected) => {
      const chain = composePermission(input);
      expect(chain.effective).toBe(false);
      expect(chain.blockedBy).toEqual([expected]);
    });

    it('does not let a permissive profile override a muted group', () => {
      // The specific refactor this guards against: "most specific wins" instead of composition.
      const chain = composePermission({ conversation: true, group: false, profile: true });
      expect(chain.effective).toBe(false);
      expect(chain.blockedBy).toContain('GROUP');
    });

    it('names every layer withholding permission, not just the first', () => {
      // Telling an operator to switch the group back on is wrong when the conversation is muted too.
      const chain = composePermission({ conversation: false, group: false, profile: false });
      expect(chain.blockedBy).toEqual(['PROFILE', 'GROUP', 'CONVERSATION']);
    });
  });

  describe('an absent layer is not a denial', () => {
    it('treats a null group as not applying, so a direct chat is still permitted', () => {
      // A one-to-one conversation has no group. If absence read as false, AI would be off for every
      // direct chat in the product.
      const chain = composePermission({ conversation: true, group: null, profile: null });
      expect(chain.effective).toBe(true);
      expect(chain.blockedBy).toEqual([]);
    });

    it('keeps null distinct from false in the reported layers', () => {
      const chain = composePermission({ conversation: true, group: null, profile: false });
      expect(chain.group).toBeNull();
      expect(chain.blockedBy).toEqual(['PROFILE']);
    });
  });

  describe('the explanation cannot contradict the permission', () => {
    // Exhaustive over every combination the layers can take: 2 conversation × 3 group × 3 profile.
    const values: Array<boolean | null> = [true, false, null];
    const combinations = [true, false].flatMap((conversation) =>
      values.flatMap((group) => values.map((profile) => ({ conversation, group, profile }))),
    );

    it.each(combinations)('effective === (blockedBy empty) for %j', (input) => {
      const chain = composePermission(input);
      expect(chain.effective).toBe(chain.blockedBy.length === 0);
    });

    it.each(combinations)('effective matches plain AND composition for %j', (input) => {
      // Independently recomputed the obvious way. If this ever diverges, the chain has changed the
      // safety semantics rather than merely explaining them.
      const expected =
        input.conversation && input.group !== false && input.profile !== false;
      expect(composePermission(input).effective).toBe(expected);
    });

    it.each(combinations)('names a blocker exactly when blocked for %j', (input) => {
      const chain = composePermission(input);
      expect(primaryBlocker(chain) === null).toBe(chain.effective);
    });
  });

  describe('the primary blocker is the most specific one', () => {
    it('prefers the conversation over the group', () => {
      // The narrowest switch is the one an operator should act on first.
      const chain = composePermission({ conversation: false, group: false, profile: false });
      expect(primaryBlocker(chain)).toBe('CONVERSATION');
    });

    it('falls back to the group when the conversation permits', () => {
      const chain = composePermission({ conversation: true, group: false, profile: false });
      expect(primaryBlocker(chain)).toBe('GROUP');
    });

    it('is null when nothing is blocking', () => {
      expect(primaryBlocker(composePermission({ conversation: true, group: true, profile: true }))).toBeNull();
    });
  });
});
