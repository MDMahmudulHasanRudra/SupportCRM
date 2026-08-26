import request from 'supertest';
import { In, Repository } from 'typeorm';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { EmbeddingService } from '../src/common/ai/embedding-provider';
import { User } from '../src/modules/auth/entities/user.entity';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { KnowledgeArticle } from '../src/modules/knowledge/entities/knowledge-article.entity';
import { KnowledgeCandidate } from '../src/modules/knowledge/entities/knowledge-candidate.entity';
import { KnowledgeCategory } from '../src/modules/knowledge/entities/knowledge-category.entity';
import { KnowledgeChunk } from '../src/modules/knowledge/entities/knowledge-chunk.entity';
import { KnowledgeDocument } from '../src/modules/knowledge/entities/knowledge-document.entity';
import { JobProcessor } from '../src/modules/jobs/job.processor';
import { KnowledgeArticleService } from '../src/modules/knowledge/knowledge-article.service';
import { KnowledgeDocumentService } from '../src/modules/knowledge/knowledge-document.service';
import { KnowledgeIndexService } from '../src/modules/knowledge/knowledge-index.service';
import { KnowledgeRetrievalService } from '../src/modules/knowledge/knowledge-retrieval.service';
import {
  DocumentStatus,
  KnowledgeScopeType,
  KnowledgeStatus,
} from '../src/modules/knowledge/knowledge-types';
import { ChunkerService } from '../src/modules/knowledge/pipeline/chunker.service';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { PERMISSIONS, ROLES } from '../src/modules/rbac/permissions.catalogue';
import { makeDocx, makePdf } from './fixtures/make-documents';
import { closeTestApp, createTestApp, extractCookie, resetDatabase, type TestContext } from './setup';

const COOKIE = 'support_crm_session';

/**
 * Phase 4 — the Knowledge Base.
 *
 * The tests that matter most here are the negative ones. A knowledge base that returns a draft to a
 * customer, or one group's private notes to another group, is worse than no knowledge base — so
 * "never returned" is asserted directly rather than inferred from ranking.
 */
