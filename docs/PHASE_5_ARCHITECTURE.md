# Phase 5 Architecture — Message Decision Engine

Design for the layer that decides what happens to an inbound customer message. Written against
`docs/PHASE_5_AUDIT.md`; it assumes the reader knows what already exists.

---

## 1. The single authority

```
InboundProcessor.handleMessage()          [worker, per-conversation lock held]
   persist message  ────────────────────► durable, whatever happens next
        │
        │ classification === CUSTOMER_MESSAGE ?      no ──► store, emit, done
        ▼
   DecisionEngine.decide(context) ─────► Decision            ← CANNOT SEND
        │
        ▼
   DecisionExecutor.apply(decision) ───► MessageService.send(source: AUTOMATION|AI)
                                    └──► EscalationService.raise()
                                    └──► conversation state transitions, tags
```

**The engine cannot send.** `DecisionEngine` is constructed without `MessageService`, without any
channel adapter, without the outbound queue. Its `decide()` returns a value. A separate executor
acts on it. This is a type-level guarantee rather than a convention (`PROJECT_SPEC.md` §161).

**The engine cannot be bypassed.** Automatic sends carry `source: AUTOMATION | AI` and a
`decisionId`; `MessageService.send()` rejects those sources without one. A future feature that tries
to auto-reply without a decision fails at the call site.

## 2. The pipeline

```
 1  claim         insert decision_logs (UNIQUE messageId) — 23505 ⇒ someone already decided, stop
 2  guards        emergency stops · monitoring off · classification not CUSTOMER_MESSAGE
 3  takeover      HUMAN_ACTIVE (honouring expiry, releasing when passed) ⇒ HUMAN_HANDLING
 4  paused        controlState PAUSED / pausedUntil in future     ⇒ NO_RESPONSE
 5  loop guard    per-conversation auto-reply budget · repeat text ⇒ SUPPRESSED
 6  rules         evaluate (pure) → deterministic winner          ⇒ RULE_REPLY | ESCALATE | IGNORE | …
 7  ai            only if no rule matched and AI is enabled and available
 7a   retrieve      KnowledgeRetrievalService (Phase 4, unchanged)
 7b   generate      AIProvider.decide(prompt) → structured result
 7c   policy        confidence + explicit flags → AI_REPLY | HUMAN_HANDOFF
 8  fallback      AI unavailable/failed ⇒ HUMAN_HANDOFF (configurable) — never a fabricated answer
 9  record        complete the decision log with everything needed to explain it
```

Each step can end the pipeline. Every ending writes a decision log with an outcome and a reason.

## 3. Idempotency — claim first

`decision_logs` has `UNIQUE (messageId)`. The engine's **first** database write is the claim row
(`status = IN_PROGRESS`). A duplicate webhook, a redelivered job, or a second worker hits 23505 and
returns without deciding. This is the same insert-and-catch pattern the rest of the system uses, and
it is what makes "a duplicate must never produce a duplicate reply" structural rather than hopeful.

Outbound sends additionally carry `idempotencyKey = decision:<decisionId>`, so even a retried
executor cannot send twice.

## 4. Rules are data

```
automation_profiles ──< automation_profile_versions
        │
        └──< automation_rules ──< automation_rule_versions
                    │
                    └──< automation_executions        (what fired, when, for which message)
```

A rule is `{ conditions, actions }` — typed structures, evaluated by a pure function. **No
user-supplied code is ever executed**: no `eval`, no `new Function`, no dynamic import. Regex is the
one place user input becomes an executable-ish artifact, so it is compiled once, length-capped, and
run against a length-capped subject.

**Condition types:** `EXACT`, `NORMALIZED`, `CONTAINS`, `PREFIX`, `SUFFIX`, `REGEX`, `MESSAGE_TYPE`,
`HAS_ATTACHMENT`, `CONVERSATION_STATE`, `BUSINESS_HOURS`, `TIME_WINDOW`, `CUSTOMER_TAG`. Combined
with `ALL` or `ANY`.

**Action types:** `SEND_MESSAGE`, `ESCALATE`, `IGNORE`, `ADD_TAG`, `REMOVE_TAG`,
`SET_CONVERSATION_STATE`, `ASSIGN_TEAM`, `ASSIGN_AGENT`, `TRIGGER_KNOWLEDGE_AI`.

**Deterministic winner**, in this order: scope specificity (CONVERSATION 4 > CUSTOMER 3 > GROUP 2 >
GLOBAL 1) → `priority` DESC → `createdAt` ASC → `id` ASC. Never random; the winner and the losers
both go into the decision log.

