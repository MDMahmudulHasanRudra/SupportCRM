# Support CRM — Implementation Plan

> Deliverable for `PROJECT_SPEC.md` §208.
> Companion document: `docs/ARCHITECTURE_AUDIT.md`.
> Assumes **Track A** (fork OpenWA gateway, build Support CRM on top) — see
> `ARCHITECTURE_AUDIT.md` §7 and §9. If the owner selects Track B, this plan is
> rewritten before Phase 1.
> Status: **Plan only. No implementation has begun.**

---

## 0. How this plan is sequenced

Three rules govern the ordering, and they override convenience:

1. **Every phase ends with a system that runs.** No phase leaves the repository in
   a half-migrated state. Spec §156 ("do not continue while critical tests are
   broken") is enforced as a phase exit gate, not a suggestion.
2. **Safety infrastructure lands before the thing it protects.** The decision log,
   conversation lock, kill switch, and audit trail exist *before* AI is allowed to
   send a single message. Spec §5, §37, §112, §193.
3. **The live production system is never disturbed.** `../Support Message Automation`
   keeps serving customers throughout. The two systems must never hold the same
   WhatsApp account simultaneously (`ARCHITECTURE_AUDIT.md` §5.8). Cutover is
   account-by-account and happens in Phase 11, not before.

Per spec §156, each phase opens with: inspect code → identify reusable
functionality → design → implement → migrate → test → lint → typecheck → build →
document.

### Repository layout after Phase 1

```
Support CRM/
├── PROJECT_SPEC.md              canonical spec — never edited by implementation
├── docs/                        ARCHITECTURE_AUDIT.md, IMPLEMENTATION_PLAN.md, + §154 set
├── gateway/                     fork of rmyndharis/OpenWA — upstream-trackable
├── apps/
│   ├── api/                     support-crm NestJS API process
│   ├── worker/                  support-crm-worker (same codebase, worker run mode)
│   └── admin/                   operator UI (Support Inbox, dashboards)
├── packages/
│   ├── domain/                  entities, DTOs, enums — channel-neutral
│   ├── automation-engine/       PORTED pure evaluator + regexSafety + tests
│   └── shared/                  permissions catalogue, common types
├── docker-compose.yml           dev
├── docker-compose.prod.yml      prod
└── .env.example
```

`gateway/` is kept as an isolable fork so upstream OpenWA changes can be merged
(spec §211–212). Modifications inside it are documented, isolated, and tested.

### Global definition of done (applies to every phase)

A phase is complete only when all of the following hold. Spec §209 forbids
claiming completion on a stub, a mock, a TODO, or a UI-only surface.

- Real database, real queue, real integration path — no mock production logic (§210)
- Migrations written, applied, and reversible where practical (§204)
- Unit + integration tests for the phase's critical paths, passing (§140)
- `lint`, `typecheck`, `build` all clean; strict TypeScript, no `any` (§157)
- RBAC enforced on every new route (§108)
- Audit entries written for every new configuration-changing action (§107)
- OpenAPI regenerated (§116)
- The phase's `docs/` page updated (§154)

---

## PHASE 0 — Repository & OpenWA Audit ✅ COMPLETE

**Objectives.** Map the existing architecture, identify reuse, identify conflicts,
propose target architecture, database, events, queues; produce the two deliverables.

**Delivered.** `docs/ARCHITECTURE_AUDIT.md`, `docs/IMPLEMENTATION_PLAN.md`.

**Findings that shape everything downstream.**
- Working directory contains no code and no vendored OpenWA.
- The spec's OpenWA (NestJS gateway) and the prior system's `@open-wa/wa-automate`
  (Puppeteer library) are unrelated — no WhatsApp code is portable.
- `../Support Message Automation` supplies a production-tested rule engine,
  idempotency discipline, escalation semantics, and support-activity semantics.
- Absent everywhere and mandatory: Conversation entity + state machine, Customer
  entity, centralized Decision Engine, `decision_logs`, channel abstraction,
  Redis, RAG/embeddings, audit log, versioned REST API, real-time transport.

**Completion criteria.** Both documents exist; the Track A/B decision is put to the
owner (`ARCHITECTURE_AUDIT.md` §9). ✅ — pending the owner's answer.

---

## PHASE 1 — Foundation

**Objectives (spec §155/Phase 1).** Stand up the repository, database, migrations,
authentication, RBAC, audit, channel abstraction, configuration, job architecture,
and event architecture. No WhatsApp traffic yet.

**Modules.** `auth`, `rbac`, `audit`, `settings`, `channel` (contract only), `jobs`,
`realtime` (transport only), `health`.

**Files / modules affected.** All new. `gateway/` cloned and pinned to an upstream
tag, otherwise untouched this phase.

**Database migrations.**
- `users`, `user_sessions`, `security_settings`
- `roles`, `permissions`, `role_permissions`, `user_roles` (§108) — permissions
  seeded from a single source-of-truth catalogue, a real table with FKs, not a
  string enum (pattern carried from the prior system)
- `audit_logs` — actor, action, resource, resource_id, before, after, timestamp,
  IP, metadata (§107)
- `system_settings`, feature flags (§124)
- `channels`, `channel_accounts` + capability descriptor (§53, §176)
- `jobs`, `job_items` (§50–51)
- Postgres schema `support_crm`; extensions `pg_trgm`, `pgvector` provisioned now
  so Phase 4 needs no privileged migration later

**APIs.** `/api/v1/auth` (login, logout, refresh, me), `/api/v1/users`,
`/api/v1/settings`, `/api/v1/audit`, `/api/v1/jobs`, `/health`. OpenAPI generated
from the first endpoint onward.

**UI.** Login, user management, role/permission management, settings shell, Job
Center skeleton, audit log viewer.

**Tests.** Auth flows; session revocation; brute-force lockout; RBAC allow/deny per
role (§141 "permission denial"); audit before/after diffing; job enqueue → worker
consume → progress → retry → failure; Redis lock acquire/release/expiry; migration
up and down.

**Dependencies.** Owner's Track A/B confirmation. Docker, Postgres 16, Redis 7.

**Completion criteria.**
1. `docker compose up` brings up postgres, redis, gateway, api, worker, all healthy.
2. A seeded admin can log in; a second role is genuinely denied a protected route.
3. A job runs end-to-end through Redis with visible progress and a working retry.
4. Every config change in this phase produces an `audit_logs` row with before/after.
5. `/api/docs` renders the current API.

---

## PHASE 2 — WhatsApp

**Objectives.** Connect the gateway, ingest messages safely, persist them, and show
them. This is the first phase that touches a real WhatsApp account — on a **test
number only**.

**Modules.** `channel/whatsapp` (the OpenWA adapter — the *only* module permitted to
import the OpenWA client, §54), `ingestion`, `crm/messages`, `crm/groups` (sync
only), `outbound` (basic send), `realtime` (message events).

**Files / modules affected.** New `channel/whatsapp/*`; gateway configured for
webhook delivery + HMAC secret. Gateway source untouched — if a hook is needed, it
uses `src/core/hooks/`, documented per §211.

**Database migrations.**
- `channel_contacts`, `groups`, `group_members`
- `messages` + `message_attachments` + `message_reactions` (§66)
- `outbound_messages` (§56) — priority, source, retry_count, scheduled_at,
  idempotency_key
- `processing_checkpoints`
- Indexes: `UNIQUE (channel_account_id, external_message_id)` (§59),
  `messages(conversation_id, timestamp)`, `messages(external_id)` (§114),
  `UNIQUE (idempotency_key)` on `outbound_messages` (§117)

**APIs.** `POST /api/v1/channels/whatsapp/webhook` (HMAC-verified; persist + enqueue
+ 200 only, §6). `/api/v1/channels/sessions` (create, QR, connect, disconnect,
health, §52). `/api/v1/messages` (list, search). `/api/v1/groups` (list, sync).

**UI.** Session management with live QR and status; group list with sync; a
read-only message stream. Every control gated on the adapter's capability
descriptor (§176) — unsupported actions are disabled and explained, never faked
(§174).

**Tests (§141).** Duplicate webhook delivers exactly one row and one action;
malformed/unsigned webhook rejected; webhook returns fast under load with no
synchronous processing; session disconnect and reconnect; outbound retry with
backoff; rate limit defers rather than fails; out-of-order delivery preserves
per-conversation ordering (§187).

**Dependencies.** Phase 1. A dedicated **test WhatsApp number** — never the
production account (`ARCHITECTURE_AUDIT.md` §5.8).

**Completion criteria (maps to §206 items 1–8).** QR scan connects; incoming
messages persist; duplicates are provably prevented; a manually triggered outbound
message is delivered and its status recorded; groups sync; the session survives a
container recreation without re-scanning.

---

## PHASE 3 — CRM

**Objectives.** Customers, team, conversations, the conversation **state machine**,
assignments, support activities, tags, and the Support Inbox.

**Modules.** `crm/customers`, `crm/conversations`, `crm/team`, `crm/activity`,
`crm/tags`.

**Files / modules affected.** `ingestion` extended to resolve/create a conversation
per incoming message; `realtime` extended with conversation events.

**Database migrations.**
- `customers`, `customer_contacts`, `custom_fields` (§64)
- `conversations`, `conversation_participants` (§65)
- `conversation_state_history` (§111) — every transition, with actor and reason
- `team_members`, `assignments` (§67)
- `support_activities` (§68) with `UNIQUE (message_id)` — the prior system's
  insert-and-catch idempotency pattern
- `tags`, `entity_tags` (§63)
- Indexes per §114: `conversations(group_id | customer_id | status)`,
  `support_activities(team_member_id, date)`

**Conversation state machine (§7–8).** `AUTOMATION_ACTIVE`, `AI_ACTIVE`,
`HUMAN_ACTIVE`, `HUMAN_REQUIRED`, `PAUSED`, `WAITING_CUSTOMER`, `RESOLVED`.
Implemented as an explicit, independently testable transition table — legal
transitions, who may trigger each, and what each state permits. Every transition
writes `conversation_state_history`. **This is the gate every later engine checks**,
so it lands before automation and long before AI.

**APIs.** `/api/v1/customers`, `/api/v1/conversations` (list, filter, get, state
transitions, assign, tag, note, pin, resolve, reopen), `/api/v1/team`.

**UI.** The Support Inbox (§60): conversation list left, thread centre, context
right; filters (all/unread/open/assigned/AI/human/escalated/pinned/resolved/
waiting); search by customer/group/phone/message/tag; conversation actions (§61);
CRM-level pinning independent of WhatsApp's own pin (§62); a timeline with visual
source indicators (§168); server-side and cursor pagination with virtualized lists
(§103).

**Tests.** State transition table — every legal and illegal transition; human reply
detection creates exactly one support activity; assignment and tagging; inbox filter
and pagination correctness; real-time updates arrive without polling.

**Dependencies.** Phase 2.

**Completion criteria (§206 items 6–11).** A human can reply to a real customer from
the Inbox and the message is delivered; conversation state is explicit, visible, and
auditable; support activity is recorded for team-member messages; performance is
acceptable with a seeded 3,000-group / large-message-history dataset.

---

## PHASE 4 — Knowledge

**Objectives.** Articles, documents, ingestion pipeline, search, versioning,
approval, knowledge profiles.

**Modules.** `knowledge/*`, plus `knowledge.index` queue consumers.

**Database migrations.** `knowledge_articles`, `knowledge_documents`,
`knowledge_chunks` (with a `pgvector` embedding column), `knowledge_versions`,
`knowledge_profiles`, `knowledge_candidates` (§75). Categories per §71 seeded, with
custom categories allowed. Full-text GIN index; vector index on chunks (§115 — no
Elasticsearch).

**Pipeline (§72).** upload → parse (PDF/TXT/DOCX/Markdown) → clean → chunk → tag →
embed → index → publish. Runs entirely on the `knowledge.index` queue; upload
validation per §126/§179 (MIME, extension, size, filename, non-executable storage
path). Storage: local in dev, S3/MinIO in production.

**Retrieval (§14, §74).** Selective, never "send the whole KB": exact keyword →
full-text → semantic/vector, with priority Group → Customer → Product → Global,
configurable. Returns bounded, ranked chunks with source IDs so `decision_logs` and
AI audit rows can cite them.

**Versioning & approval (§73, §198).** Draft / Review / Published / Archived, `v1..vN`,
publish / rollback / compare / archive. **Only Published knowledge is visible to
production AI** unless explicitly configured otherwise.

**APIs.** `/api/v1/knowledge` — articles, documents, upload, search, versions,
publish, rollback, profiles, candidates.

**UI.** Knowledge browser, editor, upload with progress, version diff/rollback,
category and profile management, candidate review queue.

**Tests.** Each document type parses and chunks correctly; oversized/wrong-MIME/
disguised-extension uploads are rejected; embedding job retries on provider failure;
retrieval returns relevant chunks and respects the priority order; unpublished
knowledge is never returned to a production retrieval call.

**Dependencies.** Phase 1 (`pgvector`), Phase 6's provider abstraction is needed for
embeddings — so the `AIProvider` interface plus one embedding provider is pulled
forward into this phase.

**Completion criteria (§206 items 12–13).** A real PDF uploads, indexes, and is
retrievable by a natural-language query; versioning and rollback work; retrieval is
demonstrably bounded and cited.

---

## PHASE 5 — Automation + the Message Decision Engine

**Objectives.** The deterministic rule engine, and the centralized **Message
Decision Engine** it plugs into. Spec §5 forbids any module deciding independently —
so the Decision Engine lands here, with automation as its first real stage, and AI
plugs in later as another stage.

**Modules.** `automation/engine` (ported), `automation/rules`,
`automation/simulator`, `automation/analytics`, `decision`, `policy`.

**Port (`ARCHITECTURE_AUDIT.md` §4.1).** `packages/engine` from the prior system →
`packages/automation-engine`, near-verbatim, keeping `regexSafety` (save-time
validation + runtime timeout, a real ReDoS control) and its existing tests. Extended
with the §77 conditions it lacks and a richer trace that becomes the `decision_logs`
payload.

**Database migrations.** `automation_rules`, `automation_conditions`,
`automation_actions`, `automation_versions`, `automation_logs`,
`support_profiles` (§42), and — mandatory (§112) — **`decision_logs`**: message,
conversation, matched automation, knowledge retrieved, AI enabled, AI provider,
confidence, policy result, final decision, response source, escalation, timestamp.
Index `decision_logs(conversation_id, timestamp)` (§114).

**Decision Engine (§6, §159–161).** One pipeline, in order: validation →
idempotency → conversation state → safety/policy → deterministic automation →
knowledge/intent → *(AI stage — stubbed to NO_ACTION until Phase 6)* → human
escalation → outgoing action. Produces an **action** (`AUTOMATION_REPLY`,
`AI_REPLY`, `ESCALATE`, `NO_ACTION`, `WAIT`, `HUMAN_REQUIRED`, `PAUSE`, `RESOLVE`)
and never sends. The engine's type signature has no send capability — this is the
structural enforcement of §161, not a convention. It is independently testable with
no queue, no channel, and no database side effects.

**Policy engine (§162).** Centralized resolution of AI / automation / messaging /
broadcast / escalation / rate-limit / restricted-action policy across the
Global → Support Profile → Group → Conversation hierarchy (§45), cached in Redis
and invalidated on write.

**Group modes (§43–46).** `MANUAL`, `AUTOMATION_FIRST`, `AI_FIRST`, `HYBRID`
(default), `HUMAN_ONLY`, `PAUSED`; monitoring `MONITORED`/`UNMONITORED`/`PAUSED`.

**Also in scope.** Schedules with timezone and business hours (§80); cooldown and
duplicate-message protection (§81); rule versioning and approval Draft/Review/
Published/Paused/Archived with only Published executing (§82, §199); the Simulator,
which uses the *same* evaluator and cannot publish or send (§83); automation health
scoring (§84).

**APIs.** `/api/v1/automation` (rules CRUD, versions, publish, rollback, simulate,
health), `/api/v1/decisions` (the Decision Inspector, §113 — never exposing secrets).

**UI.** Rule builder; simulator; version diff; health dashboard; the **Decision
Inspector**, which must be able to answer §169–172: why did the system send this,
why did AI not respond, why did AI escalate, why did automation not run.

**Tests (§142–143).** "Hello" → greeting automation, AI provably not called;
"Software slow" → troubleshooting + video, AI not called; priority resolution and
stop-after-match; cooldown suppresses a repeat; schedule boundaries; a `HUMAN_ACTIVE`
conversation suppresses automation (§191); regex timeout does not hang the worker;
every decision writes exactly one `decision_log`.

**Dependencies.** Phases 1–4.

**Completion criteria (§206 items 14–16).** Deterministic automation answers real
messages; the Decision Inspector explains every decision from real stored data; the
simulator's output matches production for the same input.

---

## PHASE 6 — AI

**Objectives.** Provider abstraction, configuration, RAG, memory, the AI Decision
Engine, confidence policy — plugged into the Phase 5 pipeline as one more stage.

**Modules.** `ai/providers`, `ai/memory`, `ai/retrieval`, `ai/decision`.

**Database migrations.** `ai_providers`, `ai_configurations`, `ai_conversations`,
`ai_messages`, `ai_feedback`. Index `ai_messages(conversation_id)` (§114).

**Provider abstraction (§21).** `AIProvider` with chat, embeddings, classification,
summarization, and structured output. Implementations: OpenAI, Anthropic, Gemini,
OpenRouter, any OpenAI-compatible endpoint, custom base URL. Per-job model slots
(the prior system's design, kept). Secrets envelope-encrypted (§22, §177).
Failure handling per §123: timeout → async retry → exponential backoff → fallback
provider → automation fallback → human escalation. Never hammer a failed provider —
a circuit breaker in Redis.

**Memory (§25–26).** Short-term (recent messages), medium-term (recent support
history + rolling conversation summary), long-term (approved customer facts,
historical issue summaries). Never the full history on any request. Summaries carry
issue, attempts, current state, unresolved items, human decisions, knowledge used,
escalation status.

**AI Decision Engine (§16–19).** Returns **structured** output — intent, answer,
confidence, knowledgeUsed, knowledgeSources, needsHuman, reason, suggestedAction —
via the provider's native structured-output/tool mode, not regex parsing over free
text. The final decision is *not* the model's confidence alone (§17): it combines
confidence, knowledge relevance and availability, policy, conversation context,
intent certainty, previous attempts, explicit human requests, sensitive-operation
detection, and repetition/loop detection.

**Confidence policy (§18–19).** Admin-configurable thresholds (example defaults:
reply ≥ 0.80, clarify ≥ 0.60, below → escalate). **Never hardcoded**; Support
Profile and Group may override.

**Safety (§20, §164–165).** Restricted actions (production network config, data
deletion, billing, refunds, ownership changes, security-sensitive or destructive
operations) require human approval or explicit safe automation regardless of
confidence. Chain-of-thought is never exposed or stored — only confidence,
decision, knowledge IDs, a reason summary, and the policy result (§27, §165).

**Personality & instructions (§23–24).** Configurable tone, language (Bangla /
English / mixed), length, emoji level, technical level; system instructions layered
Global → Support Profile → Group, more specific overriding broader.

**APIs.** `/api/v1/ai` — providers, configuration, test, `POST /api/v1/ai/chat`
(the gateway API of §92, scoped-key authenticated per §93).

**UI.** AI configuration; per-conversation AI controls (§38); AI decision detail on
each message.

**Tests (§144, §141).** A contextual message with no deterministic match retrieves
knowledge and gets a grounded AI reply; AI timeout does not loop and escalates
cleanly; provider failure falls back and then escalates (§148); low confidence
escalates rather than guessing; missing knowledge escalates; the AI's structured
output is validated and a malformed response is treated as a failure, not parsed
optimistically.

**Dependencies.** Phases 4 and 5.

**Completion criteria (§206 items 17–20).** AI answers real messages using retrieved
knowledge, its confidence policy demonstrably governs the outcome, and every AI
decision is auditable in `decision_logs` + `ai_messages` without exposing secrets or
reasoning traces.

---

## PHASE 7 — Human Escalation & Safety

**Objectives.** Escalation, internal groups, executive notification, takeover,
release, AI pause, loop protection, and the kill switch.

**Modules.** `escalation/*`, plus safety controls in `settings` and `policy`.

**Database migrations.** `ai_escalations`, escalation configuration on
`support_profiles` and `groups`, escalation events with a unique constraint acting
as the **idempotent duplicate-notification guard** (the prior system's
`SupportEscalationEvent` pattern, carried over deliberately).

**Escalation triggers (§28).** Low confidence; missing knowledge; explicit customer
request for a human; repeated "still not working"; AI cannot understand; unsupported
technical issue; sensitive decision; max AI replies reached; loop detected; provider
failure.

**Escalation flow (§29).** Create record → state to `HUMAN_REQUIRED` → stop AI →
stop conflicting automation → notify internal group → notify executives → dashboard
notification → record reason → preserve context → wait for takeover.

**Configuration (§30, §33–34).** Internal escalation group, primary and secondary
executives, priority, notify-internal-group, notify-executives, customer
notification (§32, configurable), max AI attempts, max AI replies, confidence
threshold — resolved through the Global → Support Profile → Group → Conversation
hierarchy.

**Takeover & release (§35–36).** `TAKE OVER` → `HUMAN_ACTIVE`, AI stops immediately,
the UI shows it unmistakably. `RELEASE TO AI` → `AI_ACTIVE`, AI resumes under policy.

**Loop, repetition & race protection (§40–41, §186, §190–193).** Max AI replies; max
consecutive AI replies; cooldown; duplicate and near-duplicate response detection;
conversation timeout; escalation score with a threshold. A **Redis conversation
lock** is acquired before any automated send, state is re-validated inside the lock,
and only then is the message dispatched. Human messages always outrank AI (§190);
a recent human reply suppresses AI and conflicting automation (§191). The system
must never send duplicate, contradictory, simultaneous AI + automation, or
post-takeover stale replies (§192).

**Human request detection (§39).** Bangla and English phrasings ("human চাই",
"একজন support agent দেন", "মানুষের সাথে কথা বলতে চাই"). AI must not argue with the
customer.

**Kill switch (§37).** Pause All AI; Pause All Automation; Stop Automated Outgoing
Messages; Disable Broadcast; Pause Bulk Operations. Confirmation required; every
action audited; pending automated outbound rows cancelled, not silently drained.

**Tests (§145, §149, §141).** The full E2E 4 scenario — MikroTik unreachable →
automation → "still not working" → AI attempts → low confidence → `HUMAN_REQUIRED`
→ internal group and executives notified → AI stopped → human takes over. Emergency
stop halts everything and resumes safely. Two concurrent workers cannot both reply
to one conversation. A duplicate escalation notification is impossible.

**Dependencies.** Phase 6.

**Completion criteria (§206 items 21–27).**

---

## PHASE 8 — Scale

**Objectives.** Bulk operations, the Job Center, broadcasts, member operations, group
onboarding, rate limiting — everything the spec requires to work at 3,000+ groups.

**Modules.** `broadcast`, `jobs` (completed), `crm/groups` onboarding, `outbound`
rate limiting (completed).

**Database migrations.** `broadcasts`, `broadcast_recipients`; job types per §51;
onboarding rules.

**Bulk operations (§47–49).** Every action in §47 across a filtered selection (§48).
**Never synchronous** — job → queue → worker → batch → progress → retry → result.
Job Center (§50) shows totals, completed, failed, progress, per-item errors, retry
of failed items only, cancel where possible, and logs.

**Broadcast (§94–97, §196–197).** Audience by group/customer/contact/tag/profile/
filter; text, image, video, document; audience preview with recipients, exclusions,
and estimate; test send; immediate or scheduled; cancellable while scheduled or
queued. Queue + batching + rate limiting + retry + failure tracking. Status tracked
as queued / sent / delivered (where supported) / failed / skipped — no invented
statuses (§195).

**Member management (§96–97).** Search, add, remove, promote, demote, view — each
capability-gated (§176), with per-item failures surfaced, never a fabricated success.

**Onboarding (§98–99, §134).** New group detected → create → map customer →
assign support/knowledge/automation profiles → configure AI, monitoring, escalation
→ notify → mark complete. Rules configurable (e.g. group name contains "VIP" →
Premium Support Profile).

**Rate limiting (§57, §175).** Per session, per group, per destination, per
broadcast, per automation, per AI, per API — all configurable, all Redis-backed.
Conservative defaults; account-safety controls per §175. Nothing here exists to
bypass WhatsApp platform restrictions.

**Tests (§146, §141).** 500 groups bulk-enable AI → job created, batched, progress
accurate, failures retried, result reported; broadcast failure and cancellation
paths; rate limit under concurrent workers; onboarding assigns the right profile.

**Dependencies.** Phase 7 (bulk operations must respect the kill switch).

**Completion criteria (§206 items 28–32, 44).**

---

## PHASE 9 — Analytics

**Objectives.** Dashboard, reports, exports, knowledge gaps.

**Modules.** `reports/*`, dashboard aggregation.

**Database migrations.** Reporting indexes and any materialized aggregates that
measurement — not speculation — proves necessary. Counts stay computed from raw
event tables at query time wherever they can (the prior system's approach, which
lets a changed counting setting reinterpret history retroactively).

**Dashboard (§100–101).** Totals, open, resolved, human, automation, AI, escalated,
response time, resolution time, AI success, automation success, active sessions,
monitored groups, failed jobs, AI failures, knowledge gaps, automation candidates;
top issues with trend.

**Reports (§104–106).** Support Activity, Team Performance, AI Performance,
Automation Performance, Escalations, Top Issues, Customer History, Group Activity,
Broadcast, System Health. Exports: CSV, Excel and PDF where useful.

**Team performance (§69).** Explicitly **not** message count: conversations handled,
groups supported, unique customers, resolved, escalated, first response time, average
resolution time, AI-assisted, automation-assisted, human-only, active days.

**Knowledge gaps (§75).** Repeated escalations for missing information generate
Knowledge Candidates for admin review.

**Tests.** Report figures reconcile against raw rows; exports handle large result
sets without loading everything into memory; date/timezone boundaries are correct.

**Dependencies.** Phases 3, 5–8 (they produce the data).

**Completion criteria (§206 item 36).**

---

## PHASE 10 — AI Copilot & the Learning Loop

**Objectives.** The admin assistant, automation candidates, knowledge assistance, and
the human-reviewed learning pipeline.

**Modules.** `ai/copilot`, `automation/candidates`, `knowledge/candidates`,
`ai/feedback`.

**Database migrations.** `automation_candidates`, `ai_candidates`, `ai_feedback`.

**Admin Copilot (§89–91, §137–138).** Answers questions from real data; can propose
automation and knowledge. **Read operations may execute automatically if permitted;
write and destructive operations require explicit confirmation** and never bypass
RBAC (§90). "Disable AI for 500 groups" must state the blast radius and wait for a
yes. The prior system's read-only-tools-only Copilot is the correct v1 shape; write
tools are added here *with* a confirmation flow and audit layer, never before.

**Learning pipeline (§85–88, §135–136).** conversation → analytics → pattern
detection → candidate → **human review** → approval → knowledge/automation →
production, with performance tracked afterwards. Never train production behaviour
from raw conversations. Human feedback (Correct / Wrong / Edit / Escalate) creates
learning candidates; an edit never silently modifies production knowledge.

**Auto-activation (§86).** AI must not automatically publish production automation.
High-confidence auto-activation exists as an advanced setting, **default OFF**.

**Tests (§147).** Historical conversations → repeated issue detected → candidate
created → admin edits and approves → automation published → performance tracked.
A write command without confirmation performs nothing. RBAC denial holds even when
the Copilot is the caller.

**Dependencies.** Phases 5, 6, 9.

**Completion criteria (§206 items 33–35).**

---

## PHASE 11 — Hardening & Production Cutover

**Objectives.** Security audit, performance, test coverage, Docker, backups,
observability, deployment documentation — and the migration off the live system.

**Security (§109, §177–179, §201).** Full pass: authentication, RBAC coverage on
every route, scoped API keys, session security, secret encryption, webhook
validation, rate limiting, audit completeness, secure headers, input validation,
upload validation, DB least privilege, no secrets in git. Verify no debug mode, no
default credentials, no plaintext secrets, no unrestricted CORS, no unprotected
admin API in production (§201).

**Performance (§119, §182–183).** Load test at 3,000+ groups with a large message
history. Track webhook latency, message processing latency, queue latency, AI
latency, DB query latency, outgoing latency, job duration. Add retention and
archival (§127, §183). Partition **only** if measurement demands it.

**Observability (§129–130, §180–181).** Structured logs carrying requestId, userId,
jobId, conversationId, messageId, session, automationId, aiRequestId — and never
API keys, passwords, tokens, or secrets. Health monitoring across WhatsApp,
database, Redis, workers, AI provider, storage, and queues, reported as
HEALTHY / WARNING / CRITICAL.

**Docker (§150–151).** `docker-compose.yml` (dev), `docker-compose.prod.yml` (prod):
support-crm, postgres, redis, worker, optional minio and reverse proxy; persistent
volumes, health checks, restart policies, environment configuration.

**Backup (§128).** Postgres, media, knowledge documents, configuration — with
documented and **verified** backup, restore, and verification procedures.

**Documentation (§154).** `README.md`, `docs/ARCHITECTURE.md`, `DATABASE.md`,
`API.md`, `DEPLOYMENT.md`, `BACKUP.md`, `AI.md`, `AUTOMATION.md`, `KNOWLEDGE.md`,
`SECURITY.md`, `ADMIN.md`, `TROUBLESHOOTING.md`.

**Production cutover.** The one step with real customer exposure, and the reason it
is last:
1. Deploy Support CRM alongside the existing system; **no shared WhatsApp account**.
2. Export the operational data worth keeping from the prior system's Postgres —
   groups, team members, automation rules, knowledge items, support activity
   history — and import it through Support CRM's validated import path (§133),
   with row-level errors surfaced. This is an ETL between two schemas, not a
   database migration.
3. Move **one** low-risk group first. Observe.
4. Move accounts one at a time. For each account: stop the old worker for that
   account, then connect Support CRM. **Never both at once** — two live systems on
   one account means duplicate replies to real customers
   (`ARCHITECTURE_AUDIT.md` §5.8).
5. Keep the old system deployed but idle as a rollback path until a full support
   cycle has passed cleanly.

**Deployment checklist (§205).** Environment configured; database migrated; Redis
healthy; worker healthy; OpenWA healthy; WhatsApp connected; AI configured; storage
configured; backups configured; health checks working; audit enabled; emergency
controls tested.

**Dependencies.** All prior phases.

**Completion criteria (§206 items 37–45).** All 45 acceptance criteria pass against
the real system — not a stub, a mock, or a UI.

---

## Cross-phase invariants

These hold from the first line of code and are checked at every phase gate:

| # | Invariant | Spec |
|---|---|---|
| 1 | Only `channel/whatsapp` imports the OpenWA client | §54, §157 |
| 2 | The Decision Engine decides; only `outbound` sends | §161 |
| 3 | Every automated decision writes exactly one `decision_log` | §112 |
| 4 | Every incoming message is idempotent on `(channel_account, external_id)` | §59 |
| 5 | Nothing heavy runs inside the webhook request | §6 |
| 6 | An automated send happens only inside a conversation lock, after re-validation | §193 |
| 7 | No bulk operation runs synchronously in an HTTP request | §49 |
| 8 | AI never overrides `HUMAN_ACTIVE` or the kill switch | §8, §37, §190 |
| 9 | Only Published knowledge and Published automation execute | §198–199 |
| 10 | No secret is ever logged, exposed by an API, or committed | §109, §129 |
| 11 | Thresholds and policies are configuration, never constants | §18 |
| 12 | An unsupported channel capability is disabled and explained, never faked | §174, §176 |
| 13 | No feature is reported complete while it is a stub, mock, or TODO | §209–210 |
| 14 | The two systems never hold the same WhatsApp account concurrently | audit §5.8 |

---

## Immediate next step

Phase 0 is complete. Per spec §216 and the instruction accompanying this task,
implementation pauses here.

Before Phase 1 begins, one answer is needed — `ARCHITECTURE_AUDIT.md` §9:

> **Track A** (recommended) — fork the OpenWA gateway and build Support CRM on it,
> porting proven logic from Support Message Automation; or
> **Track B** — evolve the existing production system in place.

On Track A, Phase 1 opens by cloning `rmyndharis/OpenWA` into `gateway/` and
performing the source-level verification of §1 of the audit — the one part of this
plan written from upstream documentation rather than from code in hand.
