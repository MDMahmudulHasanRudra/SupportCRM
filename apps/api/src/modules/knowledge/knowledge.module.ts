import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmbeddingService } from '../../common/ai/embedding-provider';
import { StorageService } from '../../common/storage/storage.service';
import { AuditModule } from '../audit/audit.module';
import { JobsModule } from '../jobs/jobs.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { KnowledgeArticle } from './entities/knowledge-article.entity';
import { KnowledgeArticleAttachment } from './entities/knowledge-article-attachment.entity';
import { KnowledgeArticleLink } from './entities/knowledge-article-link.entity';
import { KnowledgeArticleVersion } from './entities/knowledge-article-version.entity';
import { KnowledgeCandidate } from './entities/knowledge-candidate.entity';
import { KnowledgeCategory } from './entities/knowledge-category.entity';
import { KnowledgeChunk } from './entities/knowledge-chunk.entity';
import { KnowledgeDocument } from './entities/knowledge-document.entity';
import { KnowledgeProfile } from './entities/knowledge-profile.entity';
import { KnowledgeArticleService } from './knowledge-article.service';
import { KnowledgeCandidateService } from './knowledge-candidate.service';
import { GroupKnowledgeHarvestService } from './group-knowledge-harvest.service';
import { Group } from '../groups/entities/group.entity';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeDocumentService } from './knowledge-document.service';
import { KnowledgeIndexHandler } from './knowledge-index.handler';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { ChunkerService } from './pipeline/chunker.service';
import { DocumentParserService } from './pipeline/parser.service';

const isWorker = process.env.RUN_MODE === 'worker';

/**
 * The Knowledge Base (`PROJECT_SPEC.md` §70–§75).
 *
 * **Channel agnostic by construction.** Nothing in this module imports `channel/`, an adapter, or
 * any WhatsApp or gateway type, and the ESLint boundary rule fails the build if that ever changes.
 * Group, customer and product ids arrive as opaque UUIDs used for scope filtering and nothing else.
 *
 * `KnowledgeRetrievalService` is exported because Phase 5's Decision Engine will call it in-process.
 * Nothing else here is exported: authoring, uploading and approving are HTTP concerns.
 *
 * The index handler is registered only in worker mode. Parsing a 25 MB PDF on an API replica would
 * block a request worker for seconds, which is exactly what the Job Center exists to prevent.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      KnowledgeArticle,
      KnowledgeArticleVersion,
      KnowledgeArticleLink,
      KnowledgeArticleAttachment,
      KnowledgeCategory,
      KnowledgeChunk,
      KnowledgeDocument,
      KnowledgeProfile,
      KnowledgeCandidate,
      // Read-only here: the harvester checks each group's opt-in flag in SQL. This module owns no
      // group state and writes none.
      Group,
    ]),
    // In-memory uploads with a hard ceiling from configuration, so a rejected file never reaches
    // the disk and a large one cannot exhaust memory.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        limits: { fileSize: config.get<number>('storage.uploadMaxBytes') ?? 25 * 1024 * 1024, files: 1 },
      }),
    }),
    JobsModule,
    RealtimeModule,
    AuditModule,
  ],
  controllers: [KnowledgeController],
  providers: [
    StorageService,
    EmbeddingService,
    DocumentParserService,
    ChunkerService,
    KnowledgeIndexService,
    KnowledgeRetrievalService,
    KnowledgeArticleService,
    KnowledgeDocumentService,
    KnowledgeCandidateService,
    GroupKnowledgeHarvestService,
    ...(isWorker ? [KnowledgeIndexHandler] : []),
  ],
  // KnowledgeCandidateService is exported so the Copilot can queue a question for review. It is the
  // candidate service specifically, never the article service: the assistant may propose knowledge,
  // it may not publish it.
  exports: [
    KnowledgeRetrievalService,
    GroupKnowledgeHarvestService,
    KnowledgeCandidateService,
    TypeOrmModule,
  ],
})
export class KnowledgeModule {}
