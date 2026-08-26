# Phase 4 Report — Knowledge Base

**Status: complete and verified.** All gates green: 173 unit, 278 integration (against real
PostgreSQL with pgvector and real Redis), 3 web, lint, typecheck, production build, Docker build,
and migration up → down → up.

Phase 5 has not been started. Nothing in this phase sends a message, invokes a decision engine,
scores confidence, escalates to a human, or touches the WhatsApp gateway.

Companion documents: `docs/PHASE_4_AUDIT.md` (the plan this implements), `docs/adr/0001` (the layer
boundaries), `PROJECT_SPEC.md` §14, §15, §70–§75, §114–§116, §126, §179, §198, §206.

---

## 1. What was implemented

| Area | Delivered |
|---|---|
| **Articles** | Full CRUD, Markdown body, summary, category, language, scope, slug |
| **Lifecycle** | DRAFT → REVIEW → PUBLISHED → ARCHIVED with a legal-transition table; editing a published article returns it to draft |
| **Versioning** | Immutable `v1..vN` snapshots, line-level diff, rollback that writes a *new* version |
| **Documents** | Upload → parse → clean → chunk → tag → embed → index → publish, on the Job Center queue |
| **Formats** | PDF, DOCX, TXT, Markdown, HTML indexed; PNG/JPEG/WebP stored as attachments, not indexed |
| **Chunks** | Deterministic, boundary-respecting, overlap, heading capture, per-chunk scope and status |
| **Embeddings** | `EmbeddingProvider` abstraction with a real OpenAI-compatible implementation, an honest "unavailable" mode, and a test-only deterministic provider |
| **Retrieval** | Hybrid keyword + vector, scope-prioritised, bounded, cited |
| **Scope** | GLOBAL / GROUP / CUSTOMER / PRODUCT with database-level integrity constraints |
| **Categories** | Ten seeded per §71, custom categories allowed, system categories undeletable |
| **Profiles** | Named knowledge profiles with category narrowing and scope-priority overrides; nullable bindings on `groups` and `customers` |
| **Links** | URLs and YouTube references as metadata — nothing crawled, downloaded or transcribed |
| **Attachments** | Documents bound to articles with captions; no OCR |
| **Candidates** | Gap queue with occurrence counting, convert-to-draft, dismiss — manual sources only |
| **UI** | Browser, editor, version history with diff and rollback, upload with real progress, search, gap queue |

---

## 2. Migrations

**`1787400000000-Phase4Knowledge`** — one migration, additive, verified reversible.

Nine tables: `knowledge_categories` (10 rows seeded), `knowledge_profiles`, `knowledge_articles`,
`knowledge_article_versions`, `knowledge_documents`, `knowledge_chunks`,
`knowledge_article_links`, `knowledge_article_attachments`, `knowledge_candidates`.

Two nullable columns added to existing tables: `groups.knowledgeProfileId` and
`customers.knowledgeProfileId`. Nothing else existing was altered.

**Constraints that carry weight:**

| Constraint | Why |
|---|---|
| `CHK_knowledge_articles_scope_id` | A GLOBAL article cannot carry a scope id, and a scoped article cannot omit one. Either mistake breaks scope isolation in a way that is hard to see |
| `CHK_knowledge_chunks_parent` | A chunk belongs to exactly one article or one document, never both and never neither |
| `UQ_knowledge_documents_checksum` (checksum, categoryId) | Re-uploading the same file is idempotent; the same file in a different category is legitimate |
| `UQ_knowledge_versions_article_version` | Version numbers are unique per article |
| Status CHECKs on articles, chunks, documents, candidates | The lifecycle is enforced by the database, not only by application code |

**Indexes:** GIN full-text on `knowledge_chunks.content` and on article title+summary; trigram on
article titles; `(status, scopeType, scopeId)` on chunks — the exact predicate every retrieval uses;
partial unique indexes on chunk ordinals per parent.

**The vector index is built on demand**, not in the migration. IVFFlat clusters the vectors present
when it is built, so building it on an empty table produces an index that stays bad for the life of
the deployment. `KnowledgeIndexService.ensureVectorIndex()` builds it once there are 1,000 vectors,
with `lists = sqrt(count)`. Below that a sequential scan is fast.

