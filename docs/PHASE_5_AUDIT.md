# Phase 5 Audit — Message Decision Engine

Read-only inspection of the system as it stands after Phase 4. Nothing was modified while producing
this. Sources: `PROJECT_SPEC.md` (§5–§26, §37, §42–§49, §76–§80, §108, §117, §157–§161, §184–§192,
§199), the Phase 3, 3.5 and 4 reports, `docs/adr/0001`, and the repository.

**Headline finding: the seam Phase 5 needs already exists and is unoccupied.** Phase 3 built the
conversation state, control state and takeover fields with comments that say in as many words "read
by the Phase 5 Message Decision Engine; Phase 3 contains no logic that acts on them". Phase 4 built
retrieval with an in-process service and no HTTP surface, for the engine to call. What is missing is
the engine itself, the rules it evaluates, and the AI layer behind it.

---

## 1. Current inbound flow

```
WhatsApp → OpenWA gateway
  → POST /api/v1/channels/whatsapp/webhook/:accountId      [ingestion.service]
      verify HMAC · replay window · dedupe · persist provider_event · enqueue · 200
  → queue: message-incoming
  → InboundProcessor.process()                             [worker only]
      → handleMessage()
          adapter.normalizeInboundMessage()                 ← only OpenWA-aware step
          acquire Redis lock  conversation:<accountId>:<externalConversationId>   (wait, 20s)
          InboundMessageService.persist()
              classify()  →  CUSTOMER_MESSAGE | TEAM_MESSAGE | BOT_MESSAGE | SYSTEM_EVENT | UNKNOWN
              ConversationResolverService.resolveForInbound()  → conversation + sender identity
              INSERT message   (unique on channelAccountId+externalId → 23505 = duplicate)
              attachments · group.lastMessageAt · recordActivity() · emitCreated()
          markProcessed(PROCESSED)
          provider_event → PROCESSED
          realtime: whatsapp.message.received   (ids and metadata only, never the body)
      → return
```

**The insertion point is exact:** `InboundProcessor.handleMessage()`, after `persist()` returns a
non-duplicate message and before/around the realtime emit. The per-conversation Redis lock is
already held at that point, which is precisely the mutual exclusion a decision needs.

Everything the engine requires is already resolved by the time it would be called: the conversation,
the sender's channel identity, the classification, the group, the customer identity (if confirmed),
and the durable message row.

## 2. Current outbound flow

```
MessageService.send()                       ← the single control point
    validate body/attachments · length cap
    idempotencyKey lookup → return existing row (no second send)
    account exists · ownershipEnabled
    emergency stop: emergency.outgoing_messages_stopped
    INSERT outbound_messages (QUEUED)  ·  enqueue message-outgoing
  → OutboundProcessor                       [worker only]
    re-check emergency stop · re-check ownership   ← state at SEND time governs
    rate limits (peek then consume)
    adapter.send()
    persist the sent message row with classification BOT_MESSAGE
    delivery receipts update deliveryStatus
```

**Who can call it today:** exactly two callers — `messages.controller.ts` (a human pressing send)
and the outbound processor itself. `grep` confirms no other production caller.

**Therefore: nothing in the system can currently send an automatic reply.** There is no automation,
no AI, no auto-responder, and no scheduled sender. The "no automatic response may bypass the engine"
rule is currently true by absence; Phase 5's job is to keep it true by construction once automatic
responses exist.

`OutboundSource` already declares `MANUAL | AUTOMATION | AI | BROADCAST | SYSTEM` — the vocabulary
Phase 5 needs, unused except for MANUAL.

## 3. Conversation state handling

Two independent axes, projected onto the spec's seven states by `toSpecState()`:

| Axis | Values |
|---|---|
| `ConversationStatus` (lifecycle) | OPEN · PENDING · WAITING_FOR_CUSTOMER · WAITING_FOR_HUMAN · RESOLVED · CLOSED |
| `ConversationControlState` (who may respond) | AUTOMATION_ACTIVE · AI_ACTIVE · **HUMAN_ACTIVE** · PAUSED |

