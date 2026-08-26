# Phase 3 — Customer + Conversation domain: completion report

> Date: 2026-08-23
> Preceded by the real-gateway validation: `docs/GATEWAY_VALIDATION_REPORT.md` (12 pass, 0 fail,
> 9 blocked on a physical QR scan; five defects found and fixed before Phase 3 began).
> Every claim below was executed and observed.

---

## 1. Summary

Phase 3 builds the durable CRM domain between the Phase 2 channel layer and the future Message
Decision Engine: customers, channel identities with an explicit match lifecycle, conversations with
a two-axis state model, participants, assignment with preserved history, human-takeover state,
notes and tags.

**It decides nothing.** No AI, no RAG, no automation rules, no keyword matching, no confidence, no
escalation engine, no learning (brief §16). Every piece of state here exists to be *read* by Phase 5.

The rule that shapes the whole phase: **seeing a phone number creates an identity, never a
customer.** Inbound traffic accumulates `UNRESOLVED` identities freely; promotion to a customer is a
separate, human, audited act — and a database check constraint makes the alternative impossible from
any code path.

---

## 2. The two-axis state model (a documented deviation)

`PROJECT_SPEC.md` §7 lists seven conversation states on one axis. Read closely, that list mixes two
independent questions: *where is this in its lifecycle* and *who may respond*. They vary
independently — a conversation can be `WAITING_FOR_CUSTOMER` while a human still holds it — so
collapsing them forces a lossy choice whenever both change.

Phase 3 models them separately, as the brief §3 and §6/§7 do, and projects onto the spec's
vocabulary without loss:

| `PROJECT_SPEC.md` §7 | status | controlState |
|---|---|---|
| AUTOMATION_ACTIVE | OPEN | AUTOMATION_ACTIVE |
| AI_ACTIVE | OPEN | AI_ACTIVE |
| HUMAN_ACTIVE | OPEN | HUMAN_ACTIVE |
| HUMAN_REQUIRED | WAITING_FOR_HUMAN | (unchanged) |
| PAUSED | (unchanged) | PAUSED |
| WAITING_CUSTOMER | WAITING_FOR_CUSTOMER | (unchanged) |
| RESOLVED | RESOLVED | (unchanged) |

`toSpecState()` performs the projection and is **derived, never stored**, so the two cannot drift.
Precedence encodes safety: `PAUSED` wins over everything, and `WAITING_FOR_HUMAN` wins over the
control axis — those are the readings in which an automated responder must not act.

Transitions are validated: `ALLOWED_STATUS_TRANSITIONS` makes `CLOSED` terminal (a new message
starts a new conversation) while `RESOLVED → OPEN` is permitted, which is what §7's reopen rule
requires.

---

## 3. Domain model

| Table | Purpose |
|---|---|
| `customers` | The business entity. Deliberately not a channel contact, deliberately small |
| `customer_identities` | One channel address, with a match state. **`customerId` nullable** |
| `conversations` | Channel-neutral, two state axes, control flags, takeover, assignment pointer |
| `conversation_participants` | Several customers, team members, the account, and unknowns per conversation |
| `conversation_state_history` | Append-only; both axes, actor, reason |
| `conversation_assignments` | Append-only; closed with `unassignedAt`, never overwritten |
| `customer_notes` | Internal commentary. No path to any outbound or AI surface |
| `tags` + `entity_tags` | Shared across customers, conversations and groups |
| `support_teams` | An assignment target that is a queue rather than a person |

`messages` gained the `conversationId` foreign key (Phase 2 shipped the column without one for
exactly this) and a `senderIdentityId`. So every message now resolves to **channel account +
conversation + sender identity + message**, which is brief §5 in full.

### Constraints that carry the intent

| Constraint | What it guarantees |
|---|---|
| `CK_customer_identities_unresolved_has_no_customer` | An UNRESOLVED identity cannot point at a customer. **The brief §2 rule, enforced by the database** |
| `CK_customer_identities_resolved_has_customer` | Anything past UNRESOLVED — including REJECTED — names the customer it refers to |
| `UQ_customer_identities_channel_external` | One channel address is one identity, across replicas |
| `UQ_conversations_account_external` | One chat is one conversation — makes resolution idempotent |
| `UQ_conversation_assignments_one_open` (partial) | At most one open assignment; "who owns this" has one answer |
| `CK_conversation_assignments_one_target` | A user or a team, never both, never neither |
| `CK_conversations_group_has_group_id` | A GROUP conversation names its group |

Verified present in the running database.

---

## 4. Files and migration

