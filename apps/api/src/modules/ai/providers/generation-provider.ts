import { AIProviderKind } from '../ai-types';
import { AIProviderError, type AIDecisionRequest, type AIDecisionResult } from '../../../common/ai/ai-provider';

/**
 * One vendor, reduced to one method (`PROJECT_SPEC.md` §21).
 *
 * The Decision Engine never learns which vendor answered. It asks for a structured verdict and
 * receives one, or receives a classified error it can act on. Everything vendor-shaped —
 * authentication header, request envelope, where the JSON hides in the response — lives behind
 * this boundary, which is why adding OpenRouter cost nothing and adding Gemini cost one function.
 */
export interface GenerationProvider {
  readonly kind: AIProviderKind;
  /**
   * Ask for a decision.
   *
   * Must either return a fully-populated result or throw `AIProviderError` with `retryable` set
   * honestly — the fallback chain and the circuit breaker both act on that flag, and a timeout
   * reported as permanent takes a working provider out of service.
   */
  decide(request: AIDecisionRequest, options: ProviderCallOptions): Promise<AIDecisionResult>;
  /** Free-form generation, for summaries. Plain text out; no structure expected. */
  complete(prompt: string, system: string, options: ProviderCallOptions): Promise<CompletionResult>;
}

export interface ProviderCallOptions {
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  timeoutMs: number;
  temperature?: number | null;
  maxTokens?: number | null;
  /** The assembled system prompt: rules, personality and layered instructions. */
  system: string;
}

export interface CompletionResult {
  text: string;
  usage: { promptTokens: number | null; completionTokens: number | null };
}

/**
 * The shape every provider must return, parsed defensively.
 *
 * A model that returns malformed JSON has failed, and §144 is explicit that a malformed response
 * is treated as a failure rather than parsed optimistically. The safe reading of "I could not
 * understand the model" is ESCALATE — never "answer anyway with whatever survived the parse".
 */
export function parseStructuredVerdict(raw: string): AIDecisionResult {
  const escalate = (reason: string): AIDecisionResult => ({
    decision: 'ESCALATE',
    answer: null,
    confidence: null,
    reason,
    knowledgeSufficient: false,
    needsHuman: true,
    citedIds: [],
    usage: { promptTokens: null, completionTokens: null },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return escalate('The AI provider returned something that was not the agreed JSON shape.');
  }

  // An array parses cleanly and is not a verdict. Without this it would fall through to the field
  // reads below, where every field is missing — producing an ESCALATE that looks like a considered
  // one rather than the parse failure it actually is.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return escalate('The AI provider returned a value that was not a verdict object.');
  }

  const value = parsed as Record<string, unknown>;
  const decision = value.decision === 'ANSWER' ? 'ANSWER' : 'ESCALATE';
  const answer = typeof value.answer === 'string' && value.answer.trim() ? value.answer.trim() : null;

  // A confidence that is not a number in range is *absent*, not zero and not one. Absent is a
  // signal the policy already knows how to treat; a fabricated number is not.
  const rawConfidence = typeof value.confidence === 'number' ? value.confidence : null;
  const confidence =
    rawConfidence !== null && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
      ? rawConfidence
      : null;

  return {
    decision: decision === 'ANSWER' && answer ? 'ANSWER' : 'ESCALATE',
    answer,
    confidence,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 500) : null,
    knowledgeSufficient: value.knowledgeSufficient === true,
    needsHuman: value.needsHuman === true,
    citedIds: Array.isArray(value.citedIds) ? value.citedIds.filter((id): id is string => typeof id === 'string') : [],
    usage: { promptTokens: null, completionTokens: null },
  };
}

/**
 * Pulls the JSON object out of a response that may be wrapped.
 *
 * Some providers honour a JSON response mode exactly; others wrap it in a fenced code block or add
 * a sentence in front. Trimming to the outermost braces handles both without being clever enough
 * to "repair" genuinely broken output.
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** Turns an HTTP status into the retryability the fallback chain needs. Never echoes a body. */
export function classifyHttpFailure(status: number, provider: string): AIProviderError {
  if (status === 429) {
    return new AIProviderError(`${provider} rate-limited the request (429).`, true, 'RATE_LIMITED');
  }
  if (status >= 500) {
    return new AIProviderError(`${provider} returned a server error (${status}).`, true, 'FAILED');
  }
  if (status === 401 || status === 403) {
    // Retrying will fail identically, and the message says nothing about the credential itself.
    return new AIProviderError(`${provider} rejected the credential (${status}).`, false, 'FAILED');
  }
  return new AIProviderError(`${provider} rejected the request (${status}).`, false, 'FAILED');
}

/** A fetch with a hard deadline, because a hung provider must not hold an inbound message open. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    throw new AIProviderError(
      aborted ? `${provider} did not respond within ${Math.round(timeoutMs / 1000)}s.` : `${provider} was unreachable.`,
      true,
      aborted ? 'TIMEOUT' : 'FAILED',
    );
  } finally {
    clearTimeout(timer);
  }
}
