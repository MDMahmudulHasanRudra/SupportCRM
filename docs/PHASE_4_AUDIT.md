# Phase 4 Audit — Knowledge Base

Read-only. Nothing was modified, created or deleted in the codebase or the databases while
producing this. Sources: `PROJECT_SPEC.md` (§14, §15, §70–§75, §111, §114–§116, §125–§126, §179,
§198, §206), `docs/IMPLEMENTATION_PLAN.md` (Phase 4), `docs/adr/0001`, the Phase 1–3.5 reports, and
the repository as it stands.

---

## 1. Scope — what Phase 4 *is*, per the spec

Phase 4 is **Knowledge**: articles, documents, an ingestion pipeline, search, versioning, approval
and knowledge profiles. Concretely, from the spec:

| § | Requirement |
|---|---|
| 70 | Articles, PDF, TXT, DOCX, Markdown, links, YouTube references, images, troubleshooting procedures |
| 71 | Ten default categories, custom categories allowed |
| 72 | upload → parse → clean → chunk → tag → embed → index → publish; store document, chunk, metadata, category, tags, embedding, source, version, created_by, updated_by |
| 73 / 198 | Draft / Review / Published / Archived; v1..vN; publish, rollback, compare, archive. **Only Published knowledge is available to production AI** |
| 74 | Retrieval priority Group → Customer → Product → Global, configurable |
| 75 | Knowledge candidates from repeated AI escalation; admin converts a candidate into knowledge |
| 14 | Retrieval is selective — exact keyword, full-text, semantic/vector. **Never send the whole KB** |
| 115 | PostgreSQL full-text where appropriate; vector retrieval for AI knowledge; **no Elasticsearch** |
| 126 / 179 | Local storage in dev, S3/MinIO in production; validate MIME, size, extension, filename, storage path; store outside executable paths; access controlled |
| 206 | Items 12 and 13: "Knowledge works", "Documents index" |

### What Phase 4 is explicitly NOT

Per your instruction and confirmed against the spec, none of these belong to Phase 4: AI fallback,
autonomous AI replies, confidence-based escalation, human escalation. The spec places them in §16,
§20–§26 and the plan puts them in Phases 5–7.

**Two boundary cases worth naming now, because they look like Phase 4 and are not:**

- **§15 "knowledge-driven response"** — sending a knowledge article to a customer without AI. This is
  a *Decision Engine* behaviour (Phase 5) and requires the outbound path. Phase 4 builds the
  retrieval that Phase 5 calls; it must not send anything.
- **§75 knowledge candidates** — the trigger is "AI repeatedly escalates", which does not exist until
  Phase 6/7. Phase 4 should build the candidate **table, review queue and convert-to-article flow**,
  with manual creation only, and leave the automatic producer for the phase that has an AI to
  produce it.

### One dependency pulled forward — flagged for your decision

The plan (Phase 4, "Dependencies") states embeddings need Phase 6's provider abstraction, so *"the
`AIProvider` interface plus one embedding provider is pulled forward into this phase."*

That is an **embedding** provider only: text in, vector out. No completions, no replies, no decisions.
I am flagging it because it is the one place Phase 4 touches AI at all, and you asked me not to
build AI features. Options in §11 (Risks & decisions).

---

## 2. Current implementation — what already exists

### 2.1 Reusable infrastructure (substantial)

