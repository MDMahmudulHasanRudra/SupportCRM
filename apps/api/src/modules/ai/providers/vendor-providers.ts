import { AIProviderKind } from '../ai-types';
import { AIProviderError, type AIDecisionRequest, type AIDecisionResult } from '../../../common/ai/ai-provider';
import {
  classifyHttpFailure,
  fetchWithTimeout,
  parseStructuredVerdict,
  type CompletionResult,
  type GenerationProvider,
  type ProviderCallOptions,
} from './generation-provider';

/**
 * The vendors (`PROJECT_SPEC.md` §21).
 *
 * Three request shapes cover the field: OpenAI's chat-completions (which OpenRouter, Together,
 * Groq, vLLM and most self-hosted gateways also speak), Anthropic's messages API, and Google's
 * generateContent. Each adapter's only job is to translate in and out; none of them decides
 * anything, and none of them ever sees a Support CRM database row.
 */

/** Renders the user-side of the prompt. Identical across vendors, so it lives once. */
export function renderUserPrompt(request: AIDecisionRequest): string {
  const parts: string[] = [];

  if (request.history.length > 0) {
    parts.push('Recent conversation:');
    for (const turn of request.history) {
      parts.push(`${turn.role === 'customer' ? 'Customer' : 'Agent'}: ${turn.text}`);
    }
    parts.push('');
  }

  if (request.knowledge.length > 0) {
    parts.push('Approved knowledge you may use. Cite the ids you rely on:');
    for (const chunk of request.knowledge) {
      parts.push(`[${chunk.id}] ${chunk.title ? `${chunk.title}\n` : ''}${chunk.content}`);
    }
  } else {
    parts.push('No approved knowledge was found for this question.');
  }

  parts.push('', `Customer's message: ${request.question}`);
  return parts.join('\n');
}

// === OpenAI-compatible ===========================================================================

/**
 * OpenAI, OpenRouter, and everything else that speaks chat-completions.
 *
 * One class for four `kind`s because the difference between them is a base URL, not a protocol.
 * Pretending otherwise would mean four copies of the same parsing bug.
 */
export class OpenAiCompatibleProvider implements GenerationProvider {
  constructor(readonly kind: AIProviderKind) {}

  private endpoint(options: ProviderCallOptions): string {
    const base = (options.baseUrl ?? defaultBaseUrl(this.kind)).replace(/\/$/, '');
    return `${base}/chat/completions`;
  }

  async decide(request: AIDecisionRequest, options: ProviderCallOptions): Promise<AIDecisionResult> {
    const body = {
      model: options.model,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: renderUserPrompt(request) },
      ],
      // Asked for as JSON where the endpoint supports it; the parser is defensive either way,
      // because a self-hosted endpoint may ignore this field entirely.
      response_format: { type: 'json_object' },
      temperature: options.temperature ?? 0.2,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    };

    const response = await fetchWithTimeout(
      this.endpoint(options),
      { method: 'POST', headers: this.headers(options), body: JSON.stringify(body) },
      options.timeoutMs,
      this.kind,
    );

    if (!response.ok) throw classifyHttpFailure(response.status, this.kind);

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new AIProviderError(`${this.kind} returned no message content.`, true, 'FAILED');
    }

    const verdict = parseStructuredVerdict(content);
    verdict.usage = {
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
    };
    return verdict;
  }

  async complete(prompt: string, system: string, options: ProviderCallOptions): Promise<CompletionResult> {
    const response = await fetchWithTimeout(
      this.endpoint(options),
      {
        method: 'POST',
        headers: this.headers(options),
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: options.temperature ?? 0.2,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        }),
      },
      options.timeoutMs,
      this.kind,
    );

    if (!response.ok) throw classifyHttpFailure(response.status, this.kind);

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: payload.choices?.[0]?.message?.content ?? '',
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
      },
    };
  }

  private headers(options: ProviderCallOptions): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      // OpenRouter asks callers to identify themselves; harmless elsewhere.
      ...(this.kind === AIProviderKind.OPENROUTER ? { 'X-Title': 'Support CRM' } : {}),
    };
  }
}

// === Anthropic ===================================================================================

/** Anthropic's messages API: system is a top-level field, and the content is a block array. */
export class AnthropicProvider implements GenerationProvider {
  readonly kind = AIProviderKind.ANTHROPIC;

