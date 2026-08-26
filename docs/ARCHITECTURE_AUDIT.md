# Support CRM — Phase 0 Architecture Audit

> Deliverable for `PROJECT_SPEC.md` §155 (Phase 0), §207.
> Status: **Audit only — no code written, no destructive change made.**
> Date of audit: 2026-08-23
> Canonical source of truth: `PROJECT_SPEC.md` (v1.0)
>
> ⚠️ **Partly superseded by [ADR-0001](adr/0001-track-a-openwa-gateway-foundation.md).**
> The owner selected **Track A**, closing the open question at §9. §1 of this document was written
> from OpenWA's published documentation; the gateway has since been cloned to `gateway/` and
> verified at source level, and it is materially more capable than §1 states — it already has BullMQ
> queues, a durable webhook outbox with a reconciler, an engine capability matrix, Redis-backed
> Socket.IO, and multi-node session takeover. **ADR-0001 §2 is the corrected, authoritative record
> of OpenWA's architecture and integration contracts.** Read it alongside §1 below.

---

## 0. Executive summary

The audit produced one finding that changes the shape of Phase 1, and must be
settled before any implementation begins.

**The working directory is empty of code.** `C:\Users\rudra\OneDrive\Desktop\Support CRM`
contains exactly two files — `PROJECT_SPEC.md` and a notes file. There is no
`package.json`, no `src/`, no git repository, and **no vendored copy of OpenWA**.
The spec (§3) instructs the agent to "inspect the actual repository available in
the working environment"; there is none. The audit therefore proceeded against
the two real artifacts that do exist:

1. **`github.com/rmyndharis/OpenWA`** — the upstream project the spec names as the
   integration foundation. Audited from its published documentation (§1 below).
2. **`../Support Message Automation`** — a substantial, production-deployed
   WhatsApp support-automation system belonging to the same owner, sitting one
   directory up on the same Desktop. ~60 database models, 33 applied migrations,
   a live VPS deployment, and roughly 40–50% of this specification's domain logic
   already built and tested (§2 below). This is the single most valuable reusable
   asset available, and the spec's §2/§4 "identify reusable modules" step is
   meaningless without it.

**Critical disambiguation — two different things are called "OpenWA":**

| Name | What it actually is | Where it appears |
|---|---|---|
| **OpenWA** (`rmyndharis/OpenWA`) | A NestJS 11 **WhatsApp API gateway** — REST + webhooks + dashboard + MCP, TypeORM, whatsapp-web.js/baileys engines | Named in `PROJECT_SPEC.md` §3 |
| **`@open-wa/wa-automate`** | An **npm library** that drives WhatsApp Web via Puppeteer, embedded in-process | The dependency actually used by `../Support Message Automation` |

These are unrelated codebases with unrelated APIs. The prior project is *not*
built on the OpenWA the spec references. Any plan that assumes "we already have
OpenWA integrated" would be wrong. This is documented in full at §5.1.

**Recommendation** (detail and trade-off at §7): adopt **Track A — fork OpenWA
(the gateway) as the WhatsApp transport layer, build Support CRM as NestJS domain
modules on top of it, and port proven domain logic from Support Message
Automation rather than inheriting its codebase.** This is the only track that
satisfies the spec as written. It carries a real, non-trivial migration cost that
the owner should acknowledge explicitly before Phase 1 starts (§9).

---

## 1. Existing OpenWA architecture (`rmyndharis/OpenWA`)

Audited from the upstream repository's published documentation. **Not yet cloned
into this workspace** — a verbatim source-level audit is the first task of Phase 1
and may revise details below.

### 1.1 Stack

| Concern | Implementation |
|---|---|
| Runtime | Node.js 22 LTS |
| Framework | NestJS 11.x |
| Language | TypeScript 6.x |
| WhatsApp engine | Pluggable — `whatsapp-web.js` (default, safer) or `baileys` (lighter) |
| Database | SQLite **or** PostgreSQL |
| ORM | TypeORM |
| Cache | Redis (optional) |
| Auth | API keys + role-based access control |
| Dashboard | React SPA |
| Container | Docker, `linux/amd64` + `linux/arm64`, non-root, Docker socket proxy |
| Licence | MIT |

### 1.2 Directory structure

```
src/
├── config/      configuration management
├── common/      shared utilities (cache, storage)
├── core/        plugin system + hooks  (src/core/hooks/)
├── engine/      WhatsApp engine abstraction (wwebjs | baileys)
├── modules/     session, message, webhook, group, contact, auth, infra, health
dashboard/       React web interface
docs/            documentation
```

The `engine/` abstraction is the most important structural fact in this audit:
OpenWA already isolates the WhatsApp transport behind an interface, which is
exactly the seam Support CRM's Channel Adapter (spec §53–54) needs.

### 1.3 Existing APIs

REST endpoint groups: **Sessions**, **Messages**, **Groups**, **Contacts**,
**Webhooks**, **Labels**, **Health**.

- Sessions: create/start/manage, multi-account concurrent, per-session proxy,
  auto-reject-calls, engine selection.