**New:** `src/modules/crm/` — `conversation-states.ts`, `customer.service.ts`,
`conversation.service.ts`, `conversation-resolver.service.ts`, `crm-maintenance.processor.ts`,
`customers.controller.ts`, `conversations.controller.ts`, `crm.module.ts`, 5 entity files.

**Changed:** `inbound-message.service.ts` (resolves conversation + identity before the insert),
`message.entity.ts` (+`senderIdentityId`), `realtime.gateway.ts` (+conversation events),
`messaging.module.ts`, `app.module.ts`.

**Migration** `Phase3CustomerConversation1787200000000` — 10 tables, explicit SQL, working `down()`,
plus the FK and column on `messages`. Applied cleanly to the live database.

Also applied: `FixGatewaySessionIdentity1787150000000`, from the gateway validation.

---

## 5. Message → conversation

Resolution runs inside the per-conversation Redis lock the Phase 2 inbound processor already holds,
**before** the message insert, so the row carries `conversationId` and `senderIdentityId` from the
moment it exists. Both find-or-create paths use insert-and-catch-23505 rather than
select-then-insert.

Activity counters (`lastMessageAt`, `messageCount`) are denormalised onto the conversation so the
inbox list needs no aggregate over `messages` — the query that would otherwise dominate the page.

A `RESOLVED` conversation reopens on a new **customer** message. A team member's follow-up or the
account's own echo does not drag a closed issue back open; that distinction is tested.

---

## 6. APIs

All under `/api/v1`, all RBAC-enforced, all audited on mutation.

**Customers** — `GET /customers`, `GET /customers/:id`, `POST /customers`, `PATCH /customers/:id`,
`GET /customers/identities/list`, `POST /customers/identities`,
`POST /customers/identities/:id/propose-match|confirm|reject`,
`GET|POST /customers/:id/notes`, `POST /customers/:id/tags`, `POST /customers/:id/tags/remove`.

**Conversations** — `GET /conversations`, `GET /conversations/:id`,
`GET /conversations/:id/messages|participants|state-history|assignment-history`,
`POST /conversations/:id/status|control-state|takeover|release|assign|unassign|tags`,
`PATCH /conversations/:id/flags`.

Message history is **cursor-paginated** on `sentAt`, not offset-paginated: a live conversation grows
while it is read, and offset paging silently skips or repeats rows when it does.

---

## 7. Real-time events

`conversation.created`, `.updated`, `.message_received`, `.message_sent`, `.assigned`,
`.takeover_started`, `.takeover_ended`, `.resolved`, `.reopened` — a closed TypeScript union, so a
typo is a compile error. Subscribe via `subscribe:conversation`, gated on `conversations.read`.

Payloads carry identifiers and state only — **never a message body, a customer note, or a phone
number**. This fans out to every subscribed operator socket, and content belongs behind an
authorised fetch (`PROJECT_SPEC.md` §110).

---

## 8. Security and privacy

- `conversations.takeover` is a permission distinct from `conversations.manage`: taking a
  conversation from automation is a different authority from tagging or resolving it.
- **Customer phone numbers are never logged or audited.** Audit rows record that a customer was
  created and by whom, not their contact details.
- **Note bodies are never audited** — notes are internal commentary and the audit log is readable by
  more roles than the CRM.
- Notes have **no path to any outbound or AI surface**. `MessageService` cannot read the table, and
  no serializer folds a note into a message. When Phase 6 assembles AI context, including notes must
  be an explicit decision there — the absence of a link today is what forces it to be conscious
  (brief §9).
- Every search term is parameterised; `plainto_tsquery` is used for full-text so a user cannot
  inject query operators.

---

## 9. Tests — 300 passing

```
Unit          9 suites, 141 tests
Integration   5 suites, 159 tests   (real Postgres + real Redis)
```

Phase 3 adds **46 integration tests**, all passing on the first run: customer creation independent
of channel contacts · multiple identities per customer · duplicate-identity prevention at service
*and* database level · all four match states · the check constraint refusing a linked UNRESOLVED
identity · CANDIDATE-not-CONFIRMED proposal · refusal to propose on an ambiguous number ·
confirmation backfilling existing conversations · **never overwriting a different customer** ·
rejection detaching attribution while keeping the record · direct and group conversation creation ·
conversation reuse · **three distinct participants in one group with zero auto-promoted customers** ·
message→conversation attachment · idempotency · transition-table validation · state history with
actor and reason · reopen-on-customer-message and **not** on a team message · the §7 projection ·
takeover recording, idempotency, default release to AUTOMATION, expiry attributed to SYSTEM, and
never expiring a takeover without a deadline · assignment to user and team · **history preserved on
reassign** · the one-open-assignment index · refusal of both-or-neither targets · cursor pagination
with no overlap · page-size capping · RBAC allow and deny including the takeover permission ·
audit before/after · and the assertion that no phone number or note body reaches the audit trail.