`ALLOWED_STATUS_TRANSITIONS` enforces legality; `CLOSED` is terminal and `RESOLVED → OPEN` is the
reopen rule, which fires **only for a customer message** — a team follow-up or the account's own echo
does not drag a resolved issue back open. That rule is already implemented in `recordActivity()`.

Fields Phase 5 reads, all present and currently inert:

`conversations.controlState`, `.pausedUntil`, `.takeoverByUserId`, `.takeoverReason`, `.takeoverAt`,
`.takeoverExpiresAt`, `.assignedToUserId`, `.assignedToTeamId`, `.aiEnabled`, `.automationEnabled`
· `groups.aiEnabled`, `.automationEnabled`, `.monitoringState`, `.knowledgeProfileId`
· `customers.knowledgeProfileId`

**Takeover expiry is stored but nothing expires it.** No sweep, no check. Phase 5 must both honour
`takeoverExpiresAt` and release it when it passes.

## 4. Existing automation infrastructure

**None.** There is no rule entity, no rule engine, no evaluator, no automation module. What exists
is the *scaffolding around* one:

- Permissions already seeded: `automation.read`, `automation.create`, `automation.approve`,
  `automation.simulate`, plus `ai.configure`, `ai.execute`, `ai.review`.
- Emergency stops already defined: `emergency.all_automation_paused`, `emergency.all_ai_paused`,
  `emergency.outgoing_messages_stopped`, `emergency.broadcast_disabled`,
  `emergency.bulk_operations_paused`.
- Feature flags in settings: `feature.ai_enabled`, `feature.automation_enabled`,
  `feature.ai_generated_automation_enabled`, `feature.ai_auto_activation_enabled`.
- `groups.automationEnabled` / `.aiEnabled` and the conversation-level equivalents.

The **gateway's own** automation engine is deliberately rejected (`docs/adr/0001` §6), and
`WhatsAppAutomationGuard` refuses to connect a session that has gateway autoreply rules enabled —
because two systems answering one WhatsApp account produces duplicate replies to customers.

## 5. Existing knowledge retrieval (Phase 4)

`KnowledgeRetrievalService.retrieve()` — hybrid keyword + vector, scope-prioritised
(GROUP > CUSTOMER > PRODUCT > GLOBAL, profile-overridable), bounded on passage count **and**
character budget, and cited (`chunkId`, `articleId`/`documentId`, title, version, score, matchedBy).

Guarantees already proven by 68 integration tests: production retrieval returns **only** PUBLISHED
content, and group A's knowledge is *absent* — not merely deranked — from a group B retrieval.

Deliberately exposed as an **in-process service with no HTTP route**, exactly so Phase 5 calls it
directly. Phase 5 must not rebuild any of it.

## 6. Existing AI/provider abstractions

One, and it is narrow: `EmbeddingService` (`common/ai/embedding-provider.ts`) — text in, vectors
out. Three modes (`none` / `openai` / `test`), honest unavailability, classified retryable vs
permanent failures, credential environment-only, test provider refused in production.

**There is no generation provider.** No completions, no chat, no structured output, no confidence.
Phase 5 must build `AIProvider` alongside — not inside — the embedding service, following the same
rules: environment-only credentials, honest failure, no fabrication.

## 7. Existing queue architecture

BullMQ, one Redis, worker mode only for consumers.

| Queue | Status |
|---|---|
| `message-incoming` | live — inbound events |
| `message-outgoing` | live — the only send path |
| `channel-maintenance` | live — health, delivery reconciliation, auto-recovery |
| `knowledge-index` | live — Phase 4 |
| `job-center` | live — generic per-item jobs with progress, retry, cancel |
| **`ai-request`** | **declared, no producer or consumer** |
| **`broadcast-send`** | **declared, no producer or consumer** |
| `maintenance` | declared |