- Messages: text, media, reactions, edits, status/delivery tracking.
- Groups: create, manage, join by invite code, configure, group labels.
- Contacts: profile display name/photo, contact operations.
- OpenAPI/Swagger at `/api/docs`, off in production unless `ENABLE_SWAGGER=true`.
- MCP: `POST /mcp` (stateless Streamable-HTTP) when `MCP_ENABLED=true` — 25
  read-only tools by default, 51 when `MCP_READONLY=false`.

### 1.4 Existing events

Webhook delivery with **HMAC-signed** payloads. Documented event types include
`message.received`, `session.status`, `message.edited`, `call.received`.
Smart filters can pre-filter deliveries on `sender`, `recipient`, `body`, `type`,
`mentions`, `fromMe`, `hasMedia`, `isGroup`.

**Assessment:** this is a delivery mechanism, not a durable event bus. It has no
ordering guarantee, no at-least-once replay, and no consumer offset. Support CRM
must treat webhook receipt as *ingress only* and immediately persist + enqueue
(spec §6: "Heavy operations MUST NOT execute synchronously inside the webhook
request"). See §5.6.

### 1.5 Existing queues

**None as a first-class concept.** Redis is present only as an *optional cache*
profile in compose. There is no BullMQ/job abstraction in OpenWA to inherit —
Support CRM must supply the entire queue/worker layer (spec §49, §56, §121).

### 1.6 Existing authentication

API-key based with RBAC. This is machine-to-machine auth for the gateway. It is
**not** the human admin authentication + session + RBAC model the spec requires
(§108, §178). Support CRM needs its own user/session/role layer; OpenWA's API-key
model maps onto the spec's *scoped external API keys* (§93, §177) instead.

### 1.7 Existing dashboard

React SPA for managing sessions, webhooks, and API keys. Operationally useful and
should be **kept intact** for WhatsApp-transport administration. It is not a CRM
inbox and must not be extended into one — Support CRM's operator UI (spec §60,
§131) is a separate application surface.

### 1.8 Existing Docker

Compose profiles: `postgres`, `redis`, `minio`, `full`. API + dashboard on port
`2785`; dev dashboard on `2886`. Storage backends: local / S3 / MinIO. Non-root
container execution, Docker socket proxy for session container management.

This maps cleanly onto the spec's §150 target (`support-crm`, `postgres`, `redis`,
`worker`, optional `minio`, reverse proxy) — the profiles already exist and only
need the two new Support CRM services added.

### 1.9 Existing plugins

"Integration Fabric" with sandboxed official plugins (Chatwoot, Typebot) and a
hook system under `src/core/hooks/`. **This is the preferred extension point**
for anything Support CRM needs to observe inside the gateway, in preference to
patching gateway modules (spec §211–212).

---

## 2. The prior-art system: `../Support Message Automation`

A working, deployed system by the same owner. Audited at source level.

### 2.1 Shape

pnpm monorepo, Node 22.13+, `pnpm@11.9.0`.

```
apps/web              Next.js 16 App Router dashboard (React 19, Tailwind 4)
apps/worker           dedicated Node/TS process — sole owner of WhatsApp sessions
packages/db           Prisma schema (2117 lines, ~60 models), 33 migrations, seed
packages/engine       pure, side-effect-free rule evaluation
packages/shared       enums / types / permission catalogue
packages/ai-client    deliberately text-only Anthropic completion wrapper
packages/teams-client hand-rolled MS Graph / OAuth client
```

Deployment: `docker compose` with `postgres` + one-shot `migrate` + `app` + `worker`.
Postgres deliberately unpublished; worker health bound to `127.0.0.1`; the WhatsApp
session directory on a named volume (`support_automation_whatsapp_session`) —
verified to survive `docker compose down/up` without a QR re-scan.

### 2.2 Coordination model — no HTTP between web and worker

All web⇄worker coordination goes through Postgres rows:

- **Worker → Dashboard**: worker writes `WhatsAppAccount.status/qrCode/lastHeartbeatAt`;
  dashboard polls those columns.
- **Dashboard → Worker**: anything needing the live browser session is inserted as a
  `WorkerCommand` row; worker polls every 1.5s, strictly serially.
- **Kill switch**: `AutomationSettings.automationEnabled`, re-read every processing tick.

This is a genuinely good design *for a single-worker Puppeteer system*, and it is
why the project has no Redis. It does **not** scale to spec §119 (3,000+ groups,
multiple concurrent AI conversations, bulk jobs) and it cannot express spec §185
distributed locks or §186 conversation-level concurrency across more than one
worker process. See §5.4.

### 2.3 Incoming message pipeline (`apps/worker/src/pipeline/processIncomingMessage.ts`)

Real, working order of operations:

```
raw event
 → drop empty body
 → direction guard (non-INCOMING stored but never automated — primary loop guard)
 → isActiveTeamMember(senderPhone)
 → resolve WhatsAppGroup
 → fetch previous message in chat (before insert, so it can't match itself)
 → resolve quoted message reference
 → prisma.message.create  ── P2002 unique violation == duplicate event → return
 → escalation hook        (fire-and-forget, own error boundary)
 → support-activity hook  (fire-and-forget, own error boundary)
 → load ACTIVE AutomationRules → engine.evaluate() (single priority-sorted pass)
 → if finalDecision === "NO_MATCH" → runAiFallback()   (fire-and-forget)
 → execute actions (enqueue only — never sends directly)
 → AutomationExecution row (decision + reasonTrace + idempotencyKey)
 → message.processingStatus = PROCESSED | IGNORED
 → ProcessingCheckpoint upsert
```