describe('Knowledge (integration)', () => {
  let ctx: TestContext;

  let articles: KnowledgeArticleService;
  let documents: KnowledgeDocumentService;
  let indexer: KnowledgeIndexService;
  let retrieval: KnowledgeRetrievalService;
  let chunker: ChunkerService;
  let embeddings: EmbeddingService;
  let crypto: CryptoService;

  let articleRepo: Repository<KnowledgeArticle>;
  let chunkRepo: Repository<KnowledgeChunk>;
  let documentRepo: Repository<KnowledgeDocument>;
  let categoryRepo: Repository<KnowledgeCategory>;
  let candidateRepo: Repository<KnowledgeCandidate>;
  let userRepo: Repository<User>;
  let roleRepo: Repository<Role>;
  let permissionRepo: Repository<Permission>;

  let generalCategoryId: string;

  const GROUP_A = '11111111-1111-4111-8111-111111111111';
  const GROUP_B = '22222222-2222-4222-8222-222222222222';
  const CUSTOMER_A = '33333333-3333-4333-8333-333333333333';
  const CUSTOMER_B = '44444444-4444-4444-8444-444444444444';

  beforeAll(async () => {
    ctx = await createTestApp();

    // The suite runs in worker mode, so the Job Center would pick up the indexing jobs that
    // uploading queues and index documents in the background — while the next test truncates the
    // tables underneath it. Indexing is driven explicitly here instead, which is also what makes
    // these assertions deterministic.
    await ctx.app.get(JobProcessor).worker.pause(true);

    articles = ctx.app.get(KnowledgeArticleService);
    documents = ctx.app.get(KnowledgeDocumentService);
    indexer = ctx.app.get(KnowledgeIndexService);
    retrieval = ctx.app.get(KnowledgeRetrievalService);
    chunker = ctx.app.get(ChunkerService);
    embeddings = ctx.app.get(EmbeddingService);
    crypto = ctx.app.get(CryptoService);

    articleRepo = ctx.dataSource.getRepository(KnowledgeArticle);
    chunkRepo = ctx.dataSource.getRepository(KnowledgeChunk);
    documentRepo = ctx.dataSource.getRepository(KnowledgeDocument);
    categoryRepo = ctx.dataSource.getRepository(KnowledgeCategory);
    candidateRepo = ctx.dataSource.getRepository(KnowledgeCandidate);
    userRepo = ctx.dataSource.getRepository(User);
    roleRepo = ctx.dataSource.getRepository(Role);
    permissionRepo = ctx.dataSource.getRepository(Permission);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    await ctx.dataSource
      .getRepository(SecuritySettings)
      .save({ id: SECURITY_SETTINGS_ID } as SecuritySettings);

    await permissionRepo.save(
      PERMISSIONS.map((p) =>
        permissionRepo.create({
          key: p.key,
          label: p.label,
          category: p.category,
          isDangerous: p.isDangerous ?? false,
        }),
      ),
    );
    for (const definition of ROLES) {
      await roleRepo.save(
        roleRepo.create({
          key: definition.key,
          name: definition.name,
          description: definition.description,
          isSystem: true,
          isSuperAdmin: definition.isSuperAdmin ?? false,
          permissions: await permissionRepo.find({ where: { key: In([...definition.permissions]) } }),
        }),
      );
    }

    // `resetDatabase` truncates, which takes the migration's seeded categories with it.
    const seeded = await categoryRepo.save([
      categoryRepo.create({ key: 'general', name: 'General', isSystem: true, sortOrder: 0 }),
      categoryRepo.create({ key: 'billing', name: 'Billing', isSystem: true, sortOrder: 1 }),
    ]);
    generalCategoryId = seeded[0].id;
  });

  async function login(username: string, roleKey: string): Promise<string> {
    const role = await roleRepo.findOneOrFail({ where: { key: roleKey } });
    await userRepo.save(
      userRepo.create({
        username,
        email: `${username}@example.com`,
        name: username,
        passwordHash: crypto.hashPassword('Password!123'),
        isActive: true,
        roles: [role],
      }),
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: username, password: 'Password!123' })
      .expect(200);

    return `${COOKIE}=${extractCookie(response.headers['set-cookie'] as unknown as string[], COOKIE)}`;
  }

  /**
   * Signs in with exactly these permissions.
   *
   * A bespoke role rather than the nearest catalogue role: these tests are about one permission
   * boundary each, and borrowing a role that happens to be close makes them fail for unrelated
   * reasons the day somebody edits the catalogue.
   */
  async function loginWithPermissions(username: string, permissions: string[]): Promise<string> {
    const role = await roleRepo.save(
      roleRepo.create({
        key: `test-${username}`,
        name: `Test ${username}`,
        description: 'Created by the knowledge integration suite',
        isSystem: false,
        permissions: await permissionRepo.find({ where: { key: In(permissions) } }),
      }),
    );

    await userRepo.save(
      userRepo.create({
        username,
        email: `${username}@example.com`,
        name: username,
        passwordHash: crypto.hashPassword('Password!123'),
        isActive: true,
        roles: [role],
      }),
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: username, password: 'Password!123' })
      .expect(200);

    return `${COOKIE}=${extractCookie(response.headers['set-cookie'] as unknown as string[], COOKIE)}`;
  }

  /** An article at a given status and scope, chunked and embedded. */
  async function seedArticle(input: {
    title: string;
    body: string;
    status: KnowledgeStatus;
    scopeType?: KnowledgeScopeType;
    scopeId?: string | null;
  }): Promise<KnowledgeArticle> {
    const article = await articles.create(
      {
        title: input.title,
        body: input.body,
        categoryId: generalCategoryId,
        scopeType: input.scopeType ?? KnowledgeScopeType.GLOBAL,
        scopeId: input.scopeId ?? null,
      },
      null,
    );

    if (input.status !== KnowledgeStatus.DRAFT) {
      // Straight to the target status: the lifecycle itself is tested separately, and these
      // fixtures are about what retrieval does with the result.
      await articleRepo.update(article.id, { status: input.status });
      await indexer.syncArticleChunks(await articles.findOne(article.id));
    }

    return articles.findOne(article.id);
  }

  // === lifecycle and versioning (§73, §198) ========================================================

  describe('article lifecycle', () => {
    it('creates as a draft and records v1', async () => {
      const cookie = await login('author', 'knowledge_manager');

      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/knowledge/articles')
        .set('Cookie', cookie)
        .send({ title: 'Router reset procedure', body: 'Hold the reset button.', categoryId: generalCategoryId })
        .expect(201);

      expect(response.body.status).toBe(KnowledgeStatus.DRAFT);
      expect(response.body.currentVersion).toBe(1);

      const versions = await request(ctx.app.getHttpServer())
        .get(`/api/v1/knowledge/articles/${response.body.id}/versions`)
        .set('Cookie', cookie)
        .expect(200);
      expect(versions.body.items).toHaveLength(1);
    });

    it('walks draft to review to published', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'Billing cycle', body: 'Invoices go out monthly.', status: KnowledgeStatus.DRAFT });

      for (const status of [KnowledgeStatus.REVIEW, KnowledgeStatus.PUBLISHED]) {
        await request(ctx.app.getHttpServer())
          .post(`/api/v1/knowledge/articles/${article.id}/status`)
          .set('Cookie', cookie)
          .send({ status })
          .expect(201);
      }

      const published = await articles.findOne(article.id);
      expect(published.status).toBe(KnowledgeStatus.PUBLISHED);
      expect(published.publishedAt).not.toBeNull();
      // The chunks carry the status, which is what retrieval filters on.
      const chunks = await chunkRepo.find({ where: { articleId: article.id } });
      expect(chunks.every((c) => c.status === KnowledgeStatus.PUBLISHED)).toBe(true);
    });

    it('returns a published article to draft when its content is edited', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'Speed test', body: 'Original text.', status: KnowledgeStatus.PUBLISHED });

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/knowledge/articles/${article.id}`)
        .set('Cookie', cookie)
        .send({ body: 'Edited text that changes the advice.' })
        .expect(200);

      // What is live stays live until somebody approves the change (§198). An edit that went
      // straight to customers because the article was already published would defeat the point.
      const after = await articles.findOne(article.id);
      expect(after.status).toBe(KnowledgeStatus.DRAFT);
      expect(after.currentVersion).toBe(2);
    });

    it('rolls back to an earlier version as a new version', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'Setup', body: 'Version one body.', status: KnowledgeStatus.DRAFT });

      await articles.update(article.id, { body: 'Version two body.' }, null);
      await articles.update(article.id, { body: 'Version three body.' }, null);

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/articles/${article.id}/rollback`)
        .set('Cookie', cookie)
        .send({ version: 1 })
        .expect(201);

      const after = await articles.findOne(article.id);
      expect(after.body).toBe('Version one body.');
      // A NEW version, not a deletion: history is evidence of what was approved and when.
      expect(response.body.currentVersion).toBe(4);
      expect(await articles.listVersions(article.id)).toHaveLength(4);
    });

    it('refuses an illegal transition', async () => {
      const article = await seedArticle({ title: 'Archived thing', body: 'x', status: KnowledgeStatus.ARCHIVED });
      await expect(articles.transition(article.id, KnowledgeStatus.PUBLISHED, null)).rejects.toThrow(
        /cannot go from ARCHIVED to PUBLISHED/,
      );
    });

    it('diffs two versions line by line', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'Diff me', body: 'line one\nline two', status: KnowledgeStatus.DRAFT });
      await articles.update(article.id, { body: 'line one\nline two changed' }, null);

      const response = await request(ctx.app.getHttpServer())
        .get(`/api/v1/knowledge/articles/${article.id}/diff?from=1&to=2`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.body).toEqual(
        expect.arrayContaining([
          { type: 'same', text: 'line one' },
          { type: 'removed', text: 'line two' },
          { type: 'added', text: 'line two changed' },
        ]),
      );
    });
  });

  // === production retrieval sees PUBLISHED only (§198) =============================================

  describe('production retrieval and status', () => {
    const BODY = 'The fibre installation appointment window is four hours on weekdays.';

    it('returns published knowledge', async () => {
      await seedArticle({ title: 'Installation window', body: BODY, status: KnowledgeStatus.PUBLISHED });

      const result = await retrieval.retrieve({ query: 'installation appointment window' });
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].content).toContain('installation appointment window');
    });

    it.each([KnowledgeStatus.DRAFT, KnowledgeStatus.REVIEW, KnowledgeStatus.ARCHIVED])(
      'never returns %s knowledge to a production call',
      async (status) => {
        await seedArticle({ title: 'Installation window', body: BODY, status });

        const result = await retrieval.retrieve({ query: 'installation appointment window' });

        // Not "ranked lower" — absent. This is the assertion the whole approval workflow exists for.
        expect(result.chunks).toHaveLength(0);
      },
    );

    it('lets an author search their own drafts explicitly', async () => {
      await seedArticle({ title: 'Installation window', body: BODY, status: KnowledgeStatus.DRAFT });

      const production = await retrieval.retrieve({ query: 'installation appointment window' });
      const authoring = await retrieval.retrieve({
        query: 'installation appointment window',
        productionOnly: false,
      });

      expect(production.chunks).toHaveLength(0);
      expect(authoring.chunks.length).toBeGreaterThan(0);
    });

    it('excludes archived content even from an authoring search', async () => {
      await seedArticle({ title: 'Old policy', body: BODY, status: KnowledgeStatus.ARCHIVED });
      const authoring = await retrieval.retrieve({ query: 'installation appointment', productionOnly: false });
      expect(authoring.chunks).toHaveLength(0);
    });

    it('refuses an unpublished search without knowledge.create', async () => {
      const cookie = await loginWithPermissions('reader', ['knowledge.read']);
      await request(ctx.app.getHttpServer())
        .post('/api/v1/knowledge/search')
        .set('Cookie', cookie)
        .send({ query: 'anything', includeUnpublished: true })
        .expect(400);
    });
  });

  // === scope isolation (§74) =======================================================================

  describe('scope isolation', () => {
    const SHARED_TEXT = 'The maintenance window for this network is Sunday at 02:00.';

    beforeEach(async () => {
      await seedArticle({
        title: 'Group A maintenance',
        body: `${SHARED_TEXT} Group A specific instructions apply.`,
        status: KnowledgeStatus.PUBLISHED,
        scopeType: KnowledgeScopeType.GROUP,
        scopeId: GROUP_A,
      });
      await seedArticle({
        title: 'Group B maintenance',
        body: `${SHARED_TEXT} Group B specific instructions apply.`,
        status: KnowledgeStatus.PUBLISHED,
        scopeType: KnowledgeScopeType.GROUP,
        scopeId: GROUP_B,
      });
      await seedArticle({
        title: 'Global maintenance',
        body: `${SHARED_TEXT} General guidance for everyone.`,
        status: KnowledgeStatus.PUBLISHED,
      });
    });

    it('never leaks group A knowledge into a group B retrieval', async () => {
      const result = await retrieval.retrieve({ query: 'maintenance window', groupId: GROUP_B });

      const scopeIds = result.chunks.map((c) => c.scopeId);
      expect(scopeIds).not.toContain(GROUP_A);
      // And the reverse, so the test cannot pass by returning nothing at all.
      expect(result.chunks.some((c) => c.scopeId === GROUP_B)).toBe(true);
    });

    it('includes global knowledge alongside a group scope', async () => {
      const result = await retrieval.retrieve({ query: 'maintenance window', groupId: GROUP_A });
      const scopes = result.chunks.map((c) => c.scopeType);

      expect(scopes).toContain(KnowledgeScopeType.GROUP);
      expect(scopes).toContain(KnowledgeScopeType.GLOBAL);
    });

    it('ranks group-specific knowledge above global (§74)', async () => {
      const result = await retrieval.retrieve({ query: 'maintenance window', groupId: GROUP_A });

      expect(result.chunks[0].scopeType).toBe(KnowledgeScopeType.GROUP);
      expect(result.chunks[0].scopeId).toBe(GROUP_A);
    });

    it('returns global knowledge only when no scope is given', async () => {
      const result = await retrieval.retrieve({ query: 'maintenance window' });
      expect(result.chunks.every((c) => c.scopeType === KnowledgeScopeType.GLOBAL)).toBe(true);
    });

    it('isolates customer-scoped knowledge', async () => {
      await seedArticle({
        title: 'Customer A contract',
        body: 'This customer has a bespoke service level agreement of two hours.',
        status: KnowledgeStatus.PUBLISHED,
        scopeType: KnowledgeScopeType.CUSTOMER,
        scopeId: CUSTOMER_A,
      });

      const forA = await retrieval.retrieve({ query: 'service level agreement', customerId: CUSTOMER_A });
      const forB = await retrieval.retrieve({ query: 'service level agreement', customerId: CUSTOMER_B });

      expect(forA.chunks.some((c) => c.scopeId === CUSTOMER_A)).toBe(true);
      expect(forB.chunks.some((c) => c.scopeId === CUSTOMER_A)).toBe(false);
    });

    it('ranks group above customer above global', async () => {
      await seedArticle({
        title: 'Customer A maintenance',
        body: `${SHARED_TEXT} Customer A specific instructions apply.`,
        status: KnowledgeStatus.PUBLISHED,
        scopeType: KnowledgeScopeType.CUSTOMER,
        scopeId: CUSTOMER_A,
      });

      const result = await retrieval.retrieve({
        query: 'maintenance window',
        groupId: GROUP_A,
        customerId: CUSTOMER_A,
      });

      const order = result.chunks.map((c) => c.scopeType);
      expect(order.indexOf(KnowledgeScopeType.GROUP)).toBeLessThan(order.indexOf(KnowledgeScopeType.CUSTOMER));
      expect(order.indexOf(KnowledgeScopeType.CUSTOMER)).toBeLessThan(order.indexOf(KnowledgeScopeType.GLOBAL));
    });

    it('refuses a global article with a scope id', async () => {
      await expect(
        articles.create(
          { title: 'Bad scope', categoryId: generalCategoryId, scopeType: KnowledgeScopeType.GLOBAL, scopeId: GROUP_A },
          null,
        ),
      ).rejects.toThrow(/cannot be tied to a specific group/);
    });

    it('refuses a group article with no scope id', async () => {
      await expect(
        articles.create(
          { title: 'Bad scope', categoryId: generalCategoryId, scopeType: KnowledgeScopeType.GROUP },
          null,
        ),
      ).rejects.toThrow(/needs the id it applies to/);
    });
  });

  // === search strategies ===========================================================================

  describe('search', () => {
    it('finds an article by keyword', async () => {
      await seedArticle({
        title: 'MikroTik port forwarding',
        body: 'To forward a port, open IP then Firewall then NAT and add a destination NAT rule.',
        status: KnowledgeStatus.PUBLISHED,
      });

      const result = await retrieval.retrieve({ query: 'destination NAT rule' });
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.strategies.keyword).toBe(true);
    });

    it('runs semantic search when a provider is configured', async () => {
      await seedArticle({
        title: 'Fibre outage',
        body: 'When the light is red the fibre line is cut and an engineer must attend.',
        status: KnowledgeStatus.PUBLISHED,
      });

      const result = await retrieval.retrieve({ query: 'red light on the box' });

      // The deterministic provider makes this offline and repeatable. It proves the vector column,
      // the distance operator and the merge all work — not that the embeddings are meaningful.
      expect(embeddings.available).toBe(true);
      expect(result.semanticAvailable).toBe(true);
      expect(result.strategies.semantic).toBe(true);
    });

    it('stores a vector for every chunk it embeds', async () => {
      const article = await seedArticle({
        title: 'Embedded article',
        body: 'Some indexable content about routers and cables.',
        status: KnowledgeStatus.PUBLISHED,
      });

      const [row] = (await chunkRepo.query(
        `SELECT "embeddingModel", ("embedding" IS NOT NULL) AS has_vector
           FROM "knowledge_chunks" WHERE "articleId" = $1 LIMIT 1`,
        [article.id],
      )) as Array<{ embeddingModel: string; has_vector: boolean }>;

      expect(row.has_vector).toBe(true);
      expect(row.embeddingModel).toBe('deterministic-test');
    });

    it('bounds what it returns (§14 — never the whole knowledge base)', async () => {
      for (let index = 0; index < 20; index += 1) {
        await seedArticle({
          title: `Router guide ${index}`,
          body: `Router configuration guide number ${index}. `.repeat(40),
          status: KnowledgeStatus.PUBLISHED,
        });
      }

      const result = await retrieval.retrieve({ query: 'router configuration guide', limit: 5, maxChars: 2_000 });

      expect(result.chunks.length).toBeLessThanOrEqual(5);
      expect(result.totalCharacters).toBeLessThanOrEqual(2_000);
    });

    it('cites every passage it returns', async () => {
      const article = await seedArticle({
        title: 'Citable article',
        body: 'A distinctive sentence about satellite modems for the citation test.',
        status: KnowledgeStatus.PUBLISHED,
      });

      const result = await retrieval.retrieve({ query: 'satellite modems' });
      const hit = result.chunks[0];

      expect(hit.articleId).toBe(article.id);
      expect(hit.title).toBe('Citable article');
      expect(hit.version).toBe(article.currentVersion);
      expect(hit.chunkId).toBeTruthy();
      expect(['keyword', 'semantic', 'hybrid']).toContain(hit.matchedBy);
    });

    it('returns nothing for an empty query rather than everything', async () => {
      await seedArticle({ title: 'Anything', body: 'Some content.', status: KnowledgeStatus.PUBLISHED });
      const result = await retrieval.retrieve({ query: '   ' });
      expect(result.chunks).toHaveLength(0);
    });
  });

  // === documents and indexing (§72) ================================================================

  describe('document pipeline', () => {
    const textFile = (content: string, name = 'handbook.txt') => ({
      buffer: Buffer.from(content, 'utf8'),
      originalname: name,
      mimetype: 'text/plain',
      size: Buffer.byteLength(content),
    });

    it('uploads, indexes and becomes retrievable', async () => {
      const content = 'Static IP addresses are configured under the connection settings menu.';
      const { document } = await documents.upload(textFile(content), { categoryId: generalCategoryId }, null);

      expect(document.status).toBe(DocumentStatus.PENDING);

      const outcome = await indexer.indexDocument(document.id);
      expect(outcome.status).toBe(DocumentStatus.INDEXED);
      expect(outcome.chunks).toBeGreaterThan(0);

      const result = await retrieval.retrieve({ query: 'static IP addresses' });
      expect(result.chunks.some((c) => c.documentId === document.id)).toBe(true);
    });

    it('indexes a real PDF and makes it retrievable (§206.13)', async () => {
      // A genuine PDF container, parsed by the real parser — the acceptance criterion is
      // "documents index", and a text file renamed .pdf would not test that at all.
      const pdf = makePdf([
        'Fibre Installation Handbook',
        'The optical network terminal must be mounted indoors.',
        'A red status light means the fibre line is cut.',
      ]);

      const { document } = await documents.upload(
        { buffer: pdf, originalname: 'handbook.pdf', mimetype: 'application/pdf', size: pdf.length },
        { categoryId: generalCategoryId },
        null,
      );

      const outcome = await indexer.indexDocument(document.id);
      expect(outcome.status).toBe(DocumentStatus.INDEXED);
      expect(outcome.chunks).toBeGreaterThan(0);

      const stored = await documentRepo.findOneOrFail({ where: { id: document.id } });
      expect(stored.pageCount).toBe(1);
      expect(stored.extractedChars).toBeGreaterThan(0);

      const result = await retrieval.retrieve({ query: 'optical network terminal mounted indoors' });
      expect(result.chunks.some((c) => c.documentId === document.id)).toBe(true);
    });

    it('indexes a real Word document', async () => {
      const docx = makeDocx([
        'Router Replacement Procedure',
        'Power down the old router before disconnecting the WAN cable.',
      ]);

      const { document } = await documents.upload(
        {
          buffer: docx,
          originalname: 'procedure.docx',
          mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: docx.length,
        },
        { categoryId: generalCategoryId },
        null,
      );

      const outcome = await indexer.indexDocument(document.id);
      expect(outcome.status).toBe(DocumentStatus.INDEXED);

      const result = await retrieval.retrieve({ query: 'disconnecting the WAN cable' });
      expect(result.chunks.some((c) => c.documentId === document.id)).toBe(true);
    });

    it('fails a corrupt PDF with a readable reason and does not retry forever', async () => {
      // Valid signature, meaningless body — the shape of a truncated or damaged upload.
      const corrupt = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(512, 0x41)]);

      const { document } = await documents.upload(
        { buffer: corrupt, originalname: 'broken.pdf', mimetype: 'application/pdf', size: corrupt.length },
        { categoryId: generalCategoryId },
        null,
      );

      const outcome = await indexer.indexDocument(document.id);
      expect(outcome.status).toBe(DocumentStatus.FAILED);
      expect(outcome.detail).toBeTruthy();
    });

    it('parses Markdown and HTML', async () => {
      const markdown = {
        buffer: Buffer.from('# Heading\n\nMarkdown body about DNS servers.', 'utf8'),
        originalname: 'notes.md',
        mimetype: 'text/markdown',
        size: 40,
      };
      const html = {
        buffer: Buffer.from('<html><body><script>alert(1)</script><p>HTML body about DHCP leases.</p></body></html>', 'utf8'),
        originalname: 'notes.html',
        mimetype: 'text/html',
        size: 60,
      };

      for (const file of [markdown, html]) {
        const { document } = await documents.upload(file, { categoryId: generalCategoryId }, null);
        const outcome = await indexer.indexDocument(document.id);
        expect(outcome.status).toBe(DocumentStatus.INDEXED);
      }

      // Script contents must not become knowledge — indexing minified JavaScript would poison
      // every search that touched it.
      const chunks = await chunkRepo.find();
      expect(chunks.some((c) => c.content.includes('alert(1)'))).toBe(false);
      expect(chunks.some((c) => c.content.includes('DHCP leases'))).toBe(true);
    });

    it('is idempotent — re-indexing replaces chunks rather than duplicating them', async () => {
      const { document } = await documents.upload(
        textFile('Fibre splicing requires a fusion splicer and a cleaver.'),
        { categoryId: generalCategoryId },
        null,
      );

      const first = await indexer.indexDocument(document.id);
      const afterFirst = await chunkRepo.count({ where: { documentId: document.id } });

      const second = await indexer.indexDocument(document.id);
      const afterSecond = await chunkRepo.count({ where: { documentId: document.id } });

      expect(first.chunks).toBe(second.chunks);
      expect(afterSecond).toBe(afterFirst);
    });

    it('treats a re-upload of the same file as the same document', async () => {
      const file = textFile('Duplicate detection content.');
      const first = await documents.upload(file, { categoryId: generalCategoryId }, null);
      const second = await documents.upload(file, { categoryId: generalCategoryId }, null);

      expect(second.duplicate).toBe(true);
      expect(second.document.id).toBe(first.document.id);
      expect(await documentRepo.count()).toBe(1);
    });

    it('allows the same file in a different category', async () => {
      const billing = await categoryRepo.findOneOrFail({ where: { key: 'billing' } });
      const file = textFile('Shared content in two categories.');

      await documents.upload(file, { categoryId: generalCategoryId }, null);
      const second = await documents.upload(file, { categoryId: billing.id }, null);

      expect(second.duplicate).toBe(false);
      expect(await documentRepo.count()).toBe(2);
    });

    it('fails a file with no extractable text, with a readable reason', async () => {
      const { document } = await documents.upload(textFile('   \n  \n '), { categoryId: generalCategoryId }, null);
      const outcome = await indexer.indexDocument(document.id);

      expect(outcome.status).toBe(DocumentStatus.FAILED);
      expect(outcome.detail).toMatch(/No text could be extracted/);
      expect((await documentRepo.findOneOrFail({ where: { id: document.id } })).statusDetail).toBeTruthy();
    });

    it('stores an image without indexing it — no OCR in this phase', async () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 1)]);
      const { document } = await documents.upload(
        { buffer: png, originalname: 'diagram.png', mimetype: 'image/png', size: png.length },
        { categoryId: generalCategoryId },
        null,
      );

      const outcome = await indexer.indexDocument(document.id);
      expect(outcome.status).toBe(DocumentStatus.INDEXED);
      expect(outcome.chunks).toBe(0);
      expect(outcome.detail).toMatch(/not searchable/i);
    });

    it('carries document scope onto its chunks', async () => {
      const { document } = await documents.upload(
        textFile('Group A only runbook contents.'),
        { categoryId: generalCategoryId, scopeType: KnowledgeScopeType.GROUP, scopeId: GROUP_A },
        null,
      );
      await indexer.indexDocument(document.id);

      const chunks = await chunkRepo.find({ where: { documentId: document.id } });
      expect(chunks.every((c) => c.scopeType === KnowledgeScopeType.GROUP && c.scopeId === GROUP_A)).toBe(true);

      const forB = await retrieval.retrieve({ query: 'runbook contents', groupId: GROUP_B });
      expect(forB.chunks).toHaveLength(0);
    });
  });

  // === upload validation (§126, §179) ==============================================================

  describe('upload validation', () => {
    it('rejects a disguised extension', async () => {
      // A ZIP claiming to be a PDF passes both an extension check and a Content-Type check. Only
      // the signature catches it.
      const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0)]);

      await expect(
        documents.upload(
          { buffer: zip, originalname: 'handbook.pdf', mimetype: 'application/pdf', size: zip.length },
          { categoryId: generalCategoryId },
          null,
        ),
      ).rejects.toThrow(/not what it claims to be/);
    });

    it('rejects a disallowed type', async () => {
      const bytes = Buffer.from('#!/bin/sh\necho hi', 'utf8');
      await expect(
        documents.upload(
          { buffer: bytes, originalname: 'run.sh', mimetype: 'application/x-sh', size: bytes.length },
          { categoryId: generalCategoryId },
          null,
        ),
      ).rejects.toThrow(/cannot be uploaded/);
    });

    it('rejects a mismatched extension', async () => {
      const bytes = Buffer.from('plain text', 'utf8');
      await expect(
        documents.upload(
          { buffer: bytes, originalname: 'notes.exe', mimetype: 'text/plain', size: bytes.length },
          { categoryId: generalCategoryId },
          null,
        ),
      ).rejects.toThrow(/should have one of these extensions/);
    });

    it('rejects an empty file', async () => {
      await expect(
        documents.upload(
          { buffer: Buffer.alloc(0), originalname: 'empty.txt', mimetype: 'text/plain', size: 0 },
          { categoryId: generalCategoryId },
          null,
        ),
      ).rejects.toThrow(/empty/);
    });

    it('rejects an oversized file', async () => {
      const huge = Buffer.alloc(30 * 1024 * 1024, 0x41);
      await expect(
        documents.upload(
          { buffer: huge, originalname: 'big.txt', mimetype: 'text/plain', size: huge.length },
          { categoryId: generalCategoryId },
          null,
        ),
      ).rejects.toThrow(/larger than/);
    });

    it('strips a path-traversal filename down to a name', async () => {
      const bytes = Buffer.from('traversal test content', 'utf8');
      const { document } = await documents.upload(
        { buffer: bytes, originalname: '../../etc/passwd.txt', mimetype: 'text/plain', size: bytes.length },
        { categoryId: generalCategoryId },
        null,
      );

      expect(document.originalFilename).toBe('passwd.txt');
      // And the stored ref is generated, never derived from what the uploader called it.
      expect(document.storageRef).not.toContain('passwd');
      expect(document.storageRef).not.toContain('..');
    });
  });

  // === embedding provider behaviour ================================================================

  describe('embedding provider', () => {
    it('indexes without vectors when no provider is configured, and says so', async () => {
      // The rule this phase was given: never fake a vector. Full-text keeps working; the document
      // reports that semantic search will not find it.
      const spy = jest.spyOn(embeddings, 'available', 'get').mockReturnValue(false);
      try {
        const bytes = Buffer.from('Content indexed while the provider is switched off.', 'utf8');
        const { document } = await documents.upload(
          { buffer: bytes, originalname: 'noprovider.txt', mimetype: 'text/plain', size: bytes.length },
          { categoryId: generalCategoryId },
          null,
        );

        const outcome = await indexer.indexDocument(document.id);

        expect(outcome.status).toBe(DocumentStatus.INDEXED_WITHOUT_VECTORS);
        expect(outcome.detail).toMatch(/no embedding provider is configured/i);
        expect(outcome.chunks).toBeGreaterThan(0);

        const [row] = (await chunkRepo.query(
          `SELECT ("embedding" IS NULL) AS no_vector FROM "knowledge_chunks" WHERE "documentId" = $1 LIMIT 1`,
          [document.id],
        )) as Array<{ no_vector: boolean }>;
        expect(row.no_vector).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('still serves keyword retrieval when the provider is unavailable', async () => {
      await seedArticle({
        title: 'Keyword only',
        body: 'A distinctive phrase about coaxial connectors.',
        status: KnowledgeStatus.PUBLISHED,
      });

      const spy = jest.spyOn(embeddings, 'available', 'get').mockReturnValue(false);
      try {
        const result = await retrieval.retrieve({ query: 'coaxial connectors' });
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.strategies.semantic).toBe(false);
        expect(result.semanticAvailable).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('records a permanent provider failure as indexed-without-vectors', async () => {
      const spy = jest
        .spyOn(embeddings, 'embed')
        .mockRejectedValue(
          new (require('../src/common/ai/embedding-provider').EmbeddingProviderError)('provider said no', false),
        );
      try {
        const bytes = Buffer.from('Content whose embedding call fails permanently.', 'utf8');
        const { document } = await documents.upload(
          { buffer: bytes, originalname: 'failing.txt', mimetype: 'text/plain', size: bytes.length },
          { categoryId: generalCategoryId },
          null,
        );

        const outcome = await indexer.indexDocument(document.id);
        expect(outcome.status).toBe(DocumentStatus.INDEXED_WITHOUT_VECTORS);
        expect(outcome.detail).toMatch(/semantic indexing failed/i);
      } finally {
        spy.mockRestore();
      }
    });

    it('rethrows a retryable provider failure so the queue retries it', async () => {
      const { EmbeddingProviderError } = require('../src/common/ai/embedding-provider');
      const spy = jest
        .spyOn(embeddings, 'embed')
        .mockRejectedValue(new EmbeddingProviderError('provider unreachable', true));
      try {
        const bytes = Buffer.from('Content whose embedding call fails temporarily.', 'utf8');
        const { document } = await documents.upload(
          { buffer: bytes, originalname: 'retryable.txt', mimetype: 'text/plain', size: bytes.length },
          { categoryId: generalCategoryId },
          null,
        );

        // A temporary outage must not become a permanent state on the document.
        await expect(indexer.indexDocument(document.id)).rejects.toThrow(/unreachable/);
      } finally {
        spy.mockRestore();
      }
    });

    it('produces deterministic vectors in tests', async () => {
      const first = await embeddings.embed(['the same text']);
      const second = await embeddings.embed(['the same text']);
      const different = await embeddings.embed(['different text']);

      expect(first.vectors[0]).toEqual(second.vectors[0]);
      expect(first.vectors[0]).not.toEqual(different.vectors[0]);
      expect(first.vectors[0]).toHaveLength(embeddings.dimensions);
      expect(first.model).toBe('deterministic-test');
    });
  });

  // === chunking ====================================================================================

  describe('chunking', () => {
    it('is deterministic', async () => {
      const text = 'Paragraph one.\n\nParagraph two is longer and says more.\n\nParagraph three.';
      expect(chunker.chunk(text)).toEqual(chunker.chunk(text));
    });

    it('respects the size budget and keeps ordinals contiguous', async () => {
      const text = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with some filler text in it.`).join('\n\n');
      const chunks = chunker.chunk(text, { maxChars: 300 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.content.length <= 300 + 150)).toBe(true);
      expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, index) => index));
    });

    it('never splits a multi-byte character', async () => {
      const text = '।'.repeat(2_000);
      const chunks = chunker.chunk(text, { maxChars: 100 });

      for (const chunk of chunks) {
        expect(Buffer.from(chunk.content, 'utf8').toString('utf8')).toBe(chunk.content);
        expect(chunk.content).not.toContain('�');
      }
    });

    it('captures a Markdown heading', async () => {
      const chunks = chunker.chunk('# Router setup\n\n' + 'Body text about setting up a router. '.repeat(60));
      expect(chunks[0].heading).toBe('Router setup');
    });

    it('returns nothing for empty input', async () => {
      expect(chunker.chunk('   ')).toEqual([]);
    });
  });

  // === candidates (§75) ============================================================================

  describe('knowledge candidates', () => {
    it('records a gap and bumps a repeat rather than duplicating it', async () => {
      const cookie = await login('manager', 'knowledge_manager');

      for (const _ of [1, 2, 3]) {
        await request(ctx.app.getHttpServer())
          .post('/api/v1/knowledge/candidates')
          .set('Cookie', cookie)
          .send({ question: 'How do I change my WiFi password?' })
          .expect(201);
      }

      const list = await request(ctx.app.getHttpServer())
        .get('/api/v1/knowledge/candidates')
        .set('Cookie', cookie)
        .expect(200);

      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].occurrences).toBe(3);
      // Manual only in this phase: nothing can produce an AI-sourced candidate yet.
      expect(list.body.items[0].sourceType).toBe('MANUAL');
    });

    it('converts a candidate into a DRAFT article', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const created = await request(ctx.app.getHttpServer())
        .post('/api/v1/knowledge/candidates')
        .set('Cookie', cookie)
        .send({ question: 'How do I reset my router?', context: 'Asked often on weekends.' })
        .expect(201);

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/candidates/${created.body.id}/convert`)
        .set('Cookie', cookie)
        .send({ categoryId: generalCategoryId })
        .expect(201);

      // Never published: conversion produces something for a human to write and approve.
      expect(response.body.article.status).toBe(KnowledgeStatus.DRAFT);
      expect(response.body.candidate.status).toBe('CONVERTED');
      expect(response.body.candidate.convertedArticleId).toBe(response.body.article.id);

      // And it is invisible to production retrieval until somebody publishes it.
      const result = await retrieval.retrieve({ query: 'reset my router' });
      expect(result.chunks).toHaveLength(0);
    });

    it('refuses to convert twice', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const created = await request(ctx.app.getHttpServer())
        .post('/api/v1/knowledge/candidates')
        .set('Cookie', cookie)
        .send({ question: 'Repeated conversion?' })
        .expect(201);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/candidates/${created.body.id}/convert`)
        .set('Cookie', cookie)
        .send({ categoryId: generalCategoryId })
        .expect(201);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/candidates/${created.body.id}/convert`)
        .set('Cookie', cookie)
        .send({ categoryId: generalCategoryId })
        .expect(409);
    });

    it('dismisses a candidate with a note', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const created = await request(ctx.app.getHttpServer())
        .post('/api/v1/knowledge/candidates')
        .set('Cookie', cookie)
        .send({ question: 'Something out of scope' })
        .expect(201);

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/candidates/${created.body.id}/dismiss`)
        .set('Cookie', cookie)
        .send({ note: 'Handled by the billing team instead.' })
        .expect(201);

      expect(response.body.status).toBe('DISMISSED');
      expect(await candidateRepo.count({ where: { status: 'DISMISSED' as never } })).toBe(1);
    });
  });

  // === links, attachments (§70) ====================================================================

  describe('links and attachments', () => {
    it('stores a YouTube reference without fetching anything', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'Video guide', body: 'See the video.', status: KnowledgeStatus.DRAFT });

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/articles/${article.id}/links`)
        .set('Cookie', cookie)
        .send({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Setup walkthrough' })
        .expect(201);

      expect(response.body.kind).toBe('YOUTUBE');
      // Parsed locally from the URL — no API call, no download, no transcript.
      expect(response.body.externalRef).toBe('dQw4w9WgXcQ');
    });

    it('recognises a short youtu.be link', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'Short link', body: 'x', status: KnowledgeStatus.DRAFT });

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/articles/${article.id}/links`)
        .set('Cookie', cookie)
        .send({ url: 'https://youtu.be/abc123XYZ_-' })
        .expect(201);

      expect(response.body.externalRef).toBe('abc123XYZ_-');
    });

    it('stores an ordinary link as a LINK', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'Doc link', body: 'x', status: KnowledgeStatus.DRAFT });

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/articles/${article.id}/links`)
        .set('Cookie', cookie)
        .send({ url: 'https://example.com/manual.html', note: 'Vendor manual' })
        .expect(201);

      expect(response.body.kind).toBe('LINK');
      expect(response.body.externalRef).toBeNull();
    });

    it('rejects a non-http scheme', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'Bad link', body: 'x', status: KnowledgeStatus.DRAFT });

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/articles/${article.id}/links`)
        .set('Cookie', cookie)
        .send({ url: 'javascript:alert(1)' })
        .expect(400);
    });

    it('attaches a document to an article and keeps its metadata', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const article = await seedArticle({ title: 'With attachment', body: 'x', status: KnowledgeStatus.DRAFT });

      const bytes = Buffer.from('attachment content', 'utf8');
      const { document } = await documents.upload(
        { buffer: bytes, originalname: 'guide.txt', mimetype: 'text/plain', size: bytes.length },
        { categoryId: generalCategoryId },
        null,
      );

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/articles/${article.id}/attachments/${document.id}`)
        .set('Cookie', cookie)
        .send({ caption: 'Installation guide' })
        .expect(201);

      const detail = await request(ctx.app.getHttpServer())
        .get(`/api/v1/knowledge/articles/${article.id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(detail.body.attachments).toHaveLength(1);
      expect(detail.body.attachments[0].caption).toBe('Installation guide');
    });
  });

  // === authorization and secrets ===================================================================

  describe('authorization', () => {
    it('requires a session', async () => {
      await request(ctx.app.getHttpServer()).get('/api/v1/knowledge/articles').expect(401);
    });

    it('lets a reader read but not create', async () => {
      const cookie = await loginWithPermissions('reader', ['knowledge.read']);

      await request(ctx.app.getHttpServer()).get('/api/v1/knowledge/articles').set('Cookie', cookie).expect(200);
      await request(ctx.app.getHttpServer())
        .post('/api/v1/knowledge/articles')
        .set('Cookie', cookie)
        .send({ title: 'Nope', categoryId: generalCategoryId })
        .expect(403);
    });

    it('refuses to publish without knowledge.approve', async () => {
      // A writer can prepare an article, but making it visible to customers is somebody else's
      // decision (§198).
      const cookie = await loginWithPermissions('writer', ['knowledge.read', 'knowledge.create']);
      const article = await seedArticle({ title: 'Pending', body: 'x', status: KnowledgeStatus.DRAFT });

      const response = await request(ctx.app.getHttpServer())
        .post(`/api/v1/knowledge/articles/${article.id}/status`)
        .set('Cookie', cookie)
        .send({ status: KnowledgeStatus.PUBLISHED });

      expect([400, 403]).toContain(response.status);
      expect((await articles.findOne(article.id)).status).toBe(KnowledgeStatus.DRAFT);
    });

    it('never returns the embedding credential or internal storage details', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const bytes = Buffer.from('secret leak check content', 'utf8');
      const { document } = await documents.upload(
        { buffer: bytes, originalname: 'check.txt', mimetype: 'text/plain', size: bytes.length },
        { categoryId: generalCategoryId },
        null,
      );

      const apiKey = 'test-embedding-credential-value';
      process.env.EMBEDDING_API_KEY = apiKey;

      for (const path of [
        '/api/v1/knowledge/status',
        '/api/v1/knowledge/articles',
        '/api/v1/knowledge/documents',
        `/api/v1/knowledge/documents/${document.id}`,
        '/api/v1/knowledge/categories',
      ]) {
        const response = await request(ctx.app.getHttpServer()).get(path).set('Cookie', cookie).expect(200);
        const body = JSON.stringify(response.body);

        expect(body).not.toContain(apiKey);
        // Storage internals have no use in a browser, and a checksum is a fingerprint of contents.
        expect(body).not.toContain(document.storageRef);
        expect(body).not.toContain(document.checksum);
      }

      delete process.env.EMBEDDING_API_KEY;
    });

    it('reports embedding availability without naming a credential', async () => {
      const cookie = await login('manager', 'knowledge_manager');
      const response = await request(ctx.app.getHttpServer())
        .get('/api/v1/knowledge/status')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.embedding).toEqual({
        available: true,
        provider: 'test',
        model: 'deterministic-test',
        dimensions: expect.any(Number),
      });
      expect(JSON.stringify(response.body.embedding)).not.toMatch(/key|secret|token/i);
    });
  });
});