| Capability | Where | Phase 4 use |
|---|---|---|
| **Job Center** — jobs + per-item progress, retry, cancel, stuck-job recovery, realtime progress events | `modules/jobs/*` | Document indexing runs as one job, one item per document (or per chunk batch). `JobType.KNOWLEDGE_INDEX` **already exists** as an unused enum member |
| **Queue** `knowledge-index` | `modules/jobs/queues.ts` | **Already declared**, no consumer yet |
| **Handler registration** `JobProcessor.registerHandler(type, handler)` | `modules/jobs/job.processor.ts` | The indexing handler plugs in exactly like `CHANNEL_PARTICIPANT_SYNC` does |
| **RBAC** with `knowledge.read`, `knowledge.create`, `knowledge.approve` and a `knowledge_manager` role | `modules/rbac/permissions.catalogue.ts` | **Already seeded.** No RBAC migration needed |
| **Audit** with before/after diffing | `modules/audit/*` | Publish, rollback, archive and category changes are auditable with no new machinery |
| **Settings** typed key/value with `ForbiddenException` on infrastructure keys | `modules/settings/*` | §74's "configurable" retrieval priority, and chunk/embedding parameters |
| **Tags** `tags` + polymorphic `entity_tags` | Phase 3 migration | §72's `tags` on documents and chunks — reuse, do not invent a second tag model |
| **Full-text search** GIN + `plainto_tsquery` pattern, injection-safe | `messages`, `conversation.service.ts:126` | The same pattern applies to articles and chunks |
| **Realtime** Socket.IO with rooms, cross-process delivery via `RedisIoAdapter` | `modules/realtime/*` | Upload/index progress. `JobProgressEvent` already exists |
| **Migrations** hand-written, `synchronize: false` | `database/migrations/*` | Phase 4 adds one |
| **Web console** login, shell, routing, tables, dialogs, vitest harness | `apps/web` | The knowledge UI slots into the existing shell |

### 2.2 Already provisioned for Phase 4 specifically

- `CREATE EXTENSION IF NOT EXISTS "vector"` is attempted in the Phase 1 migration, wrapped so a
  non-pgvector image still boots (it raises a NOTICE instead).
- `pg_trgm` is installed — useful for fuzzy title matching.
- `QUEUES.KNOWLEDGE_INDEX` and `JobType.KNOWLEDGE_INDEX` are declared.

### 2.3 What does NOT exist

| Missing | Notes |
|---|---|
| **Any `knowledge/` module** | No entities, services, controllers, tests. Zero code |
| **All knowledge tables** | articles, documents, chunks, versions, categories, profiles, candidates |
| **pgvector in the running database** | See §11 R1 — this is the one hard blocker |
| **File upload of any kind** | No `multer`, no `FileInterceptor`, no storage abstraction. `message_attachments.storageRef` exists as a *column* but nothing ever writes it — inbound media is not downloaded |
| **Document parsing** | No PDF/DOCX/Markdown dependency in `package.json` |
| **Chunking, embedding, vector search** | None |
| **AI provider abstraction** | None. No `AIProvider` interface, no embedding client |
| **Knowledge profiles** | Groups and customers have no profile column; the entity comment anticipates them |
| **Knowledge UI** | The console has four pages: login, dashboard, WhatsApp accounts, groups |

---

## 3. Proposed Phase 4 architecture

### 3.1 Where it sits

```
Channel Layer      OpenWA adapter                    ← untouched by Phase 4
Conversation Layer customers, groups, conversations  ← Phase 4 reads group/customer IDs only
Knowledge Layer    articles · documents · chunks · versions · profiles · retrieval
                   ↑ read-only to the Decision Engine (ADR-0001 §8)
```

**Channel agnosticism (your explicit constraint).** The knowledge module has *no* channel concept.
It never imports from `channel/`, never sees a `ChannelKey`, never knows a message arrived over
WhatsApp. Its only links to the rest of the domain are **opaque UUIDs** — `groupId`, `customerId` —
used for retrieval scoping in §74's priority order.

This is enforceable the same way Phase 2's boundary is: extend the existing ESLint
`no-restricted-imports` rule so `modules/knowledge/**` may not import `modules/channel/**` or any
gateway package. I propose adding that rule as part of Phase 4 rather than relying on discipline.

### 3.2 Module layout

```
modules/knowledge/
  entities/            article, document, chunk, version, category, profile, candidate
  knowledge.module.ts
  articles.controller.ts       CRUD + lifecycle (draft/review/publish/rollback/archive)
  documents.controller.ts      upload, list, reprocess, delete
  categories.controller.ts     list, create, rename  (10 seeded, custom allowed)
  profiles.controller.ts       knowledge profiles and their scope bindings
  candidates.controller.ts     review queue, convert to article  (manual only in Phase 4)
  search.controller.ts         the operator-facing search
  knowledge-retrieval.service.ts   ← the API Phase 5/6 will call. Bounded, ranked, cited
  knowledge-index.processor.ts     ← the knowledge-index queue consumer
  pipeline/
    parser.service.ts          PDF · DOCX · TXT · Markdown · HTML → clean text
    chunker.service.ts         token-aware splitting with overlap
    embedder.service.ts        calls the embedding provider; degrades to no-vector
common/storage/
  storage.service.ts           local driver now, S3/MinIO driver later, one interface
common/ai/
  embedding-provider.interface.ts   + one implementation (see §11 R2)
```