**Idempotency** is a real DB `@@unique([accountId, whatsappMessageId])` with
insert-and-catch-`P2002`. The same pattern is reused for `SupportActivity.messageId`,
`SupportEscalationEvent`, and `IssueResolutionEvent`. This is exactly the discipline
spec §59 asks for and should be carried forward verbatim.

**Separation of decide/send** is already correct: actions enqueue into
`OutboundMessage`; nothing in the pipeline calls the provider. That satisfies the
spirit of spec §161.

### 2.4 Outbound queue (`apps/worker/src/queue/outboundQueueProcessor.ts`)

A DB-backed queue on the `OutboundMessage` table:

- `claimNextOutboundMessage()` — `findFirst` PENDING + due, then a conditional
  `updateMany(status: PENDING → PROCESSING)`; `count === 0` means the race was lost.
- Crash recovery — rows stuck in `PROCESSING` past 2 minutes return to PENDING at boot.
- Retry — configurable backoff array, default `[30s, 5m, 15m]`.
- Rate limiting — `rateLimiter.ts` counts `OutboundMessage` rows with `status: SENT`
  in trailing minute/hour/day windows, globally per account and per destination phone.
- Broadcast gating — per-job `maxPerMinute`, kill-switch cancellation, defer-not-fail
  semantics (row returns to PENDING with `scheduledAt + 15s`).

**Assessment:** conceptually right, mechanically the wrong substrate at target
scale. Every rate-limit decision is three `COUNT(*)` queries against the most
write-hot table in the system, on every single send. Under 3,000 groups this
becomes the dominant database load. Redis counters (spec §57, §184) replace it
directly with no change to the *policy*, only the *storage*.

### 2.5 Rule engine (`packages/engine`)

Pure, side-effect-free, no `@prisma/client` dependency, imported identically by
the dashboard's dry Rule Tester and the worker's live pipeline — so the simulator
can never drift from production. Contents: `matchers.ts`, `conditions.ts`,
`evaluate.ts`, `normalize.ts`, `actions.ts`, `regexSafety.ts`,
`patternDetection.ts`, `supportKeywordMatch.ts`, plus tests.

`regexSafety.ts` validates administrator-authored patterns at save time and
evaluates them under a runtime timeout — no admin-authored regex can hang the
worker. This is a real security control (ReDoS) and directly satisfies spec §77's
`regex` condition type safely.

**This package is the single highest-value reusable artifact in either codebase.**
It is framework-agnostic TypeScript with tests and should be ported essentially
as-is (§4.1).

### 2.6 AI layer — three separate consumers, three safety boundaries

| Consumer | Location | Boundary |
|---|---|---|
| Conversation Learning analysis | `apps/worker/src/learning/` | uses `packages/ai-client`, which has **no** tool-use and **no** Prisma/WhatsApp access — the absence *is* the safety guarantee |
| Hybrid AI Automation fallback | `apps/worker/src/aiFallback/` | fires only on `NO_MATCH` + per-group opt-in; writes an `AiFallbackDecision` audit row; reuses the existing `OutboundMessage` queue — never a second send path |
| AI Admin Assistant | `apps/web/src/server/aiAdmin/` | real tool-calling, but a **fixed registry of read-only tools only** — cannot change any setting |

`AiProvider` / `AiModelConfig` already model provider abstraction with per-job
model slots: `LEARNING`, `RESPONSE`, `VISION`, `DOCUMENT`, `EMBEDDING`,
`ADMIN_ASSISTANT`. API keys are stored via `encryptSecret`/`decryptSecret`
(`AI_CREDENTIALS_ENCRYPTION_KEY`). Clients implemented: `AnthropicClient`,
`OpenAiCompatibleClient`, resolved by `resolveAiClient.ts`.

**Gap:** the fallback prompt (`aiFallback/prompt.ts`) sends **only** the customer
message and the group name. No knowledge retrieval, no conversation history, no
summary, no support profile, no policy. It parses a 4-line regex format
(`INTENT/CONFIDENCE/SHOULD_REPLY/RESPONSE`) rather than structured output. Against
spec §16, §25, §26 this is a stub of the real AI Decision Engine, not an
implementation of it.

### 2.7 Database — what already exists

33 applied migrations, ~60 models. Grouped:

- **Core messaging** — `User`, `UserSession`, `SecuritySettings`, `PermissionModule`,
  `Permission`, `WhatsAppAccount`, `WhatsAppServiceRoute`, `WhatsAppGroup`,
  `InternalTeamMember`, `Message`, `ProcessingCheckpoint`
- **Rule engine** — `AutomationRule`, `AutomationExecution`, `AutomationSettings`,
  `OutboundMessage`
- **Bulk** — `GroupBroadcastJob`, `GroupBroadcastSettings`,
  `GroupParticipantAddJob`, `GroupParticipantAddItem`, `GroupParticipantAddSettings`
