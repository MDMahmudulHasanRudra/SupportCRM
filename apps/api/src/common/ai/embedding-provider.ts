import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Turning text into vectors.
 *
 * Deliberately the narrowest possible AI surface: text in, numbers out. No completions, no chat, no
 * decisions. Phase 6 builds the provider layer that answers customers; this exists only so
 * knowledge chunks can be searched semantically.
 *
 * ## The rule that shapes this file
 *
 * **When no real provider is configured, nothing is faked.** A hash-derived vector would embed and
 * index without error and then return nonsense for every query — semantic search that looks like it
 * works is worse than semantic search that is honestly switched off. So:
 *
 *  - `none` (the default) reports itself unavailable. Documents still index for full-text search,
 *    and both the API and the UI say semantic search is off.
 *  - `test` is the deterministic provider, and `env.validation.ts` refuses it in production.
 *  - `openai` is a real call to any OpenAI-compatible `/embeddings` endpoint.
 */

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

/** Thrown when a real provider is asked for and none is configured. Never swallowed silently. */
export class EmbeddingUnavailableError extends Error {
  constructor(message = 'No embedding provider is configured — semantic indexing is unavailable') {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

/** A provider failed at call time (network, quota, bad response). Retryable. */
export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

export interface EmbeddingProvider {
  /** False when semantic features must be presented as unavailable rather than attempted. */
  readonly available: boolean;
  readonly model: string;
  readonly dimensions: number;
  /** Never returns partial results: either every input is embedded, or it throws. */
  embed(texts: string[]): Promise<EmbeddingResult>;
}

/** How many chunks go to the provider in one request. */
const BATCH_SIZE = 64;
const REQUEST_TIMEOUT_MS = 30_000;

@Injectable()
export class EmbeddingService implements EmbeddingProvider {
  constructor(private readonly config: ConfigService) {}

  private get provider(): 'none' | 'openai' | 'test' {
    return this.config.get<'none' | 'openai' | 'test'>('embedding.provider') ?? 'none';
  }

  get available(): boolean {
    return this.provider !== 'none';
  }

  get model(): string {
    return this.provider === 'test'
      ? 'deterministic-test'
      : (this.config.get<string>('embedding.model') ?? 'unknown');
  }

  get dimensions(): number {
    return this.config.get<number>('embedding.dimensions') ?? 1536;
  }

  /** What the API and UI show. Carries no credential — only whether one exists. */
  describe(): { available: boolean; provider: string; model: string | null; dimensions: number } {
    return {
      available: this.available,
      provider: this.provider,
      model: this.available ? this.model : null,
      dimensions: this.dimensions,
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) return { vectors: [], model: this.model, dimensions: this.dimensions };

    switch (this.provider) {
      case 'none':
        throw new EmbeddingUnavailableError();
      case 'test':
        return this.embedDeterministic(texts);
      case 'openai':
        return this.embedOpenAiCompatible(texts);
    }
  }

  /**
   * A real OpenAI-compatible `/embeddings` call.
   *
   * Batched, because one request per chunk turns a 300-chunk PDF into 300 round trips. Failures are
   * classified: 429 and 5xx are worth retrying, a 400 means the request itself is wrong and will
   * stay wrong however many times the queue redelivers it.
   */
  private async embedOpenAiCompatible(texts: string[]): Promise<EmbeddingResult> {
    const apiKey = this.config.get<string>('embedding.apiKey');
    if (!apiKey) throw new EmbeddingUnavailableError('Embedding provider has no credential configured');

    const baseUrl = this.config.getOrThrow<string>('embedding.baseUrl').replace(/\/+$/, '');
    const model = this.model;
    const vectors: number[][] = [];

    for (let index = 0; index < texts.length; index += BATCH_SIZE) {
      const batch = texts.slice(index, index + BATCH_SIZE);
      let response: Response;

      try {
        response = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input: batch }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // Network-level: unreachable, DNS, timeout. Always worth another go.
        throw new EmbeddingProviderError(
          `Embedding provider unreachable: ${(error as Error).message}`,
          true,
        );
      }

      if (!response.ok) {
        // The body can echo the request, and the request is customer knowledge. Status only — and
        // never the Authorization header, which is why nothing here logs the request object.
        throw new EmbeddingProviderError(
          `Embedding provider returned ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }

      const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const batchVectors = (payload.data ?? []).map((row) => row.embedding ?? []);

      if (batchVectors.length !== batch.length || batchVectors.some((v) => v.length === 0)) {
        throw new EmbeddingProviderError('Embedding provider returned an incomplete response', true);
      }
      if (batchVectors[0].length !== this.dimensions) {
        // A dimension mismatch would be written into a `vector(N)` column and fail at insert, or
        // worse, silently mix widths. Fail here, where the message can say what happened.
        throw new EmbeddingProviderError(
          `Embedding provider returned ${batchVectors[0].length} dimensions, expected ${this.dimensions}`,
          false,
        );
      }

      vectors.push(...batchVectors);
    }

    return { vectors, model, dimensions: this.dimensions };
  }

  /**
   * The deterministic test provider.
   *
   * Hash-derived, stable across runs, offline, and **meaningless** — similar texts do not get
   * similar vectors. It exists so integration tests can exercise the whole embed → store → query
   * path without a network or a credential, and `env.validation.ts` refuses it in production for
   * exactly the reason it is useful here.
   */
  private embedDeterministic(texts: string[]): EmbeddingResult {
    const dimensions = this.dimensions;

    const vectors = texts.map((text) => {
      const vector = new Array<number>(dimensions).fill(0);
      // Expand a 32-byte digest across the full width by re-hashing with a counter.
      for (let block = 0; block * 32 < dimensions; block += 1) {
        const digest = createHash('sha256').update(`${block}:${text}`).digest();
        for (let byte = 0; byte < digest.length; byte += 1) {
          const position = block * 32 + byte;
          if (position < dimensions) vector[position] = digest[byte] / 255 - 0.5;
        }
      }

      // Normalised, so cosine distance behaves the way the real thing does.
      const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / magnitude);
    });

    return { vectors, model: 'deterministic-test', dimensions };
  }
}