Job types declared but unhandled: `BULK_GROUP_UPDATE`, `BROADCAST`, `MEMBER_OPERATION`,
`REPORT_GENERATE`, `EXPORT`. The Job Center gives per-item progress, per-item failure, retry-failed
and cancellation for free — Phase 5's bulk and broadcast foundations should use it rather than
inventing anything.

## 8. Existing idempotency

| Layer | Mechanism |
|---|---|
| Webhook delivery | `provider_events` unique on the gateway's idempotency key |
| Inbound message | `UNIQUE (channelAccountId, externalId)`, insert-and-catch-23505 |
| Outbound | `UNIQUE (idempotencyKey)` on `outbound_messages`, checked before any other work |
| Jobs | `JobsService.create` catches 23505 |
| Dedupe helper | `RateLimitService.markFirstSeen(key, ttl)` — Redis SET NX, first-caller-wins |

The pattern throughout is **database-backed, not `if (!processed)`**. Phase 5's decision record must
follow it: a `UNIQUE (messageId)` on `decision_logs` is the natural guarantee that one message
produces at most one authoritative decision, even under duplicate delivery or worker restart.

## 9. Existing locks

`RedisService` + a locks service offering `withLock(name, ttlMs, fn, { onBusy: 'wait' | 'skip' })`.
In use for: the per-conversation inbound lock, the per-account session lifecycle lock (`skip` → 409),
the Job Center's per-job lock, and group sync.

The inbound lock is the one that matters here: `conversation:<accountId>:<externalConversationId>`,
already held while a message is persisted. One decision per conversation at a time falls out of it.

## 10. Existing permissions

37 permissions across 9 roles, with a super-admin bypass. Everything Phase 5 needs is already
seeded — `automation.*`, `ai.*`, `conversations.takeover`, `messages.send`, `system.emergency_stop`,
`jobs.manage`. **No RBAC migration is required.**

## 11. Existing realtime infrastructure

Socket.IO on the `/realtime` namespace, cookie-authenticated, room-scoped, with `RedisIoAdapter`
bridging worker → API (added in the WhatsApp UX phase, without which nothing a worker emits reaches
a browser). Three event unions exist: `WhatsAppEventName`, `ConversationEventName`,
`KnowledgeEventName`, plus `JobProgressEvent`.

Established convention: **identifiers, states and counts only — never message bodies, never
credentials**, because the channel fans out to every subscribed operator.

## 12. Existing observability and security

`AppLogger` (structured, with `redact()`), `MetricsService.increment/time`, `AuditService` with
before/after diffing and an actor derived from the request. `INFRASTRUCTURE_ONLY_KEYS` blocks
`openwa.api_key` from ever being written through the settings API — the precedent Phase 5's AI
credential must follow.

---

## 13. What must be REUSED (not rebuilt)

| Reuse | Why |
|---|---|
| `KnowledgeRetrievalService` | Scope isolation and published-only filtering are already proven; a second retrieval path would be a second place to get it wrong |
| `MessageService.send()` | The single outbound control point, with idempotency, emergency stop, ownership and rate limits already in it |
| Per-conversation Redis lock | Already held at the decision point |
| `ConversationResolverService` + the Phase 3 state machine | The engine reads and transitions state; it must not invent a second state model |
| Job Center + BullMQ | Bulk operations, broadcasts and AI calls |
| `RateLimitService` (incl. `markFirstSeen`) | Loop protection and provider limiting |
| `AuditService` | Rule approval, activation, profile changes |
| Realtime gateway | One more event union, not a second transport |
| RBAC catalogue | Already carries every permission Phase 5 needs |
| Emergency stops | `all_ai_paused`, `all_automation_paused` must be honoured by the engine |
| `EmbeddingService`'s design | The template for `AIProvider`: honest unavailability, classified failures, environment-only credentials |

## 14. What must be EXTENDED