- **Ops** — `Notification`, `WorkerCommand`, `SystemLog`
- **AI** — `AiSettings`, `AiProvider`, `AiModelConfig`, `AiKnowledgeItem`,
  `AiKnowledgeVersion`, `AiFallbackDecision`
- **Escalation** — `SupportPriorityPolicy`, `SupportEscalationSettings`,
  `SupportEscalationCase`, `SupportEscalationEvent`
- **Learning** — `ConversationSession`, `LearningSettings`, `LearningBatchJob`,
  `PatternCandidate`, `PatternCandidateEvidence`, `RuleProposal`
- **Support activity** — `SupportActivitySettings`, `SupportKeyword`, `SupportRule`,
  `SupportRuleKeyword/Group/TeamMember`, `SupportActivity`, `SupportSession`
- **Teams** — `TeamsAccount`, `TeamsTeam`, `TeamsChannel`, `TeamsMessage`,
  `TeamsResolutionKeyword/Rule/RuleKeyword`, `TeamsIntegrationSettings`,
  `SupportIssue`, `IssueResolutionEvent`

Multi-account routing is already solved: exactly one `WhatsAppAccount.isPrimary`
(hand-written partial unique index — not expressible in the Prisma DSL), with
`WhatsAppServiceRoute` keyed on a closed `WhatsAppServiceKey` enum and a
`PRIMARY_FALLBACK` / `STRICT_NO_FALLBACK` policy, resolved through one centralized
`resolveWhatsAppAccount(serviceKey)`.

### 2.8 What the prior system does **not** have (vs. this spec)

| Spec requirement | Status in prior system |
|---|---|
| `Customer` / `CustomerContact` entity (§64) | **Absent.** Customers exist only implicitly as phone numbers and group names |
| `Conversation` entity + participants (§65) | **Absent.** `ConversationSession` is a learning-analysis window, not a CRM conversation |
| Conversation **state machine** (§7–8) | **Absent.** No `AUTOMATION_ACTIVE`/`AI_ACTIVE`/`HUMAN_ACTIVE`/… states |
| Centralized **Message Decision Engine** (§5, §159) | **Partial.** Rule engine plus a bolted-on AI fallback branch; no single pipeline all engines pass through |
| `decision_logs` (§112, mandatory) | **Absent.** `AutomationExecution.reasonTrace` covers rules only, never AI/knowledge/policy |
| `conversation_state_history` (§111) | Absent |
| Channel abstraction (§53) | **Absent.** WhatsApp concepts are in the domain model (`WhatsAppGroup`, `whatsappMessageId`) |
| Support Profiles / Knowledge Profiles / inheritance (§42, §45) | Absent |
| Group modes (§43: MANUAL/AUTOMATION_FIRST/AI_FIRST/HYBRID/HUMAN_ONLY/PAUSED) | Absent — global `AutomationSettings.mode` has only 3 values |
| Support Inbox (§60–61) | **Absent.** No reply-from-CRM UI, no take-over/release, no pinning, no internal notes |
| Human takeover / release-to-AI controls (§35–38) | Partial — only a passive `aiSuppressedUntil` cooldown |
| Knowledge documents, chunking, embeddings, vector retrieval (§70–74) | **Absent.** `AiKnowledgeItem` is manual Q&A rows; `EMBEDDING` is an unused model slot |
| RAG in the AI path (§14–16) | **Absent** — the fallback prompt carries no knowledge |
| Roles table + spec's role set (§108) | Partial — `PermissionModule` profiles, no `Role`/`role_permissions` |
| `audit_logs` with before/after/actor/IP (§107) | **Absent.** `SystemLog` is application logging, not an audit trail |
| Redis: queues, locks, rate limits, cache, job progress (§184–186) | **Absent entirely** |
| Generic Job Center / `jobs` + `job_items` (§50–51) | Partial — one bespoke job table per feature |
| Tags / `entity_tags` (§63) | Absent |
| REST API `/api/v1/*` + OpenAPI (§116) | **Absent.** Next.js Server Actions plus exactly two REST routes |
| Real-time WebSocket/SSE (§102, §118) | **Absent.** Column polling |
| Message media/attachments (§66) | Absent — text only |
| Message bursts / debounce (§188), AI cooldown (§189) | Partial (`aiReplyCooldownSeconds` only) |
| Feature flags (§124) | Absent |

---

## 3. Reusable components

Graded against spec §3's Reuse / Extend / Isolate / Replace taxonomy.

### 3.1 REUSE — take as-is

| Component | Source | Note |
|---|---|---|
| WhatsApp transport, sessions, QR, multi-account | OpenWA gateway | Spec §52, §54. Do not reimplement (§3) |
| OpenWA `engine/` abstraction | OpenWA gateway | Already the seam the Channel Adapter needs |
| OpenWA webhook delivery + HMAC signing | OpenWA gateway | Ingress into Support CRM |
| OpenWA plugin/hook system (`src/core/hooks/`) | OpenWA gateway | Preferred extension point (§211) |
| OpenWA React dashboard | OpenWA gateway | Keep for transport admin; do not grow it into a CRM |
| OpenWA Docker compose profiles | OpenWA gateway | `postgres`/`redis`/`minio`/`full` already exist |
| `packages/engine` rule evaluation + `regexSafety` + tests | Prior system | Port near-verbatim (§4.1) |
| `packages/shared` permission catalogue pattern | Prior system | Seeded table + FK, not a string enum — fails closed on typos |
| Idempotency discipline (`insert-and-catch-P2002`) | Prior system | Becomes `insert-and-catch-23505` under TypeORM |
| Escalation message formatting | Prior system | `formatEscalationMessage.ts` maps onto spec §31 |
| `encryptSecret`/`decryptSecret` convention | Prior system | Satisfies §22, §109, §177 |
| Support Activity detection semantics (KEYWORD/REPLY/MENTION, 3 counting modes, 3 periods, computed at query time) | Prior system | Direct match for §68–69 |

