import { buildSystemPrompt, mergePersonality, RESTRICTED_OPERATIONS } from './ai-instructions';
import { parseStructuredVerdict, classifyHttpFailure } from './providers/generation-provider';

/**
 * The two pure pieces of the AI layer, and the two most consequential.
 *
 * What the model is told decides what a customer is told, and how a response is parsed decides
 * whether a malformed answer becomes a confident reply. Both are pure functions precisely so they
 * can be pinned here without standing anything up.
 */

describe('personality merging (§23, §24)', () => {
  it('lets a more specific scope override a broader one, field by field', () => {
    const merged = mergePersonality(
      { tone: 'formal', language: 'en', emojiLevel: 'none' },
      { language: 'bn' },
    );

    expect(merged.language).toBe('bn');
    // Untouched by the narrower layer, so the broader value survives.
    expect(merged.tone).toBe('formal');
    expect(merged.emojiLevel).toBe('none');
  });

  it('accumulates instructions instead of replacing them', () => {
    // The load-bearing case: a group operator adding a note must not silently drop the
    // company-wide rule above it.
    const merged = mergePersonality(
      { systemInstructions: 'Never quote prices.' },
      { systemInstructions: 'Mention the Dhaka office hours.' },
    );

    expect(merged.systemInstructions).toContain('Never quote prices.');
    expect(merged.systemInstructions).toContain('Mention the Dhaka office hours.');
  });

  it('ignores layers that set nothing', () => {
    const merged = mergePersonality({ tone: 'friendly' }, null, undefined, {});
    expect(merged.tone).toBe('friendly');
  });
});

describe('system prompt assembly', () => {
  it('always carries the no-invention rules and the restricted operations', () => {
    const prompt = buildSystemPrompt({ personality: {} });

    expect(prompt).toContain('ONLY from the approved knowledge');
    expect(prompt).toContain('Do not invent company policy');
    for (const operation of RESTRICTED_OPERATIONS) {
      expect(prompt).toContain(operation);
    }
  });

  it('marks the summary and customer facts as context, not as approved knowledge', () => {
    const prompt = buildSystemPrompt({
      personality: {},
      summary: 'Customer reported a fibre cut yesterday.',
      customerFacts: ['On the 20 Mbps package.'],
    });

    // The distinction matters: a summary saying "we told them 500 taka" is not a price list.
    expect(prompt).toContain('context only');
    expect(prompt).toContain('fibre cut yesterday');
    expect(prompt).toContain('20 Mbps package');
  });

  it('never asks the model for its reasoning', () => {
    const prompt = buildSystemPrompt({ personality: {} });
    expect(prompt).toContain('Do not include your reasoning steps');
    expect(prompt).not.toMatch(/think step by step|chain of thought/i);
  });

  it('renders each language setting as an explicit instruction', () => {
    expect(buildSystemPrompt({ personality: { language: 'bn' } })).toContain('Reply in Bangla');
    expect(buildSystemPrompt({ personality: { language: 'mixed' } })).toContain('mix of Bangla and English');
    expect(buildSystemPrompt({ personality: {} })).toContain('language the customer wrote in');
  });
});

describe('structured verdict parsing (§144)', () => {
  it('reads a well-formed verdict', () => {
    const verdict = parseStructuredVerdict(
      JSON.stringify({
        decision: 'ANSWER',
        answer: 'We are open 9am to 9pm.',
        confidence: 0.91,
        reason: 'Covered by the opening-hours article.',
        knowledgeSufficient: true,
        needsHuman: false,
        citedIds: ['chunk-1'],
      }),
    );

    expect(verdict.decision).toBe('ANSWER');
    expect(verdict.answer).toBe('We are open 9am to 9pm.');
    expect(verdict.confidence).toBe(0.91);
    expect(verdict.citedIds).toEqual(['chunk-1']);
  });

  it('unwraps a verdict the provider wrapped in prose or a code fence', () => {
    const verdict = parseStructuredVerdict('Sure!\n```json\n{"decision":"ANSWER","answer":"Yes","confidence":0.9,"knowledgeSufficient":true,"needsHuman":false,"citedIds":[]}\n```');
    expect(verdict.decision).toBe('ANSWER');
    expect(verdict.answer).toBe('Yes');
  });

  it('treats malformed output as a failure and escalates, rather than parsing optimistically', () => {
    for (const malformed of ['not json at all', '{"decision":', '', '[]']) {
      const verdict = parseStructuredVerdict(malformed);
      expect(verdict.decision).toBe('ESCALATE');
      expect(verdict.answer).toBeNull();
      expect(verdict.needsHuman).toBe(true);
    }
  });

  it('refuses to answer when the provider said ANSWER but supplied no answer', () => {
    const verdict = parseStructuredVerdict(
      JSON.stringify({ decision: 'ANSWER', answer: '   ', confidence: 0.99, knowledgeSufficient: true }),
    );
    expect(verdict.decision).toBe('ESCALATE');
  });

  it('treats an out-of-range or non-numeric confidence as absent, never as a number', () => {
    // Absent is a signal the policy already handles. A fabricated 0 or 1 is not.
    for (const value of [1.7, -0.2, 'high', null, undefined, NaN]) {
      const verdict = parseStructuredVerdict(
        JSON.stringify({ decision: 'ANSWER', answer: 'x', confidence: value, knowledgeSufficient: true }),
      );
      expect(verdict.confidence).toBeNull();
    }
  });

  it('defaults the safety flags to the cautious reading when they are missing', () => {
    const verdict = parseStructuredVerdict(JSON.stringify({ decision: 'ANSWER', answer: 'x' }));
    expect(verdict.knowledgeSufficient).toBe(false);
  });
});

describe('failure classification (§123)', () => {
  it('marks rate limits and server errors retryable, and rejections permanent', () => {
    expect(classifyHttpFailure(429, 'openai').retryable).toBe(true);
    expect(classifyHttpFailure(503, 'openai').retryable).toBe(true);
    expect(classifyHttpFailure(401, 'openai').retryable).toBe(false);
    expect(classifyHttpFailure(400, 'openai').retryable).toBe(false);
  });

  it('never puts a credential or a response body in the message', () => {
    const error = classifyHttpFailure(401, 'anthropic');
    expect(error.message).toContain('401');
    expect(error.message).toMatch(/rejected the credential/);
    expect(error.message).not.toMatch(/sk-|Bearer|api[_-]?key/i);
  });
});