| Extend | How |
|---|---|
| `InboundProcessor.handleMessage()` | Call the engine after a non-duplicate persist. **Only for `CUSTOMER_MESSAGE`** |
| `MessageService.send()` | Accept `source: AUTOMATION \| AI` and a decision reference, so every automatic send is traceable to the decision that caused it |
| `RealtimeGateway` | A `DecisionEventName` union |
| `conversations` | Takeover expiry must actually be honoured and released |
| `groups` / `customers` | An `automationProfileId` binding, mirroring Phase 4's `knowledgeProfileId` |
| Settings | Confidence thresholds, context budgets, takeover TTL, loop-protection limits — configurable, never hardcoded |
| Job types | Handlers for `BULK_GROUP_UPDATE` and `BROADCAST` |

## 15. What must be ISOLATED

- **The engine cannot send.** Its return type is a decision, and it must be constructible without a
  channel adapter or outbound dependency — a type-level guarantee, per `PROJECT_SPEC.md` §161 and
  ADR-0001 §8. Something *else* acts on the decision.
- **The rule evaluator must be pure.** Inputs in, matches out: no database, no clock, no network.
  That is what makes dry-run trustworthy and the winner deterministic.
- **AI provider details stay behind `AIProvider`.** The engine must not know which vendor answered,
  only that it got a structured result.
- **Channel agnosticism.** The engine deals in conversations, messages and identities. The ESLint
  boundary that keeps `knowledge/**` clean should be extended to the decision and automation modules.

## 16. What must be PROHIBITED

| Prohibited | Reason |
|---|---|
| Any auto-reply path that bypasses the engine | The single-authority rule (§5, §161) |
| Executing user-supplied code in a rule | Rules are **data**. No `eval`, no `new Function`, no dynamic import |
| Auto-replying to `TEAM_MESSAGE` or `BOT_MESSAGE` | The anti-loop invariant. Our own echoes return as BOT_MESSAGE and must be inert |
| Answering while `controlState = HUMAN_ACTIVE` | Human takeover is authoritative |
| Fabricated confidence | If a provider cannot supply a calibrated number, the system must derive one explicitly or decline to claim one |
| Unpublished knowledge in a production prompt | §198, already enforced in retrieval — the engine must not add a path around it |
| Secrets in prompts, decision logs, audit rows, realtime payloads or API responses | §110, §129 |
| Thousands of writes inside one HTTP request | §49 — bulk work belongs on the Job Center |
| Enabling the gateway's native autoreply | Two responders on one account = duplicate replies to customers |

---

## 17. Risks going in

**R1 — the engine is a single point of failure for every inbound message.** If it throws, messages
must still persist and must not be lost. The decision must be attempted *after* the message is
durable, and a failure must degrade to "no automatic response" plus an escalation, never to a
dropped message.

**R2 — no generation provider exists or is configured.** Like embeddings, the honest posture is that
AI is *unavailable* until configured: rules still run, and anything that would have gone to AI
escalates instead. The system must never fake an answer.

**R3 — loop protection is subtle.** `BOT_MESSAGE` classification is the first guard and already
works. It is not sufficient on its own: a customer repeating themselves, two rules triggering each
other, or a rule that answers its own answer all need bounded execution and per-conversation rate
limits.

**R4 — confidence without calibration.** A model asked "how confident are you?" produces a number
that reads like a probability and is not one. This needs an explicit design decision, recorded, not
a hidden assumption.

**R5 — scale.** 3,000 groups means profile-based configuration and queued bulk operations, or an
administrator cannot operate the system at all.

---

## 18. Conclusion

The foundation is unusually well prepared for this phase: the state fields, the control state, the
takeover columns, the outbound source enum, the queues, the job types, the permissions and the
emergency stops were all created in earlier phases *for this purpose* and are still inert. Phase 5
is therefore mostly new code in new modules, plus one carefully-placed call in
`InboundProcessor.handleMessage()`.

Design follows in `docs/PHASE_5_ARCHITECTURE.md`.
