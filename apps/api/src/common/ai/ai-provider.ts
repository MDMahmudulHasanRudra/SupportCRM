import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The generation provider.
 *
 * Sibling to `EmbeddingService`, deliberately separate: embeddings and generation have different
 * failure modes, different cost profiles and different configuration, and one class doing both
 * would hide that.
 *
 * The Decision Engine talks to this interface and never to a vendor. It does not know which
 * provider answered, only that it received a structured result.
 *
 * ## What this file refuses to do
 *
 * **It does not invent an answer.** No provider configured means `available === false`, and the
 * engine escalates instead of replying. There is no offline fallback that produces plausible text,
 * because plausible text with nothing behind it is exactly the failure this system exists to avoid.
 *
 * **It does not invent confidence.** The provider is asked for a self-assessment and that number is
 * returned as-is, marked uncalibrated. `DecisionPolicy` is where it is combined with the objective
 * signals — whether knowledge was retrieved, whether the model itself said the knowledge was
 * insufficient — and those signals can only ever *lower* the outcome.
 */

export interface AIDecisionRequest {
  /** The customer's message. */
  question: string;
  /** Recent turns, oldest first, already truncated to the configured budget. */
  history: Array<{ role: 'customer' | 'agent'; text: string }>;
  /** Retrieved passages with their citations. Empty means nothing relevant was found. */
  knowledge: Array<{ id: string; title: string | null; content: string }>;
  /** Free-text guidance from the automation profile, if any. */
  guidance?: string | null;
  language?: string;
}

export interface AIDecisionResult {
  /** ANSWER or ESCALATE. The provider's own recommendation. */
  decision: 'ANSWER' | 'ESCALATE';
  answer: string | null;
  /** Self-reported, 0..1, uncalibrated. Never treated as a probability. */
  confidence: number | null;
  reason: string | null;
  /** The provider's own judgement of whether the supplied knowledge covered the question. */
  knowledgeSufficient: boolean;
  needsHuman: boolean;
  /** Which of the supplied passage ids the answer actually drew on. */
  citedIds: string[];
  usage: { promptTokens: number | null; completionTokens: number | null };
}

export class AIUnavailableError extends Error {
  constructor(message = 'No AI provider is configured') {
    super(message);
    this.name = 'AIUnavailableError';
  }
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: 'TIMEOUT' | 'RATE_LIMITED' | 'FAILED' = 'FAILED',
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

/**
 * The instructions that keep the model inside approved knowledge (`PROJECT_SPEC.md` §18 of the
 * brief).
 *
 * Every clause here exists because the alternative is a support system that confidently tells a
 * customer a price, a policy or a procedure that nobody at the company ever approved.
 */
const SYSTEM_PROMPT = [
  'You are a customer support assistant for an internet service provider.',
  'You answer ONLY from the approved knowledge supplied in this request.',
  '',
  'Rules you must follow without exception:',
  '- Do not invent company policy, prices, package details, dates or technical procedures.',
  '- Do not state anything the supplied knowledge does not support.',
  '- If the supplied knowledge does not cover the question, set knowledgeSufficient to false and',
  '  decision to ESCALATE. Saying "I do not know" is correct and useful; guessing is not.',
  '- If the customer asks for a human, is angry, or the situation needs judgement, set needsHuman',
  '  to true.',
  '- Keep the answer short, plain and directly useful. No preamble.',
  '',
  'Respond with JSON only, matching exactly this shape:',
  '{"decision":"ANSWER"|"ESCALATE","answer":string|null,"confidence":number,' +
    '"reason":string,"knowledgeSufficient":boolean,"needsHuman":boolean,"citedIds":string[]}',
  '',
  'confidence is your own honest self-assessment from 0 to 1 that the answer is correct AND',
  'supported by the supplied knowledge. Do not inflate it.',
].join('\n');

const REQUEST_TIMEOUT_MS = 45_000;

@Injectable()
export class AIProviderService {
  constructor(private readonly config: ConfigService) {}

  private get provider(): 'none' | 'openai' | 'test' {
    return this.config.get<'none' | 'openai' | 'test'>('ai.provider') ?? 'none';
  }

  get available(): boolean {
    if (this.provider === 'none') return false;
    if (this.provider === 'test') return true;
    return Boolean(this.config.get<string>('ai.apiKey'));
  }

  get name(): string {
    return this.provider;
  }

  get model(): string {
    return this.provider === 'test'
      ? 'scripted-test'
      : (this.config.get<string>('ai.model') ?? 'unknown');
  }

  /** What the API and UI may show. Whether a credential exists — never the credential. */
  describe(): { available: boolean; provider: string; model: string | null } {
    return { available: this.available, provider: this.provider, model: this.available ? this.model : null };
  }

  async decide(request: AIDecisionRequest): Promise<AIDecisionResult> {
    switch (this.provider) {
      case 'none':
        throw new AIUnavailableError();
      case 'test':
        return this.decideScripted(request);
      case 'openai':
        return this.decideOpenAiCompatible(request);
    }
  }

  /**
   * A real OpenAI-compatible chat completion, asked for JSON.
   *
   * Failures are classified so the caller knows whether retrying could help: a timeout or a 429 is
   * transient, a 400 means the request is wrong and will stay wrong.
   */
  private async decideOpenAiCompatible(request: AIDecisionRequest): Promise<AIDecisionResult> {
    const apiKey = this.config.get<string>('ai.apiKey');
    if (!apiKey) throw new AIUnavailableError('AI provider has no credential configured');

    const baseUrl = this.config.getOrThrow<string>('ai.baseUrl').replace(/\/+$/, '');
    const temperature = this.config.get<number>('ai.temperature') ?? 0.2;
    const maxTokens = this.config.get<number>('ai.maxTokens') ?? 700;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: this.config.get<string>('ai.systemPrompt') || SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(request) },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      throw new AIProviderError(
        timedOut ? 'The AI provider did not respond in time' : 'The AI provider is unreachable',
        true,
        timedOut ? 'TIMEOUT' : 'FAILED',
      );
    }