### 3.3 The pipeline (§72)

```
upload → validate (MIME · magic bytes · extension · size · filename)
       → store outside any executable path, random filename, original name kept as metadata
       → enqueue KNOWLEDGE_INDEX job (one item per document)
   worker: parse → clean → chunk → tag → embed → index → mark INDEXED
       → operator publishes (a separate, human decision)
```

Parsing runs **only** on the worker. A 40 MB PDF must never be parsed inside a request.

### 3.4 Retrieval (§14, §74)

`KnowledgeRetrievalService.retrieve({ query, groupId?, customerId?, productId?, limit })`

1. Exact keyword (title/alias match)
2. Full-text (`plainto_tsquery` over a generated `tsvector`)
3. Semantic (pgvector cosine, when available)

merged, deduplicated, ranked by a scope-priority weight in §74's order (Group → Customer → Product →
Global, weights configurable via settings), truncated to a hard cap on both chunk count and total
characters. Every returned chunk carries `{ articleId, documentId, chunkId, version, score, scope }`
so Phase 5/6 can cite it in `decision_logs`.

**Only `PUBLISHED` rows are visible** to a retrieval call flagged `production: true` — the default.
Draft and review content is reachable only through the authoring APIs, gated on `knowledge.create`.

---

## 4. Database changes

One migration, `Phase4Knowledge`, additive only. No existing table is altered except the two
nullable profile columns in the last row.

| Table | Key columns | Notes |
|---|---|---|
| `knowledge_categories` | `key` (unique), `name`, `isSystem` | 10 seeded per §71; custom allowed |
| `knowledge_articles` | `title`, `slug`, `body`, `categoryId`, `status`, `currentVersion`, `scopeType`, `scopeId`, `createdById`, `updatedById` | `status` ∈ DRAFT/REVIEW/PUBLISHED/ARCHIVED with a CHECK constraint; `scopeType` ∈ GLOBAL/GROUP/CUSTOMER/PRODUCT |
| `knowledge_article_versions` | `articleId`, `version`, `title`, `body`, `changeSummary`, `createdById` | Immutable rows; rollback writes a *new* version rather than deleting |
| `knowledge_documents` | `filename`, `originalFilename`, `mimeType`, `sizeBytes`, `checksum`, `storageRef`, `status`, `articleId?`, `categoryId`, `pageCount`, `error` | `checksum` unique per category → re-uploading the same file is idempotent |
| `knowledge_chunks` | `documentId?`, `articleId?`, `ordinal`, `content`, `tokenCount`, `embedding vector(N)`, `searchVector tsvector`, `scopeType`, `scopeId` | GIN on `searchVector`; ivfflat/HNSW on `embedding`; CHECK that exactly one parent is set |
| `knowledge_profiles` | `name`, `description`, `categoryIds`, `priorityOverride` | §74 configurability |
| `knowledge_candidates` | `question`, `occurrences`, `status`, `sourceType`, `convertedArticleId` | Manual sources only in Phase 4 |
| `groups`, `customers` | `+ knowledgeProfileId uuid NULL` | Nullable FK, no behaviour change until Phase 5 reads it |

**Indexes:** GIN on `knowledge_chunks.searchVector` and `knowledge_articles` title/body; vector index
on `embedding`; `UNIQUE (articleId, version)`; `UNIQUE (checksum, categoryId)`;
`(status, categoryId)` for the browser.

**The embedding dimension is a schema decision, not a runtime one.** `vector(1536)` fits
OpenAI-compatible `text-embedding-3-small`; a different provider with a different dimension needs a
migration. I propose storing the model name and dimension on each chunk so a future re-embed can be
detected and batched, rather than silently mixing dimensions.

---

## 5. APIs

All under `/api/v1/knowledge`, versioned like everything else, OpenAPI-annotated.