### 3.2 EXTEND

| Component | Extension required |
|---|---|
| `AutomationRule` shape | Add schedules/timezone (§80), cooldown (§81), versioning + Draft/Review/Published/Paused/Archived (§82, §199), health scoring (§84), and the full §77 condition set |
| `AiProvider`/`AiModelConfig` | Keep the per-job-slot design; add an `AIProvider` capability interface (chat/embeddings/classification/summarization/structured output, §21), a fallback provider chain (§123), Gemini/OpenRouter |
| `AiKnowledgeItem`/`Version` | Keep versioning; add documents, chunks, embeddings, categories, profiles, Draft/Review/Published/Archived (§70–74, §198) |
| `WhatsAppAccount` + service routing | Generalize to `ChannelAccount` + capability descriptor (§53, §176) |
| `Notification` + dispatcher | Add executive/internal-group escalation targets (§33–34) |
| Rate limiter policy | Same policy, Redis counters instead of `COUNT(*)` (§4.2) |
| Broadcast job model | Generalize into the shared `jobs`/`job_items` Job Center (§50) |

### 3.3 ISOLATE — new Support CRM modules

Everything in §2.8's "Absent" column. Enumerated as modules at §6.2.

### 3.4 REPLACE — with a documented reason

| Replaced | Reason |
|---|---|
| DB-polling `WorkerCommand` coordination | Cannot express distributed locks (§185) or conversation-level concurrency (§186) across more than one worker; replaced by Redis queues + control commands. **The `WorkerCommand` table concept is retained as an audit trail of operator-issued commands.** |
| `COUNT(*)`-based rate limiting | Dominant DB load at 3,000 groups; Redis counters, identical policy |
| Column polling for UI freshness | Spec §102 forbids aggressive polling; replaced by WebSocket/SSE |
| Regex-parsed AI text format | Spec §16 requires machine-readable structured decision output |
| Next.js Server Actions as the only API | Spec §116 requires a versioned REST API with OpenAPI |

Nothing in OpenWA itself is proposed for replacement.

---

## 4. Reuse strategy in detail for the two crown jewels

### 4.1 `packages/engine` → `src/modules/automation/engine/`

Pure TypeScript, no ORM import, fully unit-tested. Port with three changes and
nothing else:

1. `EngineRule` gains the §77 conditions the current shape lacks (time/day/business
   hours, message type, attachment type, AI intent/confidence, customer history, tag,
   status, profile).
2. `evaluate()` returns a richer trace that becomes the `decision_logs` payload (§112)
   rather than a rule-only trace.
3. It stays side-effect-free and stays imported by **both** the live pipeline and the
   Automation Simulator (§83), preserving the prior system's most valuable invariant:
   the simulator can never drift from production.

### 4.2 Outbound queue → Redis + `outbound_messages`

Keep the *semantics* exactly: single claim, PROCESSING lease, crash recovery to
PENDING, configurable backoff array, defer-not-fail on rate limit, kill-switch
cancellation of pending broadcast rows. Change only the substrate: the durable row
stays in Postgres (source of truth — spec §184 forbids Redis as a source of truth),
while the *claim* and the *rate-limit counters* move to Redis so multiple workers
can run safely.

---

## 5. Conflicts and risks

### 5.1 Naming collision — two different "OpenWA" (**HIGH**)
The spec's OpenWA is a NestJS API gateway. The prior system's `@open-wa/wa-automate`
is an in-process Puppeteer library (pinned `4.76.0`, with a local patch at
`patches/@open-wa__wa-automate@4.76.0.patch`). **No prior-system code that touches
WhatsApp is portable.** `OpenWAProvider.ts`, `ProviderRegistry`, `connectionState`,
session-directory handling, and the sequential-connect workaround for `@open-wa`'s
process-global `process.chdir()` all become obsolete — the gateway owns sessions in
its own process. Only the *interface shape* survives, and it is superseded by the
richer `ChannelAdapter` (§53).

### 5.2 ORM conflict — Prisma vs TypeORM (**HIGH**)
Prior system: Prisma 5, 33 migrations. OpenWA: TypeORM. Running both in one process
is possible but a maintenance trap (two migration histories, two connection pools,
two type systems over one database). **Decision: adopt TypeORM**, matching OpenWA
(spec §3 lists TypeORM in the audit scope, and §211 forbids unnecessary rewrites of
OpenWA). Consequence: the prior schema is a *design reference*, not a migration
source. It is a good one — 33 migrations of real production learning — and the new
schema should mirror its constraint discipline (partial unique indexes, unique
idempotency keys, soft-delete over hard-delete, singleton settings rows).

