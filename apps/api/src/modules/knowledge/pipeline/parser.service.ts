import { Injectable } from '@nestjs/common';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Turning an uploaded file into clean text (`PROJECT_SPEC.md` §72, steps 2 and 3).
 *
 * Runs **only on the worker**. A 25 MB PDF is seconds of CPU, and doing that inside a request would
 * hold an API worker hostage to whatever somebody chose to upload.
 *
 * Failures are classified, because the queue needs to know the difference: a corrupt file will be
 * just as corrupt on the fifth redelivery, while a transient resource limit is worth retrying.
 */

export class UnsupportedDocumentError extends Error {
  constructor(mimeType: string) {
    super(`Files of type "${mimeType}" cannot be indexed`);
    this.name = 'UnsupportedDocumentError';
  }
}

export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

export interface ParsedDocument {
  text: string;
  pageCount: number | null;
}

/**
 * What may be uploaded, by MIME type, with the magic bytes that must agree with it.
 *
 * An extension is a naming convention and a Content-Type is a claim by the uploader; neither is
 * evidence. The signature is checked against the declared type so a ZIP named `handbook.pdf` is
 * rejected before anything tries to parse it (§179).
 */
export const ALLOWED_UPLOAD_TYPES: Record<string, { extensions: string[]; magic?: Buffer[] }> = {
  'application/pdf': { extensions: ['.pdf'], magic: [Buffer.from('%PDF-')] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extensions: ['.docx'],
    // DOCX is a ZIP container: "PK\x03\x04".
    magic: [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  },
  'text/plain': { extensions: ['.txt', '.text'] },
  'text/markdown': { extensions: ['.md', '.markdown'] },
  'text/html': { extensions: ['.html', '.htm'] },
  // Images are attachments, not text sources: stored and downloadable, never parsed. No OCR in
  // Phase 4, so these produce no chunks and are not indexed.
  'image/png': { extensions: ['.png'], magic: [Buffer.from([0x89, 0x50, 0x4e, 0x47])] },
  'image/jpeg': { extensions: ['.jpg', '.jpeg'], magic: [Buffer.from([0xff, 0xd8, 0xff])] },
  'image/webp': { extensions: ['.webp'] },
};

/** Types that carry text worth indexing. Anything else is stored as an attachment only. */
export const INDEXABLE_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/html',
]);

/** Upper bounds on what one document may produce, so a malicious file cannot exhaust memory. */
const MAX_EXTRACTED_CHARS = 5_000_000;
const MAX_PDF_PAGES = 2_000;

@Injectable()
export class DocumentParserService {
  /** True when this type produces indexable text at all. */
  isIndexable(mimeType: string): boolean {
    return INDEXABLE_TYPES.has(mimeType);
  }

  async parse(bytes: Buffer, mimeType: string): Promise<ParsedDocument> {
    if (!this.isIndexable(mimeType)) throw new UnsupportedDocumentError(mimeType);

    switch (mimeType) {
      case 'application/pdf':
        return this.parsePdf(bytes);
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return this.parseDocx(bytes);
      case 'text/html':
        return { text: this.clean(stripHtml(bytes.toString('utf8'))), pageCount: null };
      default:
        // Plain text and Markdown are already text. Markdown keeps its syntax: the marks carry
        // structure a reader benefits from, and stripping them would lose headings entirely.
        return { text: this.clean(bytes.toString('utf8')), pageCount: null };
    }
  }

  /**
   * PDF text via `unpdf`, which wraps a current pdf.js.
   *
   * The obvious alternative, `pdf-parse`, vendors a 2018 build that rejects valid PDFs outright —
   * a conforming file generated for the test suite failed on it with "bad XRef entry". An old
   * parser reading untrusted uploads is also the wrong shape of dependency to take on.
   */
  private async parsePdf(bytes: Buffer): Promise<ParsedDocument> {
    try {
      const document = await getDocumentProxy(new Uint8Array(bytes));
      if (document.numPages > MAX_PDF_PAGES) {
        throw new DocumentParseError(`This PDF has more than ${MAX_PDF_PAGES} pages`);
      }

      const { text } = await extractText(document, { mergePages: true });
      return { text: this.clean(text), pageCount: document.numPages };
    } catch (error) {
      if (error instanceof DocumentParseError) throw error;
      throw new DocumentParseError(`This PDF could not be read (${(error as Error).message})`);
    }
  }

  private async parseDocx(bytes: Buffer): Promise<ParsedDocument> {
    try {
      const result = await mammoth.extractRawText({ buffer: bytes });
      return { text: this.clean(result.value ?? ''), pageCount: null };
    } catch (error) {
      throw new DocumentParseError(`This Word document could not be read (${(error as Error).message})`);
    }
  }

  /**
   * Step 3, "cleaned".
   *
   * Normalises line endings, collapses the runs of blank lines and stray whitespace that PDF
   * extraction produces, and strips control characters — which would otherwise end up in a
   * `tsvector` and in an embedding request body. Deliberately conservative: this is knowledge, and
   * aggressive cleaning loses meaning.
   */
  private clean(raw: string): string {
    const text = raw
      .replace(/\r\n?/g, '\n')
      // Control characters other than newline and tab. These reach a tsvector and an
      // embedding request body otherwise, and neither has any use for them.
       
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (text.length > MAX_EXTRACTED_CHARS) {
      throw new DocumentParseError(
        `This document is too large to index (${text.length} characters extracted)`,
      );
    }
    return text;
  }
}

/**
 * Text from HTML, without a parser dependency.
 *
 * Script and style contents are removed rather than flattened — indexing minified JavaScript as
 * knowledge would poison every search that touched it.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
