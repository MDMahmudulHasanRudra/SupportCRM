import { Injectable } from '@nestjs/common';

/**
 * Splitting clean text into retrievable passages (`PROJECT_SPEC.md` §72, step 4).
 *
 * The unit of retrieval is a passage, not a document: §14 forbids sending the whole knowledge base
 * to an AI, and a whole 40-page manual is barely better. Passages need to be small enough to be
 * specific and large enough to stand alone when read out of context.
 *
 * Three properties this guarantees, each with a test:
 *
 *  1. **Deterministic.** The same text chunks the same way every time, so re-indexing produces the
 *     same passages and a diff of the knowledge base means something.
 *  2. **Boundary-respecting.** It splits at paragraph breaks first, then sentences, and only cuts
 *     mid-sentence when a single sentence exceeds the budget. A passage that starts halfway through
 *     a clause is a passage that retrieves badly.
 *  3. **Never splits a character.** Slicing operates on whole code points, so a chunk boundary can
 *     never land inside a multi-byte character.
 */

export interface Chunk {
  content: string;
  ordinal: number;
  tokenCount: number;
  heading: string | null;
}

export interface ChunkOptions {
  /** Target size in characters. Roughly four characters per token for English prose. */
  maxChars?: number;
  /** How much of the previous chunk to repeat, so an answer spanning a boundary is still found. */
  overlapChars?: number;
  minChars?: number;
}

const DEFAULTS = { maxChars: 1_200, overlapChars: 150, minChars: 80 } as const;

@Injectable()
export class ChunkerService {
  chunk(text: string, options: ChunkOptions = {}): Chunk[] {
    const maxChars = options.maxChars ?? DEFAULTS.maxChars;
    const overlapChars = options.overlapChars ?? DEFAULTS.overlapChars;
    const minChars = options.minChars ?? DEFAULTS.minChars;

    const clean = text.trim();
    if (clean.length === 0) return [];

    const pieces: string[] = [];
    let current = '';
    let currentHeading: string | null = null;
    const headings: Array<string | null> = [];

    for (const block of clean.split(/\n{2,}/)) {
      const paragraph = block.trim();
      if (paragraph.length === 0) continue;

      // A Markdown heading labels everything under it. Carried onto each chunk so a retrieved
      // passage can say where in the document it came from.
      const heading = detectHeading(paragraph);
      if (heading) {
        currentHeading = heading;
        // A heading on its own is not a passage — it belongs with the text it introduces.
        if (paragraph.length <= 120) {
          current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
          continue;
        }
      }

      if (paragraph.length > maxChars) {
        // Too big to keep whole: flush what we have, then split this paragraph by sentence.
        if (current.trim().length > 0) {
          pieces.push(current.trim());
          headings.push(currentHeading);
          current = '';
        }
        for (const sentenceChunk of splitLongParagraph(paragraph, maxChars)) {
          pieces.push(sentenceChunk);
          headings.push(currentHeading);
        }
        continue;
      }

      if (current.length + paragraph.length + 2 > maxChars && current.trim().length > 0) {
        pieces.push(current.trim());
        headings.push(currentHeading);
        // Overlap: repeat the tail of the previous chunk so a fact split across the boundary is
        // still wholly present in one of them.
        current = overlapChars > 0 ? tail(current, overlapChars) : '';
      }

      current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    }

    if (current.trim().length > 0) {
      pieces.push(current.trim());
      headings.push(currentHeading);
    }

    // Fold a too-short trailing fragment back into its predecessor rather than emitting a passage
    // that says nothing on its own.
    if (pieces.length > 1 && pieces[pieces.length - 1].length < minChars) {
      const orphan = pieces.pop() as string;
      headings.pop();
      pieces[pieces.length - 1] = `${pieces[pieces.length - 1]}\n\n${orphan}`;
    }

    return pieces.map((content, index) => ({
      content,
      ordinal: index,
      tokenCount: estimateTokens(content),
      heading: headings[index] ?? null,
    }));
  }
}

/** `# Heading`, `## Heading`, or a short ALL-CAPS line, which is how PDFs usually mark them. */
function detectHeading(paragraph: string): string | null {
  const markdown = /^#{1,6}\s+(.{1,200})$/m.exec(paragraph);
  if (markdown) return markdown[1].trim();

  const firstLine = paragraph.split('\n')[0].trim();
  if (
    firstLine.length > 0 &&
    firstLine.length <= 80 &&
    firstLine === firstLine.toUpperCase() &&
    /[A-Z]/.test(firstLine) &&
    !firstLine.endsWith('.')
  ) {
    return firstLine;
  }
  return null;
}

/**
 * Splits an oversized paragraph on sentence boundaries.
 *
 * A sentence longer than the budget on its own — a table row, a URL list, minified text — is cut by
 * character as a last resort, using the spread operator so the cut lands between code points.
 */
function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.match(/[^.!?\n]+[.!?]+[\])'"`»]*|[^.!?\n]+$/g) ?? [paragraph];
  const out: string[] = [];
  let current = '';

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;

    if (sentence.length > maxChars) {
      if (current.trim().length > 0) {
        out.push(current.trim());
        current = '';
      }
      const characters = [...sentence];
      for (let index = 0; index < characters.length; index += maxChars) {
        out.push(characters.slice(index, index + maxChars).join('').trim());
      }
      continue;
    }

    if (current.length + sentence.length + 1 > maxChars && current.trim().length > 0) {
      out.push(current.trim());
      current = '';
    }
    current = current.length > 0 ? `${current} ${sentence}` : sentence;
  }

  if (current.trim().length > 0) out.push(current.trim());
  return out.filter((piece) => piece.length > 0);
}

/** The last N characters, rounded out to a word boundary so the overlap starts on a whole word. */
function tail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const slice = [...text].slice(-chars).join('');
  const space = slice.indexOf(' ');
  return (space === -1 ? slice : slice.slice(space + 1)).trim();
}

/**
 * A rough token count.
 *
 * Four characters per token is the usual English approximation. Exact counting would mean a
 * tokenizer dependency per model, and this number is only used for budgeting a retrieval response —
 * nothing depends on it being precise.
 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
