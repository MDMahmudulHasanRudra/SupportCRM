/**
 * The vocabulary of the AI layer (`PROJECT_SPEC.md` §16–§27).
 *
 * Kept apart from the entities so the pure parts — instruction assembly, policy, provider
 * selection — can be tested without a database, and so the decision modules can import these
 * without importing TypeORM.
 */

/** The wire protocol, not the brand. Most vendors speak `compatible`. */
export enum AIProviderKind {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GEMINI = 'gemini',
  OPENROUTER = 'openrouter',
  COMPATIBLE = 'compatible',
}

/**
 * Which job a model is being asked to do.
 *
 * Separate slots because the jobs differ in cost and in what "good" means: answering a customer
 * needs the best model available, summarising a thread does not, and paying for the former to do
 * the latter is how an AI budget disappears.
 */
export enum AIJobSlot {
  DECISION = 'DECISION',
  SUMMARY = 'SUMMARY',
  CLASSIFY = 'CLASSIFY',
}

export enum AIConfigScope {
  GLOBAL = 'GLOBAL',
  PROFILE = 'PROFILE',
  GROUP = 'GROUP',
}

export enum AIMessageRole {
  SYSTEM = 'SYSTEM',
  CUSTOMER = 'CUSTOMER',
  ASSISTANT = 'ASSISTANT',
  SUMMARY = 'SUMMARY',
}

export enum AIFeedbackVerdict {
  CORRECT = 'CORRECT',
  WRONG = 'WRONG',
  EDITED = 'EDITED',
  ESCALATE = 'ESCALATE',
}

/** How the answer should sound (§23). Every field optional: a scope states only what it changes. */
export interface AIPersonality {
  tone?: string | null;
  language?: string | null;
  answerLength?: string | null;
  emojiLevel?: string | null;
  technicalLevel?: string | null;
  systemInstructions?: string | null;
}

/** Everything resolved for one AI call, after the Global → Profile → Group merge. */
export interface ResolvedAIConfig extends AIPersonality {
  providerId: string | null;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
}

export const TONES = ['neutral', 'friendly', 'formal', 'concise'] as const;
export const LANGUAGES = ['auto', 'en', 'bn', 'mixed'] as const;
export const ANSWER_LENGTHS = ['short', 'medium', 'detailed'] as const;
export const EMOJI_LEVELS = ['none', 'minimal', 'expressive'] as const;
export const TECHNICAL_LEVELS = ['plain', 'balanced', 'technical'] as const;
