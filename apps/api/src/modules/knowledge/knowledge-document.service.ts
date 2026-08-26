import { extname } from 'node:path';
import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppLogger } from '../../common/logging/app-logger';
import { MetricsService } from '../../common/metrics/metrics.service';
import { StorageService } from '../../common/storage/storage.service';
import { JobType } from '../jobs/entities/job.entity';
import { JobsService } from '../jobs/jobs.service';
import { KnowledgeDocument } from './entities/knowledge-document.entity';
import { DocumentStatus, KnowledgeScopeType } from './knowledge-types';
import { ALLOWED_UPLOAD_TYPES } from './pipeline/parser.service';

/**
 * Uploads (`PROJECT_SPEC.md` §72, §126, §179).
 *
 * The validation here is the security boundary of the whole feature. Everything downstream — the
 * parser, the chunker, the storage service — assumes the bytes it receives were checked, so this is
 * the one place where an uploaded file is still untrusted.
 *
 * Nothing is parsed inline. The request stores the file, writes a row and queues a job; a 25 MB PDF
 * is seconds of CPU, and an API worker blocked on somebody's upload is an API worker not serving
 * anyone.
 */

export interface UploadInput {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

@Injectable()
export class KnowledgeDocumentService {
  private readonly logger = new AppLogger(KnowledgeDocumentService.name);

