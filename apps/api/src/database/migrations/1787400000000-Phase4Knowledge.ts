import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 — the Knowledge Base.
 *
 * `PROJECT_SPEC.md` §70–§75, §111, §114, §198.
 *
 * Shape of the thing:
 *
 *   categories ──< articles ──< article_versions          (authoring + approval + history)
 *                     │
 *                     ├──< article_links                  (URLs and YouTube refs — metadata only)
 *                     ├──< article_attachments ──> documents
 *                     └──< chunks >── documents           (what retrieval actually searches)
 *
 * Two decisions worth stating up front:
 *
 *  - **Chunks carry their own scope.** They could inherit it through the article, but retrieval
 *    filters on scope on every single query, and a join to check it would be on the hot path of
 *    the feature. Denormalised, and kept in step by the indexer that writes them.
 *  - **`vector` is required, not conditional.** Phase 1 created it defensively so a plain
 *    `postgres:16` image could still boot. From here it is load-bearing, and a deployment without
 *    it should fail during migration with a clear error rather than at the first semantic search.
 */
export class Phase4Knowledge1787400000000 implements MigrationInterface {
  name = 'Phase4Knowledge1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);

    // === categories (§71) =======================================================================

    await queryRunner.query(`
      CREATE TABLE "knowledge_categories" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key"         varchar(64)  NOT NULL,
        "name"        varchar(120) NOT NULL,
        "description" text,
        -- Seeded categories may be renamed but never deleted: articles reference them, and the ten
        -- defaults are part of the specification rather than user data.
        "isSystem"    boolean      NOT NULL DEFAULT false,
        "sortOrder"   integer      NOT NULL DEFAULT 0,
        "createdAt"   timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz  NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_categories_key" ON "knowledge_categories" ("key")`,
    );

    const defaults = [
      ['software', 'Software'],
      ['billing', 'Billing'],
      ['mikrotik', 'MikroTik'],
      ['networking', 'Networking'],
      ['users', 'Users'],
      ['reports', 'Reports'],
      ['inventory', 'Inventory'],
      ['installation', 'Installation'],
      ['troubleshooting', 'Troubleshooting'],
      ['general', 'General'],
    ];
    for (const [index, [key, name]] of defaults.entries()) {
      await queryRunner.query(
        `INSERT INTO "knowledge_categories" ("key", "name", "isSystem", "sortOrder")
         VALUES ($1, $2, true, $3)`,
        [key, name, index],
      );
    }

    // === profiles (§74) =========================================================================

    await queryRunner.query(`
      CREATE TABLE "knowledge_profiles" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"        varchar(120) NOT NULL,
        "description" text,
        -- Which categories this profile draws on. Empty means "all".
        "categoryIds" jsonb        NOT NULL DEFAULT '[]'::jsonb,
        -- Overrides the global scope weighting for groups bound to this profile.
        "priorityOverride" jsonb,
        "isActive"    boolean      NOT NULL DEFAULT true,
        "createdById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"   timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz  NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_profiles_name" ON "knowledge_profiles" (lower("name"))`,
    );

    // Bindings. Nullable, so nothing changes for existing rows and Phase 5 can start reading them.
    await queryRunner.query(`
      ALTER TABLE "groups"
        ADD COLUMN "knowledgeProfileId" uuid NULL
        REFERENCES "knowledge_profiles"("id") ON DELETE SET NULL`);
    await queryRunner.query(`
      ALTER TABLE "customers"
        ADD COLUMN "knowledgeProfileId" uuid NULL
        REFERENCES "knowledge_profiles"("id") ON DELETE SET NULL`);

    // === articles (§70, §73, §198) ==============================================================

