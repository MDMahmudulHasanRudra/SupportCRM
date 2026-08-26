import { EscalationReason } from './entities/escalation.entity';
import {
  asksForHuman,
  EscalationPriority,
  mergeEscalationPolicy,
  repeatsComplaint,
  scoreEscalation,
} from './escalation-policy';

/**
 * The rules that decide when a person is fetched.
 *
 * Pure, so they can be pinned exactly. The consequential half is the negative space: a customer who
 * asked for a human must never be talked out of it by a confident model, and a message that merely
 * mentions the word "agent" in passing should not summon one.
 */

describe('human request detection (§39)', () => {
  it('recognises the English phrasings people actually use', () => {
    for (const text of [
      'can I talk to a human please',
      'I want to speak with someone',
      'give me a real person',
      'agent please',
      'connect me to customer care',
      'I need an agent',
    ]) {
      expect(asksForHuman(text)).toBe(true);
    }
  });

  it('recognises Bangla, in script and romanised', () => {
    for (const text of [
      'আমি মানুষের সাথে কথা বলতে চাই',
      'একজন এজেন্ট দেন',
      'কাস্টমার কেয়ার নাম্বার দেন',
      'ami manusher sathe kotha bolte chai',
      'agent chai',
      'support lagbe',
    ]) {
      expect(asksForHuman(text)).toBe(true);
    }
  });

  it('is not defeated by punctuation, case or repeated spaces', () => {
    expect(asksForHuman('AGENT,   PLEASE!!!')).toBe(true);
    expect(asksForHuman('Talk   To   A   Human?')).toBe(true);
  });

  it('does not fire on ordinary support questions', () => {
    for (const text of [
      'my internet is slow since morning',
      'what are your office hours',
      'the router light is red',
      'please check my connection',
      'আমার ইন্টারনেট কাজ করছে না',
      '',
    ]) {
      expect(asksForHuman(text)).toBe(false);
    }
  });

  it('handles null and undefined without throwing', () => {
    expect(asksForHuman(null)).toBe(false);
    expect(asksForHuman(undefined)).toBe(false);
  });
});

describe('repeated complaint detection (§28)', () => {
  it('recognises "still not working" in its common forms', () => {
    expect(repeatsComplaint('still not working')).toBe(true);
    expect(repeatsComplaint('same problem again')).toBe(true);
    expect(repeatsComplaint('ekhono hoy na')).toBe(true);
    expect(repeatsComplaint('এখনো হচ্ছে না')).toBe(true);
  });

  it('does not fire on a first report', () => {
    expect(repeatsComplaint('my internet is down')).toBe(false);
  });
});

describe('escalation policy merging (§30)', () => {
  it('applies defaults, then lets each layer override what it sets', () => {
    const merged = mergeEscalationPolicy(
      { internalGroupId: 'group-a', maxAiReplies: 5 },
      { maxAiReplies: 2 },
    );

    expect(merged.internalGroupId).toBe('group-a');
    expect(merged.maxAiReplies).toBe(2);
    // Untouched by either layer, so the default stands.
    expect(merged.notifyInternalGroup).toBe(true);
  });

  it('leaves executive notification off unless somebody turns it on', () => {
    // Waking an executive is a deliberate decision, per account.
    expect(mergeEscalationPolicy({}).notifyExecutives).toBe(false);
    expect(mergeEscalationPolicy({ notifyExecutives: true }).notifyExecutives).toBe(true);
  });

  it('treats an explicit false as a real value, not as absence', () => {
    const merged = mergeEscalationPolicy({ notifyInternalGroup: true }, { notifyInternalGroup: false });
    expect(merged.notifyInternalGroup).toBe(false);
  });
});

describe('escalation scoring (§40)', () => {
  it('escalates immediately when the customer asked for a person, whatever else is true', () => {
    const verdict = scoreEscalation({ customerAskedForHuman: true }, 100);
    expect(verdict.shouldEscalate).toBe(true);
    expect(verdict.priority).toBe(EscalationPriority.URGENT);
    expect(verdict.reason).toBe(EscalationReason.CUSTOMER_REQUESTED);
  });

  it('escalates immediately for a restricted operation', () => {
    // No confidence score may authorise a billing or network change (§20, §164).
    const verdict = scoreEscalation({ sensitiveRequest: true }, 100);
    expect(verdict.shouldEscalate).toBe(true);
    expect(verdict.priority).toBe(EscalationPriority.URGENT);
  });

  it('accumulates weaker signals until they cross the threshold', () => {
    expect(scoreEscalation({ lowConfidence: true }, 5).shouldEscalate).toBe(false);

    const compounded = scoreEscalation(
      { lowConfidence: true, knowledgeMissing: true, repeatedComplaint: true },
      5,
    );
    expect(compounded.shouldEscalate).toBe(true);
  });

  it('counts repeated AI attempts', () => {
    const once = scoreEscalation({ aiAttempts: 1 }, 5);
    const many = scoreEscalation({ aiAttempts: 6 }, 5);
    expect(many.score).toBeGreaterThan(once.score);
    expect(many.shouldEscalate).toBe(true);
  });

  it('reports the strongest reason rather than the first one found', () => {
    const verdict = scoreEscalation({ lowConfidence: true, aiFailures: true, knowledgeMissing: true }, 5);
    expect(verdict.reason).toBe(EscalationReason.AI_FAILED);
  });

  it('gives a quiet conversation a low priority rather than none at all', () => {
    const verdict = scoreEscalation({}, 5);
    expect(verdict.priority).toBe(EscalationPriority.LOW);
    expect(verdict.shouldEscalate).toBe(false);
  });
});