| Method | Path | Permission |
|---|---|---|
| GET | `/articles` (filter, search, paginate) | `knowledge.read` |
| POST | `/articles` | `knowledge.create` |
| GET / PATCH | `/articles/:id` | `knowledge.read` / `knowledge.create` |
| GET | `/articles/:id/versions`, `/versions/:v` | `knowledge.read` |
| GET | `/articles/:id/diff?from=&to=` | `knowledge.read` |
| POST | `/articles/:id/submit-review`, `/publish`, `/rollback`, `/archive` | `knowledge.approve` for publish/rollback/archive |
| POST | `/documents` (multipart upload) | `knowledge.create` |
| GET | `/documents`, `/documents/:id`, `/documents/:id/download` | `knowledge.read` |
| POST | `/documents/:id/reprocess` | `knowledge.create` |
| DELETE | `/documents/:id` | `knowledge.create` |
| GET | `/categories` · POST/PATCH | `knowledge.read` / `knowledge.create` |
| GET / POST / PATCH | `/profiles` | `knowledge.read` / `knowledge.approve` |
| GET | `/candidates` · POST `/candidates/:id/convert` · POST `/candidates/:id/dismiss` | `knowledge.read` / `knowledge.create` |
| POST | `/search` (operator-facing; may include unpublished when explicitly requested and permitted) | `knowledge.read` |

**No public/unauthenticated endpoint.** Retrieval for the Decision Engine is an **in-process service
call**, not an HTTP route — Phase 5 runs in the same monolith, and exposing retrieval over HTTP would
create a second, weaker path to the same data.

---

## 6. UI

New section in the existing console shell, `/knowledge`:

| Page | Contents |
|---|---|
| **Browser** | Search box, category filter, status filter, table with title/category/status/version/updated. Status chips reuse the existing badge component |
| **Editor** | Title, category, scope, Markdown body with preview; Save draft → Submit for review → Publish. Publish is visually distinct and confirms, because it is the action that exposes content to AI later |
| **Version history** | List of v1..vN, side-by-side diff, Rollback (confirming) |
| **Upload** | Drag/drop or picker, client-side type and size check, per-file progress driven by the **existing** `JobProgressEvent` — no second progress mechanism |
| **Categories** | List, create, rename. System categories not deletable |
| **Profiles** | Create/edit; assign to groups and customers from the existing group and customer pages |
| **Candidates** | Review queue with Convert → opens the editor pre-filled, and Dismiss |

Navigation gains one item, "Knowledge", visible with `knowledge.read`. Everything write-related is
hidden without the matching permission — the pattern the groups page already uses.

---

## 7. Queues, workers and events

| Piece | Detail |
|---|---|
| Queue | `knowledge-index` — **already declared**, needs a consumer |
| Job type | `KNOWLEDGE_INDEX` — **already declared** |
| Worker | `KnowledgeIndexProcessor` registered via `JobProcessor.registerHandler`, worker mode only, exactly as `ChannelMaintenanceProcessor` is |
| Item granularity | One item per document. Progress and retry are per document, so one corrupt PDF in a batch of fifty fails alone |
| Realtime | New `KnowledgeEventName` union: `knowledge.document.indexing`, `.indexed`, `.failed`, `knowledge.article.published`. Same gateway, same rooms, **no second realtime system** |
| Retry | Existing exponential backoff. Embedding-provider failures are retryable; a parse failure on a corrupt file is not, and should fail the item immediately with a readable reason |
| Idempotency | Re-indexing a document deletes and rewrites its chunks in one transaction, keyed by `documentId`, so a retry cannot double-insert |

---

## 8. Security and privacy