### 5.3 No Redis anywhere today (**MEDIUM**)
The spec mandates Redis for queues, locks, rate limits, cache, and job progress
(§184–186). OpenWA treats it as an optional cache profile; the prior system has none.
Redis becomes a **required** service, and `docker-compose` must not leave it behind
an opt-in profile.

### 5.4 Single-worker assumptions (**HIGH**)
The prior system assumes exactly one worker: "lost the race (shouldn't happen with a
single worker, but defensive)"; strictly serial `WorkerCommand` polling; sequential
account connect because `@open-wa` `chdir`s the process. Spec §119/§185/§186 require
multi-worker safety. Mitigation: the gateway owns sessions (removing the `chdir`
constraint entirely), and every automated send acquires a **Redis conversation lock**
before re-validating state and dispatching (§193).

### 5.5 Domain model is WhatsApp-shaped (**MEDIUM**)
`WhatsAppGroup`, `whatsappMessageId`, `whatsappGroupId`, and `chatId` are woven
through the prior schema and every query. Spec §53/§139 require channel-neutral core
entities with WhatsApp as one adapter. Building on the prior schema would bake in the
exact coupling the spec forbids. In a fresh schema this costs nothing — it only costs
if the prior schema is inherited.

### 5.6 Webhook ingress is not a durable event bus (**MEDIUM**)
OpenWA webhooks are fire-and-forget HTTP with HMAC. No ordering, no replay, no
offsets. Mitigations, all required:
- The webhook controller does **persist + enqueue + 200** and nothing else (§6).
- Idempotency on a `(channel_account_id, external_message_id)` unique index (§59).
- Per-conversation FIFO so message 2 cannot be processed before message 1 (§187).
- A reconciliation job that pulls recent messages from the gateway REST API to detect
  webhook gaps (not spec-mandated; required by scale).

### 5.7 Two authentication systems (**MEDIUM**)
OpenWA has API-key auth + RBAC for the gateway; Support CRM needs human sessions plus
its own RBAC. These must not be merged. Boundary: Support CRM authenticates humans and
issues its **own** scoped API keys for external AI clients (§93, §177); OpenWA's API
key is a single internal credential held only by the Support CRM channel adapter and
never exposed to CRM users.

### 5.8 Duplicate-send risk during any transition (**HIGH, operational**)
The prior system is **live in production on a VPS** against real customer WhatsApp
groups. If Support CRM is ever connected to the same WhatsApp account while the old
worker is running, customers receive two automated replies. Non-negotiable rule for
every phase: **the two systems never hold the same WhatsApp account at the same time.**
Cutover is account-by-account, with the old worker stopped for that account first.

### 5.9 Capability drift (**LOW–MEDIUM**)
Spec §174/§176 require that unsupported channel features be detected, disabled, and
explained rather than faked. The gateway's capability set differs by engine
(`whatsapp-web.js` vs `baileys`) and by account permission. The `ChannelAdapter` must
expose a runtime capability descriptor, and the UI must gate on it.

### 5.10 Message volume growth (**LOW at first, HIGH later**)
Spec §119 anticipates millions of messages. The prior system has no archival or
partitioning. Spec §183 explicitly warns against premature partitioning. Plan: correct
indexes from day one (§114), a retention/archival policy in Phase 11, and partitioning
only on demonstrated need.

### 5.11 Scope realism (**HIGH, project management**)
This specification is 217 sections and 45 acceptance criteria describing a CRM +
knowledge base + automation engine + AI platform + analytics + learning loop. It is
not deliverable in one pass. The phased plan in `IMPLEMENTATION_PLAN.md` is sequenced
so that **each phase ends with a system that runs**, never with a half-migrated one.

---

## 6. Proposed Support CRM architecture

### 6.1 Topology (spec §120, §150)

```
                    ┌──────────────────────────┐
  WhatsApp  ◄─────► │  OpenWA gateway          │  NestJS, TypeORM, engine/
                    │  sessions · REST · hooks │  React transport dashboard
                    └───────────┬──────────────┘
                     webhook (HMAC)  │  REST (send, groups, contacts)
                                ▼    │
                    ┌──────────────────────────┐
                    │  support-crm (NestJS)    │  API /api/v1 · OpenAPI · WS/SSE
                    │  channel · crm · kb ·    │  Operator UI (Support Inbox)
                    │  automation · ai ·       │
                    │  decision · escalation   │
                    └───┬──────────────────┬───┘
                        │                  │
                 ┌──────▼─────┐     ┌──────▼──────┐
                 │ PostgreSQL │     │    Redis    │
                 └──────▲─────┘     └──────▲──────┘
                        │                  │
                    ┌───┴──────────────────┴───┐
                    │  support-crm-worker      │  BullMQ consumers
                    └──────────────────────────┘         + MinIO (optional)
```

Modular monolith (§120). `support-crm` and `support-crm-worker` are the **same
codebase in two run modes** — the API process does not consume queues; the worker
process does not serve HTTP except `/health`.

### 6.2 Domain modules (spec §158 — no god module)

