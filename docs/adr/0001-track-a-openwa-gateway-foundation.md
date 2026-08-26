# ADR-0001 — Track A: OpenWA gateway as the WhatsApp foundation

- **Status:** Accepted (owner decision, 2026-08-23)
- **Supersedes:** the Track A/B open question in `docs/ARCHITECTURE_AUDIT.md` §9
- **Amends:** `docs/ARCHITECTURE_AUDIT.md` §1 (written from upstream docs; now verified against source)
- **Context documents:** `PROJECT_SPEC.md`, `docs/ARCHITECTURE_AUDIT.md`, `docs/IMPLEMENTATION_PLAN.md`

---

## 1. Decision

Support CRM is a **new system**. `rmyndharis/OpenWA` v0.23.1 is vendored at `gateway/` and used
as the **WhatsApp transport only**. Support CRM owns every business decision.

`../Support Message Automation` is **not** a foundation. It is a reference: proven algorithms,
security conventions, database constraints, and domain semantics are reused; its architecture
is not inherited.

### Why Track A

1. `PROJECT_SPEC.md` §3 names OpenWA as the integration foundation and §211 forbids duplicating
   WhatsApp functionality it already provides. Track A is the spec as written.
2. Source inspection (§2) found the gateway is materially more capable than its documentation
   suggested — BullMQ queues, Redis-backed Socket.IO, a durable webhook outbox with a reconciler,
   an engine capability matrix, multi-node session ownership with lease takeover, Prometheus
   metrics, MCP. Rebuilding any of that would be waste.
3. The prior system's ceiling is structural, not incidental: `@open-wa/wa-automate` calls
   process-global `process.chdir()` on connect, which forces one worker and sequential session
   starts. The gateway removes that constraint entirely — it owns sessions in its own process and
   already supports horizontal scaling.
4. A channel-neutral core costs nothing now and is the only way to add Messenger / Instagram /
   Facebook later without touching the decision engine (`PROJECT_SPEC.md` §139).

### Accepted cost

The prior system's Prisma schema and Next.js dashboard are references, not inheritance. Roughly
30–40% of its accumulated logic ports. Production cutover is account-by-account, manual, and
happens in Phase 11 — never automatically.

---

## 2. Source-level verification of OpenWA (corrects audit §1)

`gateway/` = `rmyndharis/OpenWA` **v0.23.1**, NestJS 11, TypeScript, 157 REST endpoints,
`openapi.json` checked in. Findings that differ from the documentation-based audit:

| Audit §1 said | Source shows |
|---|---|
| "No queues as a first-class concept" | **Wrong.** `bullmq`, `@nestjs/bullmq`, `@bull-board/*`, `ioredis` are direct dependencies; `src/modules/queue/` exists |
| "Redis optional cache only" | Also backs Socket.IO fan-out (`@socket.io/redis-adapter`) and the webhook delivery queue |
| "Webhooks are fire-and-forget, no replay" | **Wrong.** `webhook-outbox.service.ts` + `webhook-reconciler.service.ts` + `webhook-delivery-failure` entity = durable outbox with replay and a failures API |
| "Capability descriptor must be built" | Already exists: `src/engine/engine-capability-matrix.ts` |
| "Single database" | **Two datasources**: `main` (always SQLite — `api_keys`, `audit_logs`) and `data` (SQLite *or* Postgres, with a configurable schema that sets `search_path`) |
| — | `src/modules/takeover/` is **session-node** takeover (HA lease adoption), **not** human takeover — no naming conflict with Support CRM's escalation |
| — | `src/modules/automation/` is a per-session autoreply engine that **sends directly**. See §6 — this is the one real conflict |

### Verified integration contracts

These are read from source and must not be re-derived from memory.

**Inbound payload** — `IncomingMessage` (`src/engine/interfaces/whatsapp-engine.interface.ts:86`):
`id`, `from`, `to`, `chatId`, `body`, `type`, `timestamp`, `fromMe`, `isGroup`, `kind`,
`isStatusBroadcast?`, `ephemeralDuration?`, `author?` (real sender in groups — `from` is the group
JID), `mentionedIds?`, `call?`, `isLidSender?`, `senderPhone?`, `contact?`, `media?`
(`mimetype`, `filename?`, `data?` base64, `omitted?`, `sizeBytes?`), `quotedMessage?` (`id`, `body`),
`location?`.

**Webhook events** (`SUBSCRIBABLE_EVENTS`, `src/modules/events/dto/ws-messages.dto.ts`):
`message.received`, `message.sent`, `message.ack`, `message.revoked`, `message.reaction`,
`message.edited`, `session.status`, `session.qr`, `session.authenticated`, `session.disconnected`,
`session.restriction`, `group.join`, `group.leave`, `group.update`, `group.join_request`,
`call.received`, `status.received`, `presence.update`, `call.accepted`, `call.rejected`,
`call.missed`.