| Concern | Control |
|---|---|
| **Malicious upload** | Validate MIME **and** magic bytes (an extension check alone is trivially bypassed), extension allow-list, size cap, filename sanitization. §126/§179 |
| **Executable storage path** | Files stored under a non-served directory with generated names; the original filename is metadata only, never a path component. No static route serves the upload directory |
| **Download access control** | `/documents/:id/download` is authenticated, permission-checked and streams through the API. Never a direct link to storage |
| **Zip/XML bombs** | Page/size/time caps on parsing, enforced in the worker where a runaway job cannot take down the API |
| **Unpublished leakage** | Production retrieval filters on `PUBLISHED` at the query level, not in application code. §198 |
| **Secrets** | The embedding provider's API key follows the `openwa.api_key` precedent exactly: environment-only, in `INFRASTRUCTURE_ONLY_KEYS`, never returned by an API, never logged, never in a socket payload |
| **PII in knowledge** | An operator can paste customer data into an article, and it then feeds AI later. Phase 4 should audit article creation and publication with actor and diff — which the existing audit service already does |
| **Prompt injection via documents** | A PDF can contain "ignore previous instructions". Phase 4 cannot fix this, but it should not make it worse: chunks are stored as inert text, and the retrieval contract returns *data with source ids*, never instructions. Worth a note for Phase 6 |
| **Tenant/scope leakage** | Group-scoped knowledge must not surface for another group. Scope filtering belongs in the query, and needs a dedicated test |

---

## 9. Tests

| Area | Cases |
|---|---|
| Upload validation | Oversized; wrong MIME; **disguised extension** (`.pdf` that is a ZIP); path-traversal filename; empty file; duplicate checksum |
| Parsing | PDF, DOCX, TXT, Markdown each parse to expected text; a corrupt file fails the item with a readable reason and does not retry forever |
| Chunking | Deterministic; respects size and overlap; never splits mid-UTF-8; ordinals contiguous |
| Embedding | Provider failure retries; permanent failure marks the document `INDEXED_WITHOUT_VECTORS` rather than losing it; a run with no provider configured still produces full-text-searchable chunks |
| Indexing job | One item per document; progress events; retry of a failed item; re-index replaces chunks and does not duplicate |
| Retrieval | Returns relevant chunks; **respects §74 priority order**; bounded by chunk count and character budget; every result carries a citation; **unpublished content never returned to a production call**; group-scoped content invisible to another group |
| Versioning | Publish increments; rollback creates a new version rather than deleting; diff correctness; archived content leaves production retrieval |
| RBAC | `knowledge.read` cannot create; `knowledge.create` cannot publish; unauthenticated 401 on every route |
| Audit | Publish, rollback and archive each write a row with before/after and actor |
| Architecture | ESLint boundary: `knowledge/**` importing `channel/**` fails the build |

Plus web tests for the editor's publish confirmation and the upload progress wiring.

---

## 10. Acceptance criteria

Phase 4 is done when, and only when, each of these has actually been executed:

1. A real PDF uploads, indexes and is retrievable by a natural-language query (§206.13).
2. DOCX, TXT and Markdown do the same.
3. An oversized, a wrong-MIME and a disguised-extension upload are each rejected with a readable
   message and nothing written to storage.
4. An article moves Draft → Review → Published, and each transition is audited with actor and diff.
5. Rollback restores an earlier version's content as a **new** version, with history intact.
6. A retrieval call returns bounded, ranked, cited chunks — and the citation resolves to the right
   article and version.
7. Retrieval honours Group → Customer → Product → Global, demonstrated with fixtures where a
   group-scoped and a global chunk both match and the group-scoped one ranks first.
8. **A production retrieval call never returns Draft, Review or Archived content.**
9. Group-scoped knowledge for group A is not returned for group B.
10. Indexing runs on the queue with per-document progress in the Job Center and a working retry.
11. Ten default categories exist; a custom category can be created and used.
12. A knowledge candidate can be reviewed and converted into an article.
13. `knowledge.read` cannot publish; `knowledge.approve` can.
14. The embedding provider key appears in no API response, socket payload, log line, audit row or
    frontend bundle.
15. `knowledge/**` cannot import `channel/**` — the lint rule fails the build if it does.
16. All existing suites still pass; unit + integration + web + lint + typecheck + Docker build green.

---

## 11. Risks and decisions needed

**R1 — pgvector is not installed. This is a blocker.** ⚠️
The running database is `postgres:16-alpine`, which does not ship pgvector; `pg_extension` confirms
only `pgcrypto`, `pg_trgm`, `uuid-ossp`, `plpgsql`. The Phase 1 migration anticipated this and
degrades gracefully, but semantic search cannot exist without it.
*Options:* (a) switch the image to `pgvector/pgvector:pg16` — same PG major, the volume and data
survive, roughly a two-line compose change plus a restart; (b) ship Phase 4 with full-text only and
add vectors later, which means a second migration against a populated table. **I recommend (a).**