`CREATE EXTENSION vector` is now **required** rather than conditional: from this phase it is
load-bearing, and a deployment without it should fail during migration with a clear error rather
than at the first semantic search.

---

## 3. APIs

All under `/api/v1/knowledge`, authenticated, permission-gated, OpenAPI-annotated.

| Method | Path | Permission |
|---|---|---|
| GET | `/status` | `knowledge.read` |
| GET / POST | `/categories` | `knowledge.read` / `knowledge.create` |
| GET / POST | `/profiles` | `knowledge.read` / `knowledge.approve` |
| GET | `/articles`, `/articles/:id` | `knowledge.read` |
| POST / PATCH | `/articles`, `/articles/:id` | `knowledge.create` |
| POST | `/articles/:id/status` | `knowledge.create`; **publish and archive additionally require `knowledge.approve`** |
| GET | `/articles/:id/versions`, `/articles/:id/diff` | `knowledge.read` |
| POST | `/articles/:id/rollback` | `knowledge.approve` |
| DELETE | `/articles/:id` | `knowledge.approve` |
| POST / DELETE | `/articles/:id/links`, `/links/:linkId` | `knowledge.create` |
| POST / DELETE | `/articles/:id/attachments/:documentId` | `knowledge.create` |
| GET | `/documents`, `/documents/:id`, `/documents/:id/download` | `knowledge.read` |
| POST | `/documents` (multipart), `/documents/:id/reprocess` | `knowledge.create` |
| POST | `/documents/reindex` | `knowledge.approve` |
| DELETE | `/documents/:id` | `knowledge.approve` |
| POST | `/search` | `knowledge.read`; `includeUnpublished` requires `knowledge.create` |
| GET / POST | `/candidates`, `/candidates/:id/convert`, `/candidates/:id/dismiss` | `knowledge.read` / `knowledge.create` |

**There is no retrieval endpoint for the Decision Engine.** Phase 5 runs in this process and calls
`KnowledgeRetrievalService` directly; exposing retrieval over HTTP would create a second, weaker
path to the same data.

---

## 4. UI

New section in the existing console shell, gated on `knowledge.read`:

- **`/knowledge`** — three tabs. *Articles*: list with status, scope, version and category filters.
  *Documents*: upload with real byte-level progress, indexing status per file with the reason when
  it is not fully indexed, re-index. *Search*: runs the same retrieval the system uses, showing each
  passage with its citation, scope and score.
- **`/knowledge/articles/:id`** — editor with the lifecycle controls, link and YouTube management,
  version history, side-by-side diff and rollback. Publishing and archiving confirm first, because
  publishing is the moment content becomes usable in customer-facing answers.
- **`/knowledge/candidates`** — the gap queue, with occurrence counts, convert-to-draft and dismiss.

When no embedding provider is configured the browser says so in plain words at the top of the page.
Keyword-only results presented as the whole answer would quietly mislead whoever relies on them.

---

## 5. Queues and events

Uses the **existing** Job Center and BullMQ. No second queue system was introduced.

| Piece | Detail |
|---|---|
| Queue | `knowledge-index` (declared in Phase 1, now consumed) |
| Job type | `KNOWLEDGE_INDEX` (declared in Phase 1, now handled) |
| Handler | `KnowledgeIndexHandler`, registered through `JobProcessor.registerHandler`, **worker mode only** |
| Granularity | One item per document — progress is real, retry is precise, one corrupt PDF fails alone |
| Retry | The Job Center's existing exponential backoff. A retryable embedding failure is rethrown so the queue retries; a parse failure is terminal and fails the item immediately with a readable reason |
| Idempotency | Re-indexing deletes and rewrites a parent's chunks in one transaction, so a retry cannot leave two generations side by side |
| Realtime | New `KnowledgeEventName` union on the **existing** gateway: `knowledge.document.indexing`, `.indexed`, `.failed`, `knowledge.article.published`. Ids, counts and statuses only — never chunk text |

---

## 6. Retrieval architecture

```
query ─┬─ full-text  (plainto_tsquery over the GIN index)      ─┐
       └─ semantic   (pgvector cosine, when a provider exists) ─┴─ merge ─ scope weight ─ budget ─ cite
```