**Lifecycle** mirrors Phase 4's knowledge lifecycle rather than inventing a second one:
DRAFT → REVIEW → ACTIVE → PAUSED → ARCHIVED, with immutable versions and rollback. Only ACTIVE rules
execute (§199).

## 5. AI — and the confidence problem

`AIProvider` is an interface with one meaningful method for this phase:

```ts
decide(request: AIDecisionRequest): Promise<AIDecisionResult>
```

The result is **structured, not prose**: `{ decision, answer, confidence, reason, usedKnowledge,
knowledgeSufficient, needsHuman }`.

### Confidence is treated as uncalibrated, and the policy says so

A language model asked "how confident are you?" returns a number that looks like a probability and
is not one. Pretending otherwise would be the single most dangerous thing this phase could do. So:

1. The **model's explicit flags are authoritative for escalation.** `needsHuman: true` or
   `knowledgeSufficient: false` escalates regardless of the number attached.
2. **Objective signals gate the number.** If retrieval returned nothing, or nothing above a
   configured relevance floor, the answer is not knowledge-grounded and escalates — whatever the
   model claims.
3. The self-reported number is used **only to lower** the outcome, never to raise it: it can push a
   reply to escalation, it can never rescue an answer the objective signals already rejected.
4. `decision_logs.confidenceCalibrated = false` records that the stored number is self-reported, so
   nobody later mistakes it for a measured probability.

Thresholds live in settings (`ai.auto_reply_min_confidence`, `ai.escalate_below_confidence`,
`ai.mid_confidence_policy`), never in code.

### Knowledge-grounded prompting

The system prompt states the constraints the spec requires, in the imperative: do not invent policy,
prices, package details or technical procedures; answer only from the supplied knowledge; if it is
insufficient, say so and set `knowledgeSufficient: false`. Retrieved passages are supplied with
their citations, and the answer's citations are recorded in the decision log.

Context is **bounded** — max conversation messages, max knowledge chunks, max characters overall —
because an unbounded prompt is both a cost and a leak surface.

### Failure is never an answer

Unavailable, timed out, rate limited, malformed structured output, provider error → record the
failure, escalate (configurable), notify, keep the customer message. Never a fabricated reply.

## 6. Escalation and takeover

`escalations` records `{ conversationId, messageId, reason, decisionId, status, assignedTo,
resolvedBy, resolvedAt }`. Raising one:

1. sets `conversation.status = WAITING_FOR_HUMAN` and `controlState = HUMAN_ACTIVE`,
2. writes the escalation row,
3. emits a realtime event to the operators,
4. stops automatic replies for that conversation until a human releases it.

The internal notification never goes to the customer. It carries conversation, group, customer,
reason, confidence and timestamp — and no secrets.

**Takeover expiry** is honoured at decision time (an expired takeover is released and the pipeline
continues) and swept by the existing channel-maintenance job, so a conversation does not sit frozen
because nobody sent a message to trigger the check.

## 7. Loop protection

Four independent guards, because one is never enough:

| Guard | Mechanism |
|---|---|
| Our own echoes | `BOT_MESSAGE` classification — already implemented, never reaches the engine |
| Team messages | `TEAM_MESSAGE` never enters the customer pipeline |
| Runaway conversation | Redis budget: N automatic replies per conversation per window |
| Repeated identical text | `markFirstSeen(hash(conversation+body), window)` suppresses a duplicate answer |

Plus bounded execution: one rule evaluation per message, no rule chaining, and a hard cap of one
automatic outbound per decision.

## 8. Bulk and broadcast

Both are Job Center jobs, one item per unit of work — never thousands of writes in a request.

- `BULK_GROUP_UPDATE`: enable/disable AI or automation, assign automation or knowledge profile,
  assign team, tag. Permission-gated, audited, progress-tracked, retryable.
- `BROADCAST`: campaign row + one item per recipient, rate-limited through the existing outbound
  path, cancellable, with success/failure/cancelled counts.

## 9. Observability

Metrics: `decision.processed`, `decision.latency_ms`, `rule.matched`, `ai.requests`, `ai.success`,
`ai.failure`, `ai.escalated`, `escalation.raised`, `loop.suppressed`, plus the existing knowledge
and outbound metrics. Realtime: a `DecisionEventName` union on the existing gateway.

## 10. Module layout

```
modules/decision/          engine, executor, context builder, decision log, dry-run, controller
modules/automation/        rules, versions, profiles, the pure evaluator, controller
modules/escalation/        escalations, notifications, controller
common/ai/                 ai-provider.ts (interface + OpenAI-compatible + test double)
```

`decision/` and `automation/` join `knowledge/` behind the ESLint channel-agnosticism boundary.