Quality gates: `lint` 0 errors 0 warnings · `typecheck` clean · `build` succeeds · Docker build
succeeds · stack starts healthy · live endpoints return 200 authenticated, 401 unauthenticated.

---

## 10. Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Customer exists independently from channel contacts | ✅ separate tables; creating a customer creates no identity |
| 2 | Multiple identities per customer | ✅ tested |
| 3 | WhatsApp identities associated safely | ✅ UNRESOLVED default; CANDIDATE on exact match only; CONFIRMED only by a human; check constraint enforces it |
| 4 | Conversations independent of WhatsApp | ✅ `conversation.entity.ts` contains no provider vocabulary |
| 5 | Direct and group conversations | ✅ both tested, incl. 3 participants in one group |
| 6 | Messages attached to conversations | ✅ FK added; `conversationId` + `senderIdentityId` set before insert |
| 7 | Conversation state persisted | ✅ two axes + history, transitions validated |
| 8 | Human takeover state persisted | ✅ who/why/when/expiry/resume, 6 tests |
| 9 | Assignment and history | ✅ append-only, partial unique index |
| 10 | Customer tags and notes | ✅ with no AI/outbound path |
| 11 | Conversation history paginated | ✅ cursor-based, capped |
| 12 | Real-time events | ✅ 9 normalized names, permission-gated |
| 13 | RBAC | ✅ 5 tests incl. takeover denial; live 401 unauthenticated |
| 14 | Audit logging | ✅ before/after; PII excluded |
| 15 | Integration tests use real Postgres/Redis | ✅ |
| 16 | Full test suite passes | ✅ **300 tests** |
| 17 | Typecheck passes | ✅ |
| 18 | Lint passes | ✅ |
| 19 | Docker build succeeds | ✅ stack healthy, migration applied |
| 20 | No AI or automation implemented prematurely | ✅ see below |

**On criterion 20.** There is no AI client, no embedding, no rule evaluator, no keyword matcher, no
confidence score and no escalation trigger anywhere in `src/modules/crm/`. `aiEnabled`,
`automationEnabled`, `controlState` and `pausedUntil` are stored and returned; nothing reads them to
make a decision. Both flags default to **false**, so the day Phase 5 and 6 ship, no existing
conversation becomes live retroactively.

---

## 11. Known limitations

1. **Nine gateway-validation items remain unverified** — they need a physical QR scan. See
   `docs/GATEWAY_VALIDATION_REPORT.md` §4. This is the most significant outstanding risk.
2. **No customer-matching automation beyond exact phone.** Deliberate: the brief forbids unsafe
   automatic conversion, and fuzzy matching would produce wrong attributions at scale.
3. **`conversation.message_received` / `.message_sent` are declared but not yet emitted.** The
   inbound path emits `whatsapp.message.received` from Phase 2; routing it through the conversation
   vocabulary belongs with the Phase 3 inbox UI, which does not exist yet.
4. **No customer merge.** Two customers found to be the same must be reconciled by hand.
5. **`support_teams` is minimal** — no membership, rotas or availability. Phase 7.
6. **No `decision_logs`.** Mandatory per §112, lands with the decision engine in Phase 5.
7. **Group participants and conversation participants are separate tables.** A group's roster comes
   from channel sync; a conversation's participants come from who has actually spoken. They overlap
   but are not the same fact, and merging them would lose the distinction.
8. **No admin UI.** REST and WebSocket only.

---

## 12. Phase 4 dependencies

Ready: customers and identities with an auditable match lifecycle; conversations with the two-axis
state the decision engine will read; participants typed without guessing; assignment history for
Phase 9 reporting; notes and tags with a deliberate absence of an AI path; message→conversation
resolution inside the existing conversation lock.

Not started, and Phase 4's own scope: knowledge articles, documents, chunking, embeddings,
`pgvector` retrieval, versioning and approval, knowledge profiles.

**Operational prerequisite unchanged:** Support CRM and the legacy Support Message Automation system
must never hold the same WhatsApp account.

---

## 13. Commands

```bash
docker compose up -d --build
```

```bash
pnpm test
```

```bash
pnpm test:infra:up && pnpm test:integration && pnpm test:infra:down
```

```bash
pnpm lint && pnpm typecheck && pnpm build
```