Both halves run over **one** filtered candidate set, built by a single predicate builder — so
neither can return a passage the other would have excluded. That builder is where "only published"
and "only my scope" are decided, once.

**Ranking.** A passage found by both searches is boosted 1.25× — agreement between a lexical and a
semantic match is the strongest signal available without a reranker. The result is multiplied by the
scope weight, so §74's order survives the merge: `GROUP 1.0 > CUSTOMER 0.8 > PRODUCT 0.6 >
GLOBAL 0.4`, overridable per knowledge profile.

**Bounded** on two independent axes: passage count (default 8, hard max 25) and total characters
(default 8,000). Eight long passages are far more text than eight short ones, and only the character
budget protects a context window. §14 in code.

**Cited.** Every passage carries `chunkId`, `articleId`/`documentId`, title, version, scope, score
and which strategy matched it, so the phase that consumes this can record what it was told.

Both queries are written as explicit SQL with positional parameters rather than through the query
builder — the ranking expression needs the same parameter the filter does, and for the one query
that enforces scope isolation, making what reaches PostgreSQL obvious is worth the verbosity.

---

## 7. Embedding architecture

Three modes, selected by `EMBEDDING_PROVIDER`:

| Mode | Behaviour |
|---|---|
| `none` (default) | Semantic indexing **reports itself unavailable**. Documents still parse, chunk and index for full-text search, and land in `INDEXED_WITHOUT_VECTORS` with a readable reason. The API and the UI both say semantic search is off |
| `openai` | A real call to any OpenAI-compatible `/embeddings` endpoint. Batched 64 at a time, 30-second timeout, dimension-checked. Requires `EMBEDDING_API_KEY` — enforced at boot by env validation |
| `test` | Deterministic, hash-derived, offline. **Refused in production** by env validation |

**No vector is ever faked.** A hash-derived embedding would index and query without error and return
nonsense for every question — semantic search that looks like it works is worse than semantic search
that is honestly switched off. The deterministic provider exists only so the integration suite can
exercise the whole embed → store → query path without a network or a credential, and the same
property that makes it useful there is why production refuses it.

Failures are classified. A **retryable** provider error (429, 5xx, network) is rethrown so the queue
retries rather than recording a permanent state from a temporary outage. A **permanent** error
(malformed request, wrong dimensions) marks the document `INDEXED_WITHOUT_VECTORS` with the reason
rather than losing it. A provider outage during *retrieval* degrades to keyword-only rather than
failing the call.

Each chunk records `embeddingModel` and when it was embedded, so a provider change is a detectable,
batchable re-embed rather than a silent mix of incompatible vector spaces.

---

## 8. Security

| Concern | Control | Verified |
|---|---|---|
| Disguised upload | Magic-byte signature checked against the declared MIME type | test: a ZIP named `handbook.pdf` with `Content-Type: application/pdf` is rejected |
| Disallowed type | Allow-list of MIME types with matching extensions | test |
| Oversized / empty | Configurable ceiling, enforced in the service and in multer | test |
| Path traversal | Filenames are metadata only; storage generates the on-disk name; every resolved path is checked against the storage root | test: `../../etc/passwd.txt` stores as `passwd.txt`, ref contains neither |
| Executable storage path | Uploads live outside any served directory; nothing in the application serves static files | by construction |
| Download | Authenticated, permission-checked, streamed through the API with `Content-Disposition: attachment` and `nosniff` — never a direct storage link | by construction |
| Zip/XML bombs | Page, character and size caps enforced in the worker, where a runaway cannot take down the API | caps in `parser.service.ts` |
| Script content in HTML | `<script>` and `<style>` contents removed rather than flattened — indexing minified JavaScript would poison every search that touched it | test |
| Unpublished leakage | `WHERE status = 'PUBLISHED'` in the query, not a filter applied afterwards | 5 tests |
| Scope leakage | Scope predicate excludes other groups in SQL, before ranking | 6 tests |
| Provider credential | Environment-only; never returned by an API, never in a socket payload, never logged, never in the bundle | tests + bundle scan |
| Storage internals | `storageRef` and `checksum` are absent from every API response | test |

**Prompt injection** is worth naming for the phase that will consume this: a PDF can contain "ignore
previous instructions". Phase 4 cannot fix that, and does not make it worse — chunks are stored as
inert text and retrieval returns *data with source ids*, never instructions.

---

## 9. Scope isolation

Four scopes, with integrity enforced in three places: a CHECK constraint, a service-level validation
with a readable message, and the retrieval predicate.

Chunks carry their own `scopeType`/`scopeId`, denormalised from the parent. They could be joined
for, but every retrieval filters on scope, and the correctness of isolation should not depend on
remembering to write the join. The indexer is the only writer and always sets them together —
including when an article's scope changes, which re-chunks.

Proven by test:

- Group A's knowledge is **absent** from a group B retrieval — not ranked lower, absent.
- Customer A's knowledge is absent from a customer B retrieval.
- Global knowledge appears alongside a scoped retrieval.
- With no scope given, only global knowledge is returned.
- Group outranks customer outranks global when all three match.
- A document's scope reaches its chunks, and another group cannot retrieve it.

---

## 10. Tests

**Added:** 19 unit (`pipeline.spec.ts`) + 68 integration (`knowledge.integration-spec.ts`).
No existing test was removed, skipped or weakened.

| Requirement | Covered by |
|---|---|
| Draft/review/archived never in production retrieval | 5 tests, one per status plus the authoring path |
| Published knowledge does appear | ✓ |
| Group A cannot leak into Group B | ✓ |
| Customer scope isolation | ✓ |
| Full-text search | ✓ |
| Semantic search | ✓ (deterministic provider; vector column and cosine operator exercised) |
| Indexing | ✓ including a **real PDF** and a **real DOCX**, built as valid containers in code |
| Re-indexing | ✓ |
| Idempotent processing | ✓ chunk counts stable across repeated indexing |
| Duplicate document protection | ✓ same file returns the same document; same file in another category does not |
| Candidate review/conversion | ✓ including "converts to DRAFT, invisible to production retrieval" |
| Attachment metadata | ✓ |
| Provider failure handling | ✓ permanent → `INDEXED_WITHOUT_VECTORS`; retryable → rethrown for the queue |
| Missing provider configuration | ✓ indexes without vectors, says so, keyword retrieval still works |
| Deterministic test embeddings | ✓ |
| Provider credentials never leak | ✓ across five endpoints, plus a bundle scan |
| Channel boundary remains clean | ✓ ESLint rule; `knowledge/**` importing `channel/**` fails the build |

### Gate results

| Gate | Result |
|---|---|
| API unit — 11 suites | **173 passed** |
| API integration — 8 suites, real PostgreSQL + pgvector + Redis | **278 passed** |
| Web unit | **3 passed** |
| ESLint (api, web) | pass |
| `tsc --noEmit` (api, web) | pass |
| `nest build` | pass |
| `vite build` | pass |
| Docker build — api, worker | pass |
| Migration up → down → up | pass (9 tables created, 0 after revert, 10 categories re-seeded) |

**One flaky run, not reproduced.** During the first full sweep, two tests failed while the local dev
API, worker and Vite server were all running on the same machine; the output identified only console
noise, not which assertions. Four subsequent full runs — three under load, one with the dev
processes stopped — passed 278/278. The most likely cause is timing sensitivity under CPU
contention rather than a defect, but it is recorded here rather than dismissed, because a suite that
fails once and passes four times is exactly the kind of thing that turns out to matter later.

### Live verification

Driven through the running console against the real stack:

1. Signed in, opened Knowledge — the page reported "Semantic search is off" because the dev
   environment has no provider, which is the honest-degradation path working.
2. Created an article, edited it (v2), published it with the confirmation prompt.
3. Searched: the published article came back with its citation, scope and score, matched by keyword.
4. Uploaded a document through the UI with progress; the worker picked the job up, parsed, chunked
   and indexed it, landing at `INDEXED_WITHOUT_VECTORS` with the reason spelled out.

---

## 11. Decisions and changes worth flagging

**pgvector image.** `postgres:16-alpine` → `pgvector/pgvector:pg16` in both the dev and test compose
files. Same PostgreSQL major version; the data volume survived. pgvector 0.8.6 is installed.

**PDF parser swapped mid-implementation.** `pdf-parse` was the obvious choice and turned out to
vendor a 2018 build of pdf.js that rejects valid PDFs — a conforming file generated for the test
suite failed on it with "bad XRef entry", while a current pdf.js parsed the same bytes correctly.
Replaced with `unpdf`, which wraps a maintained pdf.js. An eight-year-old parser reading untrusted
uploads was also the wrong dependency to take on (audit risk R4).

That library is ESM-only and loads its bundle lazily, which Jest's VM cannot do without
`--experimental-vm-modules`; `pnpm test:integration` now sets it via `cross-env`. Production is a
plain Node process and needs nothing.

**One pre-existing test was retargeted, not weakened.** `jobs.integration-spec.ts` used
`KNOWLEDGE_INDEX` as its example of a job type with no handler — with the comment "no handler until
Phase 4". Phase 4 gave it one, so the test now uses `EXPORT`, whose handler has not been written.
The assertion is unchanged.

**Search button label.** Live testing surfaced two controls labelled "Search" on one screen — a tab
and the submit button. The button now reads "Run search".

---

## 12. Known limitations

1. **No OCR.** A scanned PDF with no text layer fails with "a scanned image needs OCR, which is not
   supported" rather than being silently indexed as empty. Images are stored and downloadable only.
2. **Links are not fetched.** URLs and YouTube references are metadata; nothing crawls a page or
   transcribes a video. The video id is parsed from the URL locally.
3. **The embedding dimension is fixed at 1,536** by `vector(1536)`. A provider with a different width
   needs a migration and a re-embed. Detectable — each chunk records its model — but not automatic.
4. **Storage is local disk only.** The interface is in place; the S3/MinIO driver is deferred to the
   production-cutover phase, as the audit proposed.
5. **Semantic search is untested against a real provider.** The deterministic provider exercises the
   full path — batching, vector column, cosine distance, merge — but nobody has yet pointed this at
   a live embeddings endpoint. The first real run should be treated as a validation step of its own.
6. **Knowledge profiles are stored and manageable but not yet consumed.** Nothing reads
   `groups.knowledgeProfileId` until the Decision Engine does in Phase 5.
7. **Candidates are manual only**, as specified. The automatic producer is AI escalation, which does
   not exist yet; `AI_ESCALATION` is declared so that phase needs no migration, and the service
   refuses to create one today.
8. **The chunker's token count is an estimate** (four characters per token). It budgets a retrieval
   response and nothing depends on it being exact; a model-specific tokenizer would be a dependency
   per model for no gain at this stage.
9. **No UI for knowledge profiles or custom categories yet.** Both have APIs and tests; the console
   surfaces categories read-only and does not yet manage profiles.

---

## 13. Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | A real PDF uploads, indexes and is retrievable | **PASS** |
| 2 | DOCX, TXT, Markdown and HTML do the same | **PASS** |
| 3 | Oversized, wrong-MIME and disguised-extension uploads rejected with readable messages | **PASS** |
| 4 | Draft → Review → Published, each transition audited with actor and diff | **PASS** |
| 5 | Rollback restores earlier content as a new version, history intact | **PASS** |
| 6 | Retrieval returns bounded, ranked, cited passages | **PASS** |
| 7 | Retrieval honours Group → Customer → Product → Global | **PASS** |
| 8 | Production retrieval never returns Draft, Review or Archived | **PASS** |
| 9 | Group A's knowledge is not returned for group B | **PASS** |
| 10 | Indexing runs on the queue with per-document progress and working retry | **PASS** |
| 11 | Ten default categories; custom categories can be created and used | **PASS** |
| 12 | A candidate can be reviewed and converted into an article | **PASS** |
| 13 | `knowledge.read` cannot publish; `knowledge.approve` can | **PASS** |
| 14 | The embedding credential appears in no response, payload, log, audit row or bundle | **PASS** |
| 15 | `knowledge/**` cannot import `channel/**` | **PASS** (ESLint) |
| 16 | Every existing suite still passes; all gates green | **PASS** |

**Phase 4 is complete. Phase 5 has not been started.**