```
src/modules/
  auth/            authentication, sessions, brute-force protection      §178
  rbac/            roles, permissions, guards                            §108
  audit/           audit_logs, before/after diffing                      §107
  settings/        global settings, feature flags, emergency stop        §37, §124
  channel/         ChannelAdapter contract, capabilities, registry       §53, §176
    whatsapp/      OpenWA adapter — ONLY module allowed to call OpenWA   §54
  ingestion/       webhook controller, validation, idempotency, enqueue  §55, §59
  crm/
    customers/     Customer, CustomerContact                             §64
    groups/        Group, GroupMember, modes, monitoring, onboarding     §43-46, §98
    conversations/ Conversation, participants, state machine, history    §7-8, §65
    messages/      Message, attachments, delivery status                 §66, §195
    team/          TeamMember, availability, assignment                  §67
    activity/      SupportActivity, sessions, performance                §68-69
    tags/          Tag, entity_tags                                      §63
  knowledge/       articles, documents, chunks, embeddings, profiles     §70-75
  automation/
    engine/        PORTED pure evaluator + regexSafety                   §76-79
    rules/         CRUD, versioning, approval, schedules, cooldown       §80-82
    simulator/     dry-run using the same evaluator                      §83
    analytics/     trigger/success/health scoring                        §84
  ai/
    providers/     AIProvider abstraction + registry + fallback chain    §21, §123
    memory/        short/medium/long-term, summarization                 §25-26
    retrieval/     RAG selection over knowledge                          §14
    decision/      AI Decision Engine, structured output, confidence     §16-19
    copilot/       admin assistant, read tools auto / write tools confirm §89-91, §137
  decision/        ** Message Decision Engine ** + decision_logs         §5-6, §112, §159
  policy/          centralized policy evaluation                         §162
  outbound/        outgoing queue, validation, rate limits, dedupe       §56-58, §194
  escalation/      escalation, notification, takeover, release           §28-36
  broadcast/       audience, preview, batching, cancellation             §94-97
  jobs/            Job Center — jobs, job_items, progress, retry         §49-51
  reports/         reporting + exports                                   §104-106
  realtime/        WebSocket/SSE gateway                                 §102, §118
  health/          component health aggregation                          §130
```

**Two hard boundaries, enforced by lint rule and code review:**
1. Only `channel/whatsapp/` may import the OpenWA client (§54, §157).
2. `decision/` decides; `outbound/` sends. The Decision Engine has no send capability
   in its type signature (§161).

### 6.3 Database changes

A new schema — TypeORM entities plus migrations — living in the OpenWA database under
a dedicated `support_crm` Postgres **schema**, so gateway tables and CRM tables never
collide and can be backed up and migrated independently.

The entity set is spec §111 in full. Beyond the prior system, these are net-new:
`roles`, `role_permissions`, `user_roles`, `channels`, `channel_accounts`,
`channel_contacts`, `customers`, `customer_contacts`, `conversations`,
`conversation_participants`, `conversation_state_history`, `message_attachments`,
`message_reactions`, `support_profiles`, `knowledge_profiles`, `knowledge_documents`,
`knowledge_chunks`, `automation_conditions`, `automation_actions`,
`automation_versions`, `automation_candidates`, `ai_conversations`, `ai_messages`,
`ai_feedback`, `ai_candidates`, `assignments`, `tags`, `entity_tags`, `jobs`,
`job_items`, `audit_logs`, `custom_fields`, and — mandatory per §112 —
**`decision_logs`**.

Indexes are spec §114 verbatim, plus:
- `UNIQUE (channel_account_id, external_message_id)` — the idempotency constraint (§59)
- `UNIQUE (idempotency_key)` on `outbound_messages` — duplicate-send guard (§117)
- Postgres full-text GIN on message body and knowledge content (§115)
- `pgvector` on `knowledge_chunks.embedding` (§115: vector retrieval, no Elasticsearch)

Conventions carried over from the prior system deliberately: singleton settings rows,
partial unique indexes where the DSL cannot express the constraint, soft-deactivation
over deletion so history keeps valid foreign keys, and a real seeded permissions table
rather than a string enum.

### 6.4 Event flow (spec §55, §118)

```
WhatsApp → OpenWA → webhook POST /api/v1/channels/whatsapp/webhook
  ├─ verify HMAC                                          §109
  ├─ validate payload shape                               §55
  ├─ resolve channel_account
  ├─ INSERT message  (unique violation ⇒ duplicate ⇒ 200)  §59
  ├─ enqueue  message.incoming  (key = conversation_id)    §187 ordering
  └─ 200 OK                                    ← nothing heavy happens here §6

worker: message.incoming
  ├─ optional burst debounce window                        §188
  ├─ acquire Redis conversation lock                       §186, §193
  ├─ load conversation state + resolved policy             §7, §45, §162
  ├─ Decision Engine
  │     validation → state → safety/policy → automation
  │     → knowledge → AI → escalation
  ├─ WRITE decision_log                        ← mandatory §112
  ├─ emit outgoing ACTION (never a send)                   §160-161
  └─ release lock

outbound worker: enqueued action
  ├─ pre-send re-validation (state, AI/automation flags,
  │   emergency stop, rate limit, duplicate, permission,
  │   channel capability)                                  §194
  ├─ POST OpenWA /messages
  └─ record status  queued|sent|delivered|read|failed      §195

realtime: every state change → WebSocket/SSE to the Inbox   §102
```

