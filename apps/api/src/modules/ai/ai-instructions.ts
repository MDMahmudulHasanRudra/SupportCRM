import type { AIPersonality } from './ai-types';

/**
 * Assembling the system prompt (`PROJECT_SPEC.md` §18, §20, §23, §24).
 *
 * Pure on purpose: no database, no clock, no network. What the model is told is the single most
 * consequential input to what a customer receives, so it must be reproducible from its arguments
 * and testable without standing anything up.
 *
 * Three bands, in a fixed order:
 *
 *  1. **The rules that never move.** Answer only from approved knowledge; never invent policy,
 *     prices or procedures; escalate rather than guess; refuse restricted operations.
 *  2. **Personality**, merged Global → Profile → Group.
 *  3. **Layered instructions**, broadest first, each appended rather than replacing — a group
 *     operator adding "mention the Dhaka office hours" must not thereby drop the company-wide rule
 *     about never quoting prices.
 *
 * The safety band is emitted last within the prompt rather than first. Instruction-following
 * degrades with distance in most models, and a later instruction generally wins over an earlier
 * one — so the constraints a customer could be harmed by sit closest to the answer.
 */

/**
 * Operations no confidence score may authorise (§20, §164–§165).
 *
 * Naming them in the prompt is a first line, not the only one — the decision policy blocks these
 * independently. Both exist because either alone has been enough to produce a bad day somewhere.
 */
export const RESTRICTED_OPERATIONS = [
  'changing production network configuration',
  'deleting or resetting customer data',
  'billing changes, refunds or credits',
  'account ownership or contact changes',
  'anything security-sensitive or destructive',
] as const;

const BASE_RULES = [
  'You are a customer support assistant for an internet service provider.',
  'You answer ONLY from the approved knowledge supplied in this request.',
  '',
  'Rules you must follow without exception:',
  '- Do not invent company policy, prices, package details, dates or technical procedures.',
  '- Do not state anything the supplied knowledge does not support.',
  '- If the supplied knowledge does not cover the question, set knowledgeSufficient to false and',
  '  decision to ESCALATE. Saying "I do not know" is correct and useful; guessing is not.',
  '- If the customer asks for a human, is angry, or the situation needs judgement, set needsHuman',
  '  to true. Never argue with a customer who asks for a person.',
];

const OUTPUT_CONTRACT = [
  'Respond with JSON only, matching exactly this shape:',
  '{"decision":"ANSWER"|"ESCALATE","answer":string|null,"confidence":number,' +
    '"reason":string,"knowledgeSufficient":boolean,"needsHuman":boolean,"citedIds":string[]}',
  '',
  'confidence is your own honest self-assessment from 0 to 1 that the answer is correct AND',
  'supported by the supplied knowledge. Do not inflate it.',
  'reason is one short sentence. Do not include your reasoning steps anywhere in the output.',
];

/** Merges personality layers, broadest first. A later layer overrides a field it actually sets. */
export function mergePersonality(...layers: Array<AIPersonality | null | undefined>): AIPersonality {
  const merged: AIPersonality = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.tone) merged.tone = layer.tone;
    if (layer.language) merged.language = layer.language;
    if (layer.answerLength) merged.answerLength = layer.answerLength;
    if (layer.emojiLevel) merged.emojiLevel = layer.emojiLevel;
    if (layer.technicalLevel) merged.technicalLevel = layer.technicalLevel;
    // Instructions accumulate rather than overwrite — see the note at the top of this file.
    if (layer.systemInstructions?.trim()) {
      merged.systemInstructions = [merged.systemInstructions, layer.systemInstructions.trim()]
        .filter(Boolean)
        .join('\n');
    }
  }
  return merged;
}

export function describePersonality(personality: AIPersonality): string[] {
  const lines: string[] = [];

  if (personality.tone) lines.push(`- Tone: ${personality.tone}.`);

  switch (personality.language) {
    case 'bn':
      lines.push('- Reply in Bangla.');
      break;
    case 'en':
      lines.push('- Reply in English.');
      break;
    case 'mixed':
      lines.push('- Reply in the mix of Bangla and English the customer uses, matching their style.');
      break;
    case 'auto':
    case undefined:
    case null:
      lines.push("- Reply in the language the customer wrote in.");
      break;
    default:
      lines.push(`- Reply in ${personality.language}.`);
  }

  switch (personality.answerLength) {
    case 'short':
      lines.push('- Keep the answer to one or two sentences.');
      break;
    case 'detailed':
      lines.push('- Give a complete answer, with steps where they help.');
      break;
    default:
      lines.push('- Keep the answer short, plain and directly useful. No preamble.');
  }

  switch (personality.emojiLevel) {
    case 'none':
      lines.push('- Use no emoji.');
      break;
    case 'expressive':
      lines.push('- A little emoji is welcome where it helps warmth.');
      break;
    default:
      lines.push('- At most one emoji, and only where it genuinely helps.');
  }

  switch (personality.technicalLevel) {
    case 'technical':
      lines.push('- The customer is technical; precise terms are fine.');
      break;
    case 'plain':
      lines.push('- Avoid jargon entirely. Explain in everyday words.');
      break;
    default:
      lines.push('- Prefer plain words; explain any technical term you must use.');
  }

  return lines;
}

/**
 * The full system prompt for a decision.
 *
 * `memory` carries the rolling conversation summary and any approved customer facts. Both are
 * supplied as context, never as authority: the model is told explicitly that they do not replace
 * approved knowledge, because a summary saying "we told them it's ৳500" is not a price list.
 */
export function buildSystemPrompt(input: {
  personality: AIPersonality;
  summary?: string | null;
  customerFacts?: string[];
}): string {
  const sections: string[] = [...BASE_RULES];

  sections.push('', 'How to sound:', ...describePersonality(input.personality));

  if (input.personality.systemInstructions?.trim()) {
    sections.push('', 'Additional instructions from your operators:', input.personality.systemInstructions.trim());
  }

  if (input.summary?.trim()) {
    sections.push(
      '',
      'What has happened in this conversation so far (context only — it is not approved knowledge):',
      input.summary.trim(),
    );
  }

  if (input.customerFacts?.length) {
    sections.push(
      '',
      'Approved facts about this customer (context only):',
      ...input.customerFacts.map((fact) => `- ${fact}`),
    );
  }

  sections.push(
    '',
    'Operations you must never carry out or promise, whatever your confidence:',
    ...RESTRICTED_OPERATIONS.map((operation) => `- ${operation}`),
    'For any of those, set needsHuman to true and decision to ESCALATE.',
    '',
    ...OUTPUT_CONTRACT,
  );

  return sections.join('\n');
}

/** The system prompt for the summariser. A different job, so a different, much smaller brief. */
export const SUMMARY_SYSTEM_PROMPT = [
  'You maintain a running summary of a customer support conversation.',
  'Rewrite the summary so it captures, in at most 150 words:',
  '- the issue the customer reported',
  '- what has been attempted',
  '- the current state',
  '- anything still unresolved',
  '- decisions a human made',
  '- whether it has been escalated',
  '',
  'Write plain sentences. Do not invent anything that is not in the material supplied.',
  'Do not include your reasoning. Output the summary text only.',
].join('\n');