    if (!response.ok) {
      // Status only. The body can echo the request, and the request contains customer content and
      // retrieved knowledge.
      throw new AIProviderError(
        `The AI provider returned ${response.status}`,
        response.status === 429 || response.status >= 500,
        response.status === 429 ? 'RATE_LIMITED' : 'FAILED',
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new AIProviderError('The AI provider returned an empty response', true);

    return {
      ...parseStructured(content),
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
      },
    };
  }

  /**
   * The scripted test provider.
   *
   * Deterministic and offline, so the integration suite can exercise every branch of the confidence
   * policy — high, middling, low, needs-human, insufficient-knowledge, malformed — without a
   * network or a credential. Its behaviour is driven by `ai.testScript`, which the tests set.
   *
   * Refused in production by env validation, for the same reason the deterministic embedding
   * provider is: an answer with nothing behind it must never reach a customer.
   */
  private decideScripted(request: AIDecisionRequest): AIDecisionResult {
    const script = this.config.get<Record<string, unknown>>('ai.testScript') ?? {};

    if (script.throw === 'timeout') throw new AIProviderError('scripted timeout', true, 'TIMEOUT');
    if (script.throw === 'rate_limit') throw new AIProviderError('scripted rate limit', true, 'RATE_LIMITED');
    if (script.throw === 'failed') throw new AIProviderError('scripted provider failure', false);
    if (script.throw === 'malformed') {
      // Exercises the parser's rejection path: a provider that returns prose where JSON was asked
      // for is a real and common failure.
      return { ...parseStructured('I am not JSON at all'), usage: { promptTokens: null, completionTokens: null } };
    }

    const hasKnowledge = request.knowledge.length > 0;

    return {
      decision: (script.decision as 'ANSWER' | 'ESCALATE') ?? (hasKnowledge ? 'ANSWER' : 'ESCALATE'),
      answer: (script.answer as string) ?? (hasKnowledge ? 'Scripted answer from approved knowledge.' : null),
      confidence: typeof script.confidence === 'number' ? script.confidence : hasKnowledge ? 0.95 : 0.2,
      reason: (script.reason as string) ?? 'scripted',
      knowledgeSufficient:
        typeof script.knowledgeSufficient === 'boolean' ? script.knowledgeSufficient : hasKnowledge,
      needsHuman: script.needsHuman === true,
      citedIds: hasKnowledge ? request.knowledge.map((item) => item.id) : [],
      usage: { promptTokens: null, completionTokens: null },
    };
  }
}

/**
 * Parses the provider's JSON, defensively.
 *
 * A malformed response is not an answer. Rather than throwing — which would look like a provider
 * outage and be retried — it returns an ESCALATE result: the pipeline then hands the conversation
 * to a human, which is the correct outcome when the system cannot understand its own AI.
 */
export function parseStructured(raw: string): Omit<AIDecisionResult, 'usage'> {
  const escalate = (reason: string): Omit<AIDecisionResult, 'usage'> => ({
    decision: 'ESCALATE',
    answer: null,
    confidence: null,
    reason,
    knowledgeSufficient: false,
    needsHuman: true,
    citedIds: [],
  });

  let parsed: Record<string, unknown>;
  try {
    // Some providers wrap JSON in a fenced block even when asked not to.
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return escalate('The AI response could not be read as structured data');
  }

  const decision = parsed.decision === 'ANSWER' ? 'ANSWER' : 'ESCALATE';
  const answer = typeof parsed.answer === 'string' && parsed.answer.trim().length > 0 ? parsed.answer.trim() : null;

  // An ANSWER with no answer text is incoherent — treat it as an escalation rather than sending
  // an empty message to a customer.
  if (decision === 'ANSWER' && !answer) return escalate('The AI claimed to answer but produced no text');

  const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;
  const confidence = rawConfidence === null ? null : Math.max(0, Math.min(1, rawConfidence));

  return {
    decision,
    answer,
    confidence,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : null,
    knowledgeSufficient: parsed.knowledgeSufficient !== false,
    needsHuman: parsed.needsHuman === true,
    citedIds: Array.isArray(parsed.citedIds) ? parsed.citedIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

/** The user turn: knowledge, then history, then the question. Nothing else. */
function buildUserPrompt(request: AIDecisionRequest): string {
  const parts: string[] = [];

  if (request.guidance) parts.push(`Support guidance:\n${request.guidance}`, '');

  if (request.knowledge.length > 0) {
    parts.push('Approved knowledge:');
    for (const item of request.knowledge) {
      parts.push(`[${item.id}] ${item.title ?? 'Untitled'}\n${item.content}`, '');
    }
  } else {
    parts.push('Approved knowledge: none was found for this question.', '');
  }

  if (request.history.length > 0) {
    parts.push('Recent conversation:');
    for (const turn of request.history) {
      parts.push(`${turn.role === 'customer' ? 'Customer' : 'Support'}: ${turn.text}`);
    }
    parts.push('');
  }

  parts.push(`Customer's message: ${request.question}`);
  return parts.join('\n');
}