### 6.5 Queue architecture (spec §49, §56, §121, §184)

BullMQ on Redis. Queues:

| Queue | Concurrency | Notes |
|---|---|---|
| `message.incoming` | high | keyed per conversation for FIFO ordering |
| `message.outgoing` | rate-limited | per session / group / destination (§57) |
| `ai.request` | bounded | provider timeout, backoff, fallback provider (§123) |
| `knowledge.index` | low | parse → clean → chunk → embed → index (§72) |
| `bulk.group_update` | batched | Job Center–backed (§47, §49) |
| `broadcast.send` | rate-limited | batching, cancellation (§95, §197) |
| `member.operation` | low | capability-gated (§96) |
| `report.generate` | low | exports |
| `analytics.candidate` | scheduled | automation/knowledge candidates (§85, §135) |
| `maintenance.cleanup` | scheduled | retention, archival (§127) |

Redis is also used for distributed locks (§185), conversation locks (§186),
rate-limit counters (§57), job progress (§50), and resolved-policy caching. **Never as
a source of truth for business data** (§184).

### 6.6 Security posture (spec §109, §201)

Argon2id/scrypt password hashing; server-side revocable sessions (the prior system's
`UserSession` design — the cookie carries a high-entropy secret, only its SHA-256 is
stored); brute-force lockout; RBAC guards on every route; scoped, hashed, revocable,
rate-limited external API keys; envelope-encrypted provider secrets; HMAC webhook
verification; input validation via DTOs; upload validation (MIME + extension + size +
filename + non-executable storage path); structured logs that never contain secrets;
audit rows with before/after for every configuration change; a least-privilege DB
role; no secrets in git.

---

## 7. Foundation decision

### Track A — fork OpenWA, build Support CRM on top *(recommended)*

Clone `rmyndharis/OpenWA` into this repository, keep its gateway and dashboard intact,
add `support-crm` and `support-crm-worker` as NestJS modules in the same monorepo, and
port domain logic from Support Message Automation.

- Satisfies the spec exactly as written (§3, §52–54, §211).
- Gains a maintained, purpose-built WhatsApp gateway: multi-session, engine choice,
  HMAC webhooks, MCP, OpenAPI, S3/MinIO, non-root Docker, ARM + AMD images.
- Removes the `@open-wa` Puppeteer constraints (process-global `chdir`, sequential
  connects) that cap the prior system at one worker.
- Clean channel-neutral schema — future channels (§139) cost nothing later.
- **Cost:** the prior system's Prisma schema and Next.js UI become references, not
  inheritance. Roughly 30–40% of its accumulated logic ports (engine, semantics,
  formatting, conventions); the rest is rebuilt on the new foundation.
- **Cost:** the live production system keeps running unchanged until cutover, so the
  two must be operated side by side for the duration.

### Track B — evolve Support Message Automation in place

Add the missing CRM layer to the existing Next.js/Prisma system.

- Fastest to first value; nothing in production is disturbed.
- **Contradicts the spec's stated foundation** (§3) and inherits every conflict at
  §5.4 (single worker), §5.5 (WhatsApp-shaped domain), and the `@open-wa` library
  ceiling.
- Bolting a channel abstraction, conversation state machine, decision engine, and RBAC
  onto a 60-model schema built without them is, in practice, a rewrite that merely
  looks incremental.

**Recommendation: Track A.** It is what the spec asks for, and the architectural debt
Track B inherits is precisely the debt this specification exists to avoid.

---

## 8. Verification against the specification

| Spec requirement | Where satisfied |
|---|---|
| §3 audit OpenWA, classify reuse/extend/isolate/replace | §1, §3 |
| §5 centralized decision, no module decides alone | §6.2 `decision/`, §6.4 |
| §6 nothing heavy in the webhook request | §6.4 |
| §53–54 channel abstraction, business logic never calls OpenWA | §6.2 boundary 1 |
| §59 idempotency | §5.6, §6.3 unique index |
| §112 decision_logs mandatory | §6.3, §6.4 |
| §120 modular monolith, no microservices | §6.1 |
| §157–158 no god module, no direct OpenWA access | §6.2 |
| §161 decision engine must not send | §6.2 boundary 2 |
| §184 Redis never a source of truth | §6.5 |
| §207 audit contents (19 required items) | §1–§6 |
| §211–212 no unnecessary OpenWA rewrite | §3.1, §3.4 (nothing in OpenWA replaced) |

---

## 9. Open decision for the owner

One genuine business decision cannot be inferred safely from the spec, and Phase 1
should not start before it is answered:

> **Is Support CRM a new system built on the OpenWA gateway (Track A), or the
> continuation of the live `Support Message Automation` deployment (Track B)?**

The audit recommends **Track A**. What the owner is confirming is the trade-off: a
clean, spec-compliant, multi-worker, multi-channel foundation, in exchange for
rebuilding — not migrating — the existing dashboard and schema, while the current
production system keeps serving customers untouched until an account-by-account
cutover (§5.8).

Everything else in `IMPLEMENTATION_PLAN.md` is written for Track A and is a reasonable
technical decision made autonomously per spec §216.