    await queryRunner.query(`
      CREATE TABLE "knowledge_articles" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title"         varchar(300) NOT NULL,
        "slug"          varchar(320) NOT NULL,
        "summary"       varchar(1000),
        "body"          text         NOT NULL DEFAULT '',
        "categoryId"    uuid         NOT NULL REFERENCES "knowledge_categories"("id"),
        -- DRAFT -> REVIEW -> PUBLISHED -> ARCHIVED. Only PUBLISHED is eligible for production
        -- retrieval (§198), enforced in the retrieval query rather than in application code.
        "status"        varchar(16)  NOT NULL DEFAULT 'DRAFT',
        "currentVersion" integer     NOT NULL DEFAULT 1,
        -- §74 scope. GLOBAL rows have a null scopeId; the CHECK below keeps that honest.
        "scopeType"     varchar(16)  NOT NULL DEFAULT 'GLOBAL',
        "scopeId"       uuid,
        "profileId"     uuid REFERENCES "knowledge_profiles"("id") ON DELETE SET NULL,
        "language"      varchar(12)  NOT NULL DEFAULT 'en',
        "publishedAt"   timestamptz,
        "archivedAt"    timestamptz,
        "createdById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "updatedById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "publishedById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_knowledge_articles_status"
          CHECK ("status" IN ('DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED')),
        CONSTRAINT "CHK_knowledge_articles_scope"
          CHECK ("scopeType" IN ('GLOBAL', 'GROUP', 'CUSTOMER', 'PRODUCT')),
        -- A GLOBAL article with a scope id, or a GROUP article without one, would both silently
        -- break scope isolation. Neither can exist.
        CONSTRAINT "CHK_knowledge_articles_scope_id"
          CHECK (("scopeType" = 'GLOBAL' AND "scopeId" IS NULL)
              OR ("scopeType" <> 'GLOBAL' AND "scopeId" IS NOT NULL))
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_articles_slug" ON "knowledge_articles" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_articles_status_category"
         ON "knowledge_articles" ("status", "categoryId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_articles_scope" ON "knowledge_articles" ("scopeType", "scopeId")`,
    );
    // Title and summary search for the operator-facing browser.
    await queryRunner.query(`
      CREATE INDEX "IDX_knowledge_articles_fts" ON "knowledge_articles"
        USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("summary", '')))`);
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_articles_title_trgm"
         ON "knowledge_articles" USING gin ("title" gin_trgm_ops)`,
    );

    // === versions (§73) =========================================================================

    await queryRunner.query(`
      CREATE TABLE "knowledge_article_versions" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "articleId"     uuid        NOT NULL REFERENCES "knowledge_articles"("id") ON DELETE CASCADE,
        "version"       integer     NOT NULL,
        "title"         varchar(300) NOT NULL,
        "summary"       varchar(1000),
        "body"          text        NOT NULL,
        "status"        varchar(16) NOT NULL,
        "changeSummary" varchar(500),
        "createdById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz NOT NULL DEFAULT now()
      )`);
    // Immutable history: rollback writes a NEW version rather than deleting one, so what an
    // approver actually approved can always be reconstructed.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_versions_article_version"
         ON "knowledge_article_versions" ("articleId", "version")`,
    );

    // === documents (§72, §126, §179) ============================================================

    await queryRunner.query(`
      CREATE TABLE "knowledge_documents" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- What the uploader called it. Metadata only: it is never a path component.
        "originalFilename" varchar(255) NOT NULL,
        "mimeType"         varchar(128) NOT NULL,
        "sizeBytes"        bigint       NOT NULL,
        "checksum"         char(64)     NOT NULL,
        -- Opaque handle from StorageService. Not a path.
        "storageRef"       varchar(512) NOT NULL,
        "categoryId"       uuid         NOT NULL REFERENCES "knowledge_categories"("id"),
        "articleId"        uuid REFERENCES "knowledge_articles"("id") ON DELETE SET NULL,
        "scopeType"        varchar(16)  NOT NULL DEFAULT 'GLOBAL',
        "scopeId"          uuid,
        "status"           varchar(32)  NOT NULL DEFAULT 'PENDING',
        "pageCount"        integer,
        "chunkCount"       integer      NOT NULL DEFAULT 0,
        "extractedChars"   integer      NOT NULL DEFAULT 0,
        -- Why indexing failed, or why it finished without vectors. Operator-readable.
        "statusDetail"     varchar(500),
        "indexedAt"        timestamptz,
        "uploadedById"     uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"        timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"        timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_knowledge_documents_status"
          CHECK ("status" IN ('PENDING', 'PROCESSING', 'INDEXED', 'INDEXED_WITHOUT_VECTORS', 'FAILED')),
        CONSTRAINT "CHK_knowledge_documents_scope"
          CHECK ("scopeType" IN ('GLOBAL', 'GROUP', 'CUSTOMER', 'PRODUCT')),
        CONSTRAINT "CHK_knowledge_documents_scope_id"
          CHECK (("scopeType" = 'GLOBAL' AND "scopeId" IS NULL)
              OR ("scopeType" <> 'GLOBAL' AND "scopeId" IS NOT NULL))
      )`);
    // The same file uploaded twice into the same category is the same document. Scoped per
    // category rather than globally, because the same PDF legitimately belongs to two categories.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_documents_checksum"
         ON "knowledge_documents" ("checksum", "categoryId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_documents_status" ON "knowledge_documents" ("status")`,
    );

    // === chunks — what retrieval searches (§14, §72, §115) ======================================

    const dimensions = 1536;
    await queryRunner.query(`
      CREATE TABLE "knowledge_chunks" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "articleId"   uuid REFERENCES "knowledge_articles"("id") ON DELETE CASCADE,
        "documentId"  uuid REFERENCES "knowledge_documents"("id") ON DELETE CASCADE,
        "ordinal"     integer      NOT NULL,
        "content"     text         NOT NULL,
        "tokenCount"  integer      NOT NULL DEFAULT 0,
        "heading"     varchar(300),
        "pageNumber"  integer,
        -- Denormalised from the parent so every retrieval query can filter scope and status without
        -- a join. The indexer is the only writer, and it always writes both together.
        "scopeType"   varchar(16)  NOT NULL DEFAULT 'GLOBAL',
        "scopeId"     uuid,
        "status"      varchar(16)  NOT NULL DEFAULT 'DRAFT',
        "categoryId"  uuid         NOT NULL REFERENCES "knowledge_categories"("id"),
        "embedding"   vector(${dimensions}),
        -- Which model produced the vector, so a provider change is a detectable re-embed rather
        -- than a silent mix of incompatible vector spaces.
        "embeddingModel" varchar(120),
        "embeddedAt"  timestamptz,
        "createdAt"   timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_knowledge_chunks_parent"
          CHECK (("articleId" IS NOT NULL AND "documentId" IS NULL)
              OR ("articleId" IS NULL AND "documentId" IS NOT NULL)),
        CONSTRAINT "CHK_knowledge_chunks_status"
          CHECK ("status" IN ('DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED')),
        CONSTRAINT "CHK_knowledge_chunks_scope"
          CHECK ("scopeType" IN ('GLOBAL', 'GROUP', 'CUSTOMER', 'PRODUCT'))
      )`);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_chunks_article_ordinal"
         ON "knowledge_chunks" ("articleId", "ordinal") WHERE "articleId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_chunks_document_ordinal"
         ON "knowledge_chunks" ("documentId", "ordinal") WHERE "documentId" IS NOT NULL`,
    );
    // The full-text half of retrieval. `simple` rather than `english` to match the existing message
    // index and to avoid stemming a mixed-language knowledge base into nonsense.
    await queryRunner.query(`
      CREATE INDEX "IDX_knowledge_chunks_fts" ON "knowledge_chunks"
        USING gin (to_tsvector('simple', "content"))`);
    // Every retrieval query filters on these three first, then ranks.
    await queryRunner.query(`
      CREATE INDEX "IDX_knowledge_chunks_retrieval"
        ON "knowledge_chunks" ("status", "scopeType", "scopeId")`);
    // Vector search. IVFFlat needs training data to be worth building, and an empty knowledge base
    // has none — so the index is created on demand by the indexer once there is something to index
    // (see KnowledgeIndexService.ensureVectorIndex). A sequential scan over a few thousand chunks
    // is fast; a badly trained index is permanently bad.

    // === attachments, links and YouTube references (§70) =========================================

    await queryRunner.query(`
      CREATE TABLE "knowledge_article_links" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "articleId"   uuid         NOT NULL REFERENCES "knowledge_articles"("id") ON DELETE CASCADE,
        -- LINK or YOUTUBE. Both are recorded, neither is fetched: Phase 4 stores the URL and what
        -- the operator typed about it, and does not crawl, download or transcribe anything.
        "kind"        varchar(16)  NOT NULL DEFAULT 'LINK',
        "url"         varchar(2048) NOT NULL,
        "title"       varchar(300),
        "note"        varchar(1000),
        -- Parsed from the URL locally. No API call.
        "externalRef" varchar(64),
        "sortOrder"   integer      NOT NULL DEFAULT 0,
        "createdById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"   timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_knowledge_links_kind" CHECK ("kind" IN ('LINK', 'YOUTUBE'))
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_links_article" ON "knowledge_article_links" ("articleId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "knowledge_article_attachments" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "articleId"   uuid        NOT NULL REFERENCES "knowledge_articles"("id") ON DELETE CASCADE,
        "documentId"  uuid        NOT NULL REFERENCES "knowledge_documents"("id") ON DELETE CASCADE,
        "caption"     varchar(500),
        "sortOrder"   integer     NOT NULL DEFAULT 0,
        "createdAt"   timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_attachments"
         ON "knowledge_article_attachments" ("articleId", "documentId")`,
    );

    // === candidates (§75) =======================================================================

    await queryRunner.query(`
      CREATE TABLE "knowledge_candidates" (
        "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "question"           varchar(500) NOT NULL,
        "context"            text,
        -- MANUAL only in Phase 4. AI_ESCALATION is declared so the phase that produces those
        -- candidates needs no migration, not because anything writes it yet.
        "sourceType"         varchar(24)  NOT NULL DEFAULT 'MANUAL',
        "occurrences"        integer      NOT NULL DEFAULT 1,
        "status"             varchar(16)  NOT NULL DEFAULT 'OPEN',
        "categoryId"         uuid REFERENCES "knowledge_categories"("id") ON DELETE SET NULL,
        "scopeType"          varchar(16)  NOT NULL DEFAULT 'GLOBAL',
        "scopeId"            uuid,
        "convertedArticleId" uuid REFERENCES "knowledge_articles"("id") ON DELETE SET NULL,
        "resolutionNote"     varchar(1000),
        "createdById"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "resolvedById"       uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "resolvedAt"         timestamptz,
        "createdAt"          timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"          timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_knowledge_candidates_status"
          CHECK ("status" IN ('OPEN', 'CONVERTED', 'DISMISSED')),
        CONSTRAINT "CHK_knowledge_candidates_source"
          CHECK ("sourceType" IN ('MANUAL', 'AI_ESCALATION'))
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_candidates_status" ON "knowledge_candidates" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Children first; the two columns bolted onto existing tables come off before the table they
    // reference, or the drop fails on the foreign key.
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_candidates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_article_attachments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_article_links"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_chunks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_documents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_article_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_articles"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "knowledgeProfileId"`);
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN IF EXISTS "knowledgeProfileId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_profiles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_categories"`);
    // `vector` is left installed: dropping an extension another migration may rely on, on the way
    // down, is how a rollback turns into an outage.
  }
}