  private endpoint(options: ProviderCallOptions): string {
    const base = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    return `${base}/messages`;
  }

  private headers(options: ProviderCallOptions): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
    };
  }

  async decide(request: AIDecisionRequest, options: ProviderCallOptions): Promise<AIDecisionResult> {
    const text = await this.call(renderUserPrompt(request), options.system, options);
    const verdict = parseStructuredVerdict(text.text);
    verdict.usage = text.usage;
    return verdict;
  }

  async complete(prompt: string, system: string, options: ProviderCallOptions): Promise<CompletionResult> {
    return this.call(prompt, system, options);
  }

  private async call(prompt: string, system: string, options: ProviderCallOptions): Promise<CompletionResult> {
    const response = await fetchWithTimeout(
      this.endpoint(options),
      {
        method: 'POST',
        headers: this.headers(options),
        body: JSON.stringify({
          model: options.model,
          system,
          messages: [{ role: 'user', content: prompt }],
          // Required by this API rather than optional, so a default is supplied.
          max_tokens: options.maxTokens ?? 1024,
          ...(options.temperature !== null && options.temperature !== undefined
            ? { temperature: options.temperature }
            : {}),
        }),
      },
      options.timeoutMs,
      this.kind,
    );

    if (!response.ok) throw classifyHttpFailure(response.status, this.kind);

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');

    if (!text) throw new AIProviderError('Anthropic returned no text content.', true, 'FAILED');

    return {
      text,
      usage: {
        promptTokens: payload.usage?.input_tokens ?? null,
        completionTokens: payload.usage?.output_tokens ?? null,
      },
    };
  }
}

// === Gemini ======================================================================================

/** Google's generateContent: the key is a query parameter and the system prompt has its own field. */
export class GeminiProvider implements GenerationProvider {
  readonly kind = AIProviderKind.GEMINI;

  async decide(request: AIDecisionRequest, options: ProviderCallOptions): Promise<AIDecisionResult> {
    const result = await this.call(renderUserPrompt(request), options.system, options, true);
    const verdict = parseStructuredVerdict(result.text);
    verdict.usage = result.usage;
    return verdict;
  }

  async complete(prompt: string, system: string, options: ProviderCallOptions): Promise<CompletionResult> {
    return this.call(prompt, system, options, false);
  }

  private async call(
    prompt: string,
    system: string,
    options: ProviderCallOptions,
    wantJson: boolean,
  ): Promise<CompletionResult> {
    const base = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const url = `${base}/models/${encodeURIComponent(options.model)}:generateContent`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // As a header rather than a query string: a key in a URL lands in access logs.
          ...(options.apiKey ? { 'x-goog-api-key': options.apiKey } : {}),
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            ...(wantJson ? { responseMimeType: 'application/json' } : {}),
            ...(options.temperature !== null && options.temperature !== undefined
              ? { temperature: options.temperature }
              : {}),
            ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
          },
        }),
      },
      options.timeoutMs,
      this.kind,
    );

    if (!response.ok) throw classifyHttpFailure(response.status, this.kind);

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');

    if (!text) throw new AIProviderError('Gemini returned no text content.', true, 'FAILED');

    return {
      text,
      usage: {
        promptTokens: payload.usageMetadata?.promptTokenCount ?? null,
        completionTokens: payload.usageMetadata?.candidatesTokenCount ?? null,
      },
    };
  }
}

export function defaultBaseUrl(kind: AIProviderKind): string {
  switch (kind) {
    case AIProviderKind.OPENAI:
      return 'https://api.openai.com/v1';
    case AIProviderKind.OPENROUTER:
      return 'https://openrouter.ai/api/v1';
    case AIProviderKind.ANTHROPIC:
      return 'https://api.anthropic.com/v1';
    case AIProviderKind.GEMINI:
      return 'https://generativelanguage.googleapis.com/v1beta';
    case AIProviderKind.COMPATIBLE:
      // No sensible default: a compatible endpoint is defined by its base URL, so the caller
      // supplies one or the provider cannot be saved.
      return '';
  }
}

export function providerFor(kind: AIProviderKind): GenerationProvider {
  switch (kind) {
    case AIProviderKind.ANTHROPIC:
      return new AnthropicProvider();
    case AIProviderKind.GEMINI:
      return new GeminiProvider();
    default:
      return new OpenAiCompatibleProvider(kind);
  }
}
