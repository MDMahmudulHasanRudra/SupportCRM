import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppLogger } from '../../common/logging/app-logger';
import type { Job } from '../jobs/entities/job.entity';
import { JobType } from '../jobs/entities/job.entity';
import type { JobItem } from '../jobs/entities/job-item.entity';
import { JobProcessor, type JobItemHandler } from '../jobs/job.processor';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { KnowledgeIndexService } from './knowledge-index.service';
import { DocumentStatus } from './knowledge-types';

/**
 * Job Center handler for `KNOWLEDGE_INDEX` — one item per document.
 *
 * Registered here rather than inside `JobProcessor`, which keeps the Job Center generic: it knows
 * how to walk items, lock a job and record outcomes, and nothing about knowledge.
 *
 * Per-document items mean progress is real, retry is precise and one corrupt PDF in a batch of
 * fifty fails alone. A thrown error marks that item FAILED and the rest continue; the queue's
 * existing exponential backoff covers the retryable cases, which for this handler means an
 * embedding provider that was briefly unreachable.
 */
@Injectable()
export class KnowledgeIndexHandler implements JobItemHandler, OnModuleInit {
  private readonly logger = new AppLogger(KnowledgeIndexHandler.name);

  constructor(
    private readonly processor: JobProcessor,
    private readonly index: KnowledgeIndexService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.processor.registerHandler(JobType.KNOWLEDGE_INDEX, this);
  }

  async handle(item: JobItem, _job: Job): Promise<Record<string, unknown>> {
    const payload = (item.payload ?? {}) as { documentId?: string };
    if (!payload.documentId) throw new Error('Knowledge index item is missing documentId');

    this.realtime.emitKnowledgeEvent('knowledge.document.indexing', { documentId: payload.documentId });

    const outcome = await this.index.indexDocument(payload.documentId);

    // Whether it produced vectors is worth saying out loud: it is the difference between a document
    // that semantic search can find and one only keyword search will.
    this.realtime.emitKnowledgeEvent(
      outcome.status === DocumentStatus.FAILED ? 'knowledge.document.failed' : 'knowledge.document.indexed',
      {
        documentId: payload.documentId,
        status: outcome.status,
        chunks: outcome.chunks,
        embedded: outcome.embedded,
        detail: outcome.detail,
      },
    );

    if (outcome.status === DocumentStatus.FAILED) {
      // Recorded on the document with a readable reason, and surfaced as a failed item so "retry
      // failed" in the Job Center re-runs exactly the documents that did not work.
      throw new Error(outcome.detail ?? 'Indexing failed');
    }

    this.logger.log('Knowledge document indexed', {
      documentId: payload.documentId,
      chunks: outcome.chunks,
      embedded: outcome.embedded,
      status: outcome.status,
    });

    return { chunks: outcome.chunks, embedded: outcome.embedded, status: outcome.status };
  }
}