**Webhook headers** (`webhook-delivery.service.ts`): `X-OpenWA-Event`,
`X-OpenWA-Idempotency-Key`, `X-OpenWA-Delivery-Id`, `X-OpenWA-Retry-Count`,
`X-OpenWA-Signature` = `sha256=<hex>`, HMAC-SHA256 over the **exact serialized body**.
The gateway warns that a queue failure can cause both the queued job and a direct fallback to POST
— both carry the same idempotency key, so **the receiver must dedupe**. Support CRM does.

**Gateway auth**: `X-API-Key` header; `ApiKey` entity with roles `admin`/`operator`/`viewer`,
`allowedIps`, `allowedSessions`, `expiresAt`, SHA-256 `keyHash`.

**Hook events** (`src/core/hooks/hook.interfaces.ts`) — for in-gateway plugins:
`session:*`, `message:received|sending|sent|failed|ack|persisted|deleted`, `webhook:*`, `ingress:error`.

**Send surface used by Support CRM** (session-scoped):
`POST /api/sessions/{sessionId}/messages/send-text|send-image|send-video|send-document|send-audio`,
`/reply`, `/react`, `/edit`, `/delete`; groups under `/api/sessions/{sessionId}/groups/...`
including `participants` add/remove/promote/demote; `GET /api/sessions/{sessionId}/qr`,
`/status`, `POST /start`, `/stop`, `/logout`.

Anything not listed above is treated as unverified until read from source at the phase that needs it.

---

## 3. What is REUSED

**From the gateway (as-is, unmodified):** WhatsApp sessions and QR/pairing; the
`whatsapp-web.js` / `baileys` engine abstraction and its capability matrix; message send surface;
group, contact, chat, and label operations; webhook delivery with HMAC, outbox, and reconciler;
multi-node session ownership and lease takeover; its own API-key auth, audit, metrics, and MCP
surface; Docker images and compose profiles.

**From `../Support Message Automation` (logic and conventions, re-implemented on TypeORM):**
the pure rule evaluator and `regexSafety` save-time validation + runtime timeout (ReDoS control);
insert-and-catch-unique-violation idempotency; the revocable-session design (cookie carries a
high-entropy secret, only its SHA-256 is stored); a seeded permissions **table** with real foreign
keys instead of a string enum, so a typo fails closed; envelope-encrypted provider secrets;
singleton settings rows; soft-deactivation over deletion so history keeps valid FKs;
support-activity semantics (keyword / reply-to-customer / mention triggers, counting modes and
periods computed at query time); escalation message formatting; per-service account routing with
one centralized resolver.

## 4. What is REWRITTEN

The outbound queue (Postgres row stays the durable record; claim and rate-limit counters move to
Redis so multiple workers are safe); rate limiting (`COUNT(*)` per send → Redis counters, identical
policy); web⇄worker coordination (DB polling → Redis queues); the AI response contract (regex over
free text → provider-native structured output); the API surface (Next.js Server Actions → versioned
REST with OpenAPI); UI freshness (column polling → WebSocket).

## 5. What is ISOLATED (net-new Support CRM domain)

Channel abstraction; Customer; Conversation + the state machine; conversation state history; the
**Message Decision Engine**; `decision_logs`; the policy engine with Global → Support Profile →
Group → Conversation inheritance; group modes; Support Profiles and Knowledge Profiles; the
Knowledge Base with documents, chunking, embeddings and RAG; human escalation with internal groups
and executives; takeover / release / kill switch; the Support Inbox; the Job Center; broadcast;
RBAC roles; `audit_logs`; reporting; the admin AI Copilot.

## 6. What is REJECTED

| Rejected | Reason |
|---|---|
| **`gateway/src/modules/automation` (per-session autoreply)** | It replies **directly** on inbound messages, bypassing the decision pipeline. Two authorities on one chat = duplicate and contradictory replies to real customers. Support CRM creates **zero** gateway automation rules and asserts none are active on sessions it owns. |
| `POST /messages/send-bulk` for broadcast | Broadcast must go through Support CRM's Job Center for audience preview, rate limiting, cancellation, per-recipient failures, and audit. The gateway's batch endpoint has none of that context. |
| Gateway `main` SQLite database for CRM data | CRM data is Postgres-only (`PROJECT_SPEC.md` §111). |
| Merging the two auth systems | The gateway authenticates machines; Support CRM authenticates humans and issues its own scoped keys. |
| Extending the gateway's React dashboard into a CRM | It is a transport admin tool. The Support Inbox is a separate surface. |
| Editing gateway source | Extension goes through its hook/plugin system, keeping the fork mergeable (`PROJECT_SPEC.md` §211–212). Any exception is recorded as a new ADR. |
| Microservices | Modular monolith, two run modes (`PROJECT_SPEC.md` §120). |
| Elasticsearch | Postgres FTS + `pgvector` (`PROJECT_SPEC.md` §115). |