**R2 — the embedding provider.** Embeddings need a provider, which means an API key and outbound
network calls, and it is the one AI-adjacent thing in Phase 4.
*Options:* (a) pull forward a minimal `EmbeddingProvider` interface plus one OpenAI-compatible
implementation, as the plan intends; (b) build the interface with a **local/deterministic
implementation only** and defer any real provider to Phase 6; (c) full-text only for now.
**I recommend (a) with (b) as the default when no key is configured** — so the whole pipeline is
testable and demonstrable offline, and turning on a real provider is configuration, not code.

**R3 — the "AI-adjacent" line.** §75's candidate *producer* is AI escalation, which does not exist
yet. I propose building the candidate model and review UI with manual creation only, and leaving a
documented seam for Phase 6/7. Confirm you want that rather than deferring candidates entirely.

**R4 — parser dependencies.** PDF and DOCX parsing means new third-party packages that read
untrusted input — historically a source of CVEs. Mitigation: parse only in the worker, cap size and
time, pin versions, and keep the list short (one PDF library, one DOCX library, one Markdown
library).

**R5 — scope creep from §70.** "Links, YouTube references, images" could each become a project.
I propose Phase 4 stores links and YouTube URLs as **article metadata** (title, url, note) with no
fetching or transcription, and images as attachments without OCR. Anything more is a later phase.

**R6 — embedding dimension lock-in.** `vector(N)` fixes N at migration time. Mitigated by recording
model and dimension per chunk so a provider change is a detectable, batched re-embed.

**R7 — storage driver.** Local disk in dev is fine; production wants S3/MinIO. Building the
interface now costs little; building the S3 driver now is speculative. I propose the interface plus
the local driver, with the S3 driver deferred to Phase 11 (production cutover).

---

## 12. Files and modules expected to change

**New:**
```
apps/api/src/modules/knowledge/**                     (entities, controllers, services, processor)
apps/api/src/common/storage/storage.service.ts
apps/api/src/common/ai/embedding-provider.interface.ts + local + openai-compatible impls
apps/api/src/database/migrations/17874xxxxxxxx-Phase4Knowledge.ts
apps/api/test/knowledge.integration-spec.ts
apps/web/src/pages/knowledge/*.tsx                    (browser, editor, versions, upload, categories, profiles, candidates)
apps/web/src/api/client.ts                            (knowledge section)
docs/PHASE_4_REPORT.md
```

**Modified (small, additive):**
```
apps/api/src/app.module.ts                     register KnowledgeModule
apps/api/src/modules/jobs/job.processor.ts     register the KNOWLEDGE_INDEX handler
apps/api/src/modules/realtime/realtime.gateway.ts   KnowledgeEventName union + emit helper
apps/api/src/config/env.validation.ts + configuration.ts   storage path, upload caps, embedding config
apps/api/src/modules/settings/settings.service.ts   retrieval-priority keys; provider key in INFRASTRUCTURE_ONLY_KEYS
apps/api/eslint.config.*                       knowledge → channel import boundary
apps/web/src/app.tsx                           route + nav item
docker-compose.yml                             postgres image → pgvector (R1)
.env.example                                   new keys
```

**Explicitly untouched:** `modules/channel/**`, `modules/ingestion/**`, `modules/messaging/**`,
`modules/crm/**` (except the two nullable `knowledgeProfileId` columns), the OpenWA adapter, the
gateway, and every existing test.

---

## 13. Summary

The foundation is in better shape than the empty `knowledge/` directory suggests: the queue, the job
type, the permissions, the role, the audit trail, the tag model, the full-text pattern, the realtime
transport and the Job Center progress UI all already exist and were built with this phase in mind.
What is missing is the knowledge domain itself, a storage abstraction, document parsing, and vectors.

**One blocker needs a decision before code:** pgvector is not in the running image (R1). Two smaller
decisions shape the work: the embedding provider (R2) and the candidate scope (R3).

Awaiting approval — no Phase 4 code has been written.