  constructor(
    @InjectRepository(KnowledgeDocument) private readonly documents: Repository<KnowledgeDocument>,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  private get maxBytes(): number {
    return this.config.get<number>('storage.uploadMaxBytes') ?? 25 * 1024 * 1024;
  }

  async findOne(id: string): Promise<KnowledgeDocument> {
    const document = await this.documents.findOne({ where: { id } });
    if (!document) throw new NotFoundException(`Knowledge document ${id} not found`);
    return document;
  }

  /**
   * Validates, stores and queues one uploaded file.
   *
   * Re-uploading a file that is already in this category returns the existing document rather than
   * a duplicate. Deliberate: people re-upload when they are unsure whether the first attempt
   * worked, and the honest answer is "you already have this", not a second copy that will surface
   * twice in every search.
   */
  async upload(
    file: UploadInput,
    meta: {
      categoryId: string;
      articleId?: string | null;
      scopeType?: KnowledgeScopeType;
      scopeId?: string | null;
    },
    userId: string | null,
  ): Promise<{ document: KnowledgeDocument; jobId: string | null; duplicate: boolean }> {
    this.validate(file);

    const scopeType = meta.scopeType ?? KnowledgeScopeType.GLOBAL;
    const scopeId = meta.scopeId ?? null;
    if (scopeType === KnowledgeScopeType.GLOBAL && scopeId) {
      throw new BadRequestException('Global documents cannot be tied to a specific group or customer');
    }
    if (scopeType !== KnowledgeScopeType.GLOBAL && !scopeId) {
      throw new BadRequestException(`${scopeType}-scoped documents need the id they apply to`);
    }

    const stored = await this.storage.put(file.buffer, file.originalname);

    const existing = await this.documents.findOne({
      where: { checksum: stored.checksum, categoryId: meta.categoryId },
    });
    if (existing) {
      // The bytes are already on disk under a different ref; drop the copy we just made rather than
      // leaking a file nothing points at.
      await this.storage.delete(stored.ref);
      this.metrics.increment('knowledge.document_duplicate');
      return { document: existing, jobId: null, duplicate: true };
    }

    const document = await this.documents.save(
      this.documents.create({
        // Stored as metadata only — never a path component. `StorageService` generates the name on
        // disk, so a filename like `../../etc/passwd` is just an awkward string in a column.
        originalFilename: sanitizeFilename(file.originalname),
        mimeType: file.mimetype,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
        storageRef: stored.ref,
        categoryId: meta.categoryId,
        articleId: meta.articleId ?? null,
        scopeType,
        scopeId,
        status: DocumentStatus.PENDING,
        uploadedById: userId,
      }),
    );

    const job = await this.queueIndex([document], userId, 'Document upload');
    this.metrics.increment('knowledge.document_uploaded');

    return { document, jobId: job?.id ?? null, duplicate: false };
  }

  /** Re-runs the pipeline for one document — after a provider outage, or a parser improvement. */
  async reprocess(id: string, userId: string | null): Promise<{ jobId: string | null }> {
    const document = await this.findOne(id);
    await this.documents.update(document.id, {
      status: DocumentStatus.PENDING,
      statusDetail: null,
    });
    const job = await this.queueIndex([document], userId, 'Document re-index');
    return { jobId: job?.id ?? null };
  }

  /**
   * Re-indexes many documents at once — one Job Center item each.
   *
   * Per-document items rather than one big job: progress is meaningful, and one corrupt file fails
   * alone instead of taking the batch with it.
   */
  async reindexAll(
    filter: { categoryId?: string; status?: DocumentStatus },
    userId: string | null,
  ): Promise<{ jobId: string | null; total: number }> {
    const documents = await this.documents.find({
      where: {
        ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      order: { createdAt: 'ASC' },
    });

    const job = await this.queueIndex(documents, userId, 'Knowledge re-index');
    return { jobId: job?.id ?? null, total: documents.length };
  }

  async remove(id: string): Promise<void> {
    const document = await this.findOne(id);
    // Chunks cascade from the row; the file has to be removed explicitly, and is removed last so a
    // failure here leaves no row pointing at a file that is gone.
    await this.documents.delete(document.id);
    await this.storage.delete(document.storageRef);
  }

  /** Streams a stored file to an authorised caller. Never a direct link to storage (§179). */
  async openStream(id: string) {
    const document = await this.findOne(id);
    if (!(await this.storage.exists(document.storageRef))) {
      throw new NotFoundException('The stored file for this document is missing');
    }
    return { document, stream: this.storage.read(document.storageRef) };
  }

  private async queueIndex(documents: KnowledgeDocument[], userId: string | null, name: string) {
    if (documents.length === 0) return null;

    return this.jobs.create({
      type: JobType.KNOWLEDGE_INDEX,
      name: `${name} — ${documents.length} document${documents.length === 1 ? '' : 's'}`,
      payload: {},
      items: documents.map((document) => ({
        reference: document.id,
        payload: { documentId: document.id },
      })),
      createdById: userId,
    });
  }

  /**
   * Everything that must be true before a byte is written.
   *
   * The signature check is the one that matters. An extension is a naming convention and a
   * Content-Type is a claim by whoever uploaded the file; only the bytes are evidence. A ZIP named
   * `handbook.pdf` with `Content-Type: application/pdf` passes both of the weaker checks.
   */
  private validate(file: UploadInput): void {
    if (!file.buffer || file.buffer.byteLength === 0) {
      throw new BadRequestException('That file is empty');
    }
    if (file.buffer.byteLength > this.maxBytes) {
      throw new PayloadTooLargeException(
        `That file is larger than the ${Math.floor(this.maxBytes / (1024 * 1024))} MB limit`,
      );
    }

    const rule = ALLOWED_UPLOAD_TYPES[file.mimetype];
    if (!rule) {
      throw new BadRequestException(
        `Files of type "${file.mimetype}" cannot be uploaded. Supported: PDF, Word, text, Markdown, HTML and images.`,
      );
    }

    const extension = extname(file.originalname).toLowerCase();
    if (!rule.extensions.includes(extension)) {
      throw new BadRequestException(
        `A ${file.mimetype} file should have one of these extensions: ${rule.extensions.join(', ')}`,
      );
    }

    if (rule.magic && !rule.magic.some((signature) => file.buffer.subarray(0, signature.length).equals(signature))) {
      this.metrics.increment('knowledge.upload_signature_rejected');
      this.logger.warn('Upload rejected: content does not match its declared type', {
        mimeType: file.mimetype,
        extension,
      });
      throw new BadRequestException(
        'This file is not what it claims to be — its contents do not match its type.',
      );
    }
  }
}

/**
 * Makes a filename safe to store as text and show in a UI.
 *
 * It is never used as a path — `StorageService` generates the name on disk — but it is rendered in
 * the browser and returned in a `Content-Disposition` header, so path separators, control
 * characters and quotes all come out.
 */
function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'document';
  return (
    base
       
      .replace(/[\u0000-\u001f\u007f"'\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 255) || 'document'
  );
}