## 7. How OpenWA integrates

```
WhatsApp ↔ gateway (own process, own DB, own API key)
     │ webhook POST  (HMAC, X-OpenWA-Idempotency-Key)      ── ingress
     ▲ REST /api/sessions/{id}/...  (X-API-Key)            ── egress
     │
  support-crm ──► ChannelAdapter (interface)
                    └─ WhatsAppChannelAdapter   ← the ONLY code that knows OpenWA exists
```

Rules:
1. Exactly one module — `channel/whatsapp` — may reference OpenWA URLs, headers, payload shapes, or
   its SDK. Enforced by an ESLint `no-restricted-imports` boundary plus review.
2. The adapter translates the gateway's vocabulary (`sessionId`, `chatId`, JIDs, `IncomingMessage`)
   into Support CRM's channel-neutral vocabulary (`ChannelAccount`, `Conversation`, `Message`)
   at the boundary. Gateway terms never leak inward.
3. Support CRM never reads the gateway's database. Only its HTTP API and webhooks.
4. Separate Postgres **databases** on one instance: `openwa` (gateway `data`) and `support_crm`.
   The boundary is enforced by the database, not by convention — no cross-database join is possible.
5. The gateway API key lives encrypted in Support CRM settings, is `operator`-role and
   session-scoped, and is never returned by any Support CRM API or sent to a browser.
6. Capabilities are read from the adapter at runtime. An unsupported action is disabled and
   explained in the UI, never faked (`PROJECT_SPEC.md` §174, §176).

---

## 8. Layer separation

Dependencies point downward only; no layer imports the one above it.

```
Channel Layer        adapters, capabilities, session/account state — vendor-specific, isolated
Conversation Layer   customers, groups, conversations, state machine, messages — channel-neutral
Decision Engine      the single authority on what happens to an inbound message
   ├── Automation Layer   deterministic rules, versioning, simulator      (pure evaluator)
   ├── Knowledge Layer    articles, documents, chunks, retrieval/RAG      (read-only to the engine)
   ├── AI Provider Layer  provider abstraction, memory, structured decision
   └── Notification /     escalation, internal groups, executives, takeover
       Escalation Layer
Outbound Layer       the only code that sends — queue, rate limits, pre-send re-validation
```

The Decision Engine **cannot send**: its return type is an action, and it is constructed without any
channel or outbound dependency. This is a type-level guarantee, not a convention
(`PROJECT_SPEC.md` §161).

## 9. The Message Decision Engine — one authoritative pipeline

Every inbound customer message from every channel takes this path. No feature may bypass it
(`PROJECT_SPEC.md` §5).

```
Incoming message (webhook)
  → verify HMAC · validate · persist · enqueue · 200          [ingestion — nothing heavy here]
  → acquire Redis conversation lock                            [one decision per conversation]
  → normalize (text, language, attachments, quoted, mentions)
  → identify channel → account → group → customer → conversation
  → load conversation state + resolved policy (Global→Profile→Group→Conversation)
  → safety / ignore conditions        (emergency stop, unmonitored, ignore rules, self/team echo)
  → human takeover / AI disabled check (HUMAN_ACTIVE · HUMAN_REQUIRED · PAUSED ⇒ stop)
  → deterministic automation rules    (exact, phrase, keyword, safe regex, scope, schedule, cooldown)
  → knowledge-based automation        (published knowledge with a deterministic response)
       ├── matched ⇒ action = AUTOMATION_REPLY
       └── no match ⇓
  → AI availability   (enabled? provider healthy? within reply/cooldown budget? policy allows?)
       ├── unavailable ⇒ escalate or configured fallback
       └── available ⇓
  → build AI context: current message · relevant history · conversation summary ·
                      customer context · group context · APPROVED knowledge only ·
                      applicable automation rules · layered system instructions
  → AI structured decision  {intent, answer, confidence, knowledgeUsed, knowledgeSources,
                             needsHuman, reason, suggestedAction}
  → confidence + policy evaluation
       HIGH_CONFIDENCE   ⇒ AI_REPLY
       MEDIUM_CONFIDENCE ⇒ CLARIFY or ESCALATE (per policy)
       LOW_CONFIDENCE    ⇒ ESCALATE
       NO_ANSWER         ⇒ ESCALATE
  → escalation: notify configured internal group · notify configured executives ·
                state → HUMAN_REQUIRED · pause AI for this conversation
  → persist ONE decision_log (inputs, every stage verdict, sources, outcome — never secrets,
                              never chain-of-thought)
  → emit an ACTION to the outbound layer            [the engine still has not sent anything]
  → release lock

outbound worker: re-validate (state · flags · emergency stop · rate limit · duplicate ·
                 permission · channel capability) → send → record delivery status
```

Confidence bands `HIGH_CONFIDENCE` / `MEDIUM_CONFIDENCE` / `LOW_CONFIDENCE` / `NO_ANSWER` are
**named states**; their numeric thresholds are admin configuration and may be overridden per
Support Profile and per Group. No threshold is a constant in code (`PROJECT_SPEC.md` §18).

AI must escalate on: not knowing; below threshold; explicit human request; configured sensitive
topic; repeated failure; ambiguity; loop or max-replies reached; provider failure; or any
restricted action, **regardless of confidence** (`PROJECT_SPEC.md` §20, §28).

## 10. AI provider architecture

One `AIProvider` interface — `chat`, `embed`, `classify`, `summarize`, `structured` — with a
capability descriptor, so a provider that cannot do structured output or embeddings is never asked
to. Implementations designed for: OpenAI-compatible (any `baseUrl`), Anthropic, Google/Gemini, and
custom OpenAI-compatible endpoints. Per-job model slots (response, embedding, classification,
summarization, copilot) so one deployment can mix providers.

Admin-configurable per provider: provider kind, model, API key, optional base URL, temperature,
max tokens, system prompt, confidence thresholds, fallback behaviour, enabled state.

**API keys are encrypted at rest (AES-256-GCM envelope), never returned by any API, never sent to
the frontend, and never logged.** Configuration reads return a masked prefix only. Failure handling:
timeout → async retry with exponential backoff → fallback provider → automation fallback → human
escalation, with a Redis circuit breaker so a failed provider is never hammered
(`PROJECT_SPEC.md` §123).

## 11. Capability verification

Each capability the owner listed, mapped to where the architecture carries it. "Phase N" means
designed now, built then.

| Capability | Where | Phase |
|---|---|---|
| WhatsApp account/session management | gateway sessions + `channel_accounts` + adapter | 1 (contract) / 2 |
| Groups | `groups`, `group_members`, adapter group ops | 2–3 |
| Customers | `customers`, `customer_contacts` | 3 |
| Conversations | `conversations` + state machine + `conversation_state_history` | 3 |
| Messages | `messages`, `message_attachments`, `outbound_messages` | 2 |
| Automation rules | `automation/` pure evaluator + versioning + simulator | 5 |
| Knowledge Base | `knowledge/` articles, documents, chunks, versions, profiles | 4 |
| AI | `ai/` providers, memory, retrieval, decision | 6 |
| AI confidence thresholds | policy engine, per Global/Profile/Group; named bands | 6 |
| Human escalation | `escalation/`, takeover, release, kill switch | 7 |
| Internal escalation groups | escalation config per Support Profile / Group | 7 |
| Configurable executive escalation | primary/secondary executives + notification targets | 7 |
| Support activity tracking | `support_activities`, unique on `message_id` | 3 |
| Decision logs | `decision_logs`, one row per decision, mandatory | 5 |
| Audit logs | `audit_logs` with actor/action/resource/before/after/IP | **1** |
| Redis queues / locks / rate limits | BullMQ, `LockService`, `RateLimitService` | **1** |
| RAG / embeddings | `pgvector` on `knowledge_chunks` (extension provisioned in Phase 1) | 4 |
| Bulk operations | Job Center `jobs`/`job_items`, async, resumable, auditable | **1** (engine) / 8 |
| Broadcast | `broadcast/` on the Job Center | 8 |
| Real-time updates | WebSocket gateway, Redis-backed | **1** (transport) / 3 |
| Future multi-channel | channel-neutral core; adapters are the only channel-aware code | 1 (contract) |

---

## 12. Consequences

**Positive.** Spec-compliant. No WhatsApp code written that the gateway already provides.
Horizontally scalable from the start. Adding a channel later means writing one adapter, not touching
the decision engine. The database boundary makes vendor coupling structurally impossible.

**Negative.** Two processes and two databases to operate. The gateway is an upstream dependency
whose releases must be tracked. The prior system's dashboard is rebuilt, not migrated.

**Risks and mitigations.**
- *Gateway automation rules replying independently* → Support CRM creates none and asserts none are
  active on its sessions (§6).
- *Duplicate webhook delivery* → the gateway itself documents that a queue failure can double-POST;
  Support CRM dedupes on `(channel_account_id, external_message_id)` with a unique index.
- *Both systems on one WhatsApp account* → would double-reply to real customers. Development and
  test use a dedicated test number; production cutover is account-by-account, manual, Phase 11.
- *Upstream drift* → `gateway/` stays an unmodified clone; all extension via hooks/plugins.
