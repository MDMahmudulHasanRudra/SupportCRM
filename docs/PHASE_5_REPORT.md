# Phase 5 Report — Message Decision Engine

**Status: implemented and verified, with one item BLOCKED on a human.** All automated gates are
green: 214 unit, 348 integration (real PostgreSQL with pgvector, real Redis, real BullMQ), 5 web,
lint, typecheck, production build, Docker build, and migration up → down → up.

**BLOCKED:** the real-WhatsApp end-to-end run (§13). It was attempted: a validation harness was
written and its first pass executed against the real gateway — 4 PASS, 0 FAIL, 11 BLOCKED. The
eleven need a paired handset and a dedicated test group with a second test number, neither of which
exists. Nothing there is claimed as passing.

Phase 6 has not been started.

Companion documents: `docs/PHASE_5_AUDIT.md` (what existed before, and what this was allowed to
touch), `docs/PHASE_5_ARCHITECTURE.md` (the design this implements), `docs/adr/0001` (layer
boundaries), `PROJECT_SPEC.md` §47–§49, §57, §76–§80, §100–§105, §157, §199.

---

## 1. What was implemented

| Area | Delivered |
|---|---|
| **Single authority** | One path from an inbound message to an outcome: `InboundProcessor → DecisionService → DecisionEngine`. No automatic response can be produced anywhere else |
| **Idempotency** | `UNIQUE (messageId)` on `decision_logs`, claimed before deciding. A duplicate webhook, a redelivered job and a second worker all collide on the database |
| **Rules** | Data, never code — 12 condition types, 9 action types, ALL/ANY matching, negation, cooldowns, execution caps, effective windows |
| **Rule lifecycle** | DRAFT → REVIEW → ACTIVE → PAUSED → ARCHIVED with a legal-transition table, immutable version snapshots and rollback-as-new-draft |
| **Winner selection** | Scope specificity → priority → created-at → id. Deterministic, pure, and the same code in the live engine and the dry run |
| **AI provider** | Abstraction with three modes: `none` (honest unavailability → escalate), `openai` (real, OpenAI-compatible), `test` (scripted, refused in production by env validation) |
| **Knowledge-grounded answers** | Reuses the Phase 4 retrieval unchanged: published-only, scope-respecting, bounded, cited |
| **Confidence policy** | Objective signals decide; the provider's self-reported number can only *lower* an outcome, never raise one |
| **Escalation** | Raised with a reason, deduplicated per conversation, sets the conversation to human control *before* the row is written |
| **Human takeover** | Authoritative and expiring; automation stays silent for the duration and is released deliberately, never automatically |
| **Loop protection** | Four independent guards: classification exclusion, per-conversation reply budget, repeat suppression, and self-message exclusion |
| **Decision log** | Every runtime decision explained — outcome, reason, rule, losing candidates, AI run, knowledge used, timing. Distinct from the audit log |
| **Dry run** | Same evaluator, same policy, same thresholds; sends nothing, writes nothing, and can test a draft before it is approved |
| **Bulk configuration** | Preview → queue → per-group Job Center items with progress, attributable failures and retry-failed |
| **Broadcasts** | Create and send are separate permissions and separate actions; one job item per recipient; cancellable |
| **UI** | Automation rules, rule editor with tester and version history, review queue, profiles and AI settings, bulk actions, decision trace, escalation queue, broadcasts |

---

## 2. Migrations

**`1787500000000-Phase5DecisionEngine`** — one migration, additive, verified reversible on a real
database (`down` then `up`, §11).

Nine tables: `automation_rules`, `automation_rule_versions`, `automation_profiles`,
`automation_profile_versions`, `automation_executions`, `decision_logs`, `ai_runs`, `escalations`,
`broadcasts`. Three nullable `automationProfileId` columns on `conversations`, `groups` and
`customers`; `decisionId` and `broadcastId` on `outbound_messages`.

The constraints that carry weight:

| Constraint | What it makes impossible |
|---|---|
| `UQ_decision_logs_message` | Two decisions for one message — the idempotency guarantee, in the database rather than in application logic |
| `UQ_escalations_open_conversation` (partial, OPEN/ASSIGNED) | A conversation queued for a human twice |
| `CHK_automation_rules_scope_id` | A scoped rule with no scope id, or a global rule carrying one |
| Status `CHECK`s on every lifecycle column | A row reaching a state no code path allows |

No table was dropped, no column was removed, no existing column changed type.

---

## 3. APIs

| Route | Permission | Notes |
|---|---|---|
| `GET /automation/rules`, `/rules/:id` | `automation.read` | |
| `POST /automation/rules`, `PATCH /rules/:id` | `automation.create` | Always lands in DRAFT; editing an ACTIVE rule's behaviour demotes it |
| `POST /automation/rules/:id/status` | `automation.create` + `automation.approve` to activate | Writing a rule and letting it speak are different rights |
| `GET /automation/rules/:id/versions`, `POST /rollback` | `automation.read` / `automation.approve` | Rollback creates a new DRAFT |
| `GET/POST/PATCH /automation/profiles` | `automation.read` / `automation.approve` | |
| `GET /decisions`, `/decisions/:id`, `/decisions/message/:id` | `conversations.read` | `:id` returns the full trace |
| `GET /decisions/status` | `conversations.read` | Provider, model and the thresholds in force — never a credential |
| `POST /decisions/dry-run` | `automation.simulate` | Sends nothing. Reports `sent: false` explicitly, every time |
| `GET /escalations`, `POST /:id/assign`, `POST /:id/resolve` | `conversations.read` / `conversations.manage` | |
| `POST /bulk/groups/preview`, `/apply` | `groups.bulk_update` | `apply` returns a job id; it never writes the rows itself |
| `GET/POST /broadcasts`, `POST /:id/start`, `/:id/cancel` | `broadcast.create` / `broadcast.send` | |

**There is deliberately no endpoint that makes a decision happen.** Decisions are produced by the
inbound pipeline. A "decide now" route would be a second way into the single authority, which is the
one thing this phase exists to prevent.

---

## 4. UI

| Screen | What it answers |
|---|---|
| **Automation** | What rules exist, what state each is in, and what is waiting for approval |
| **Rule editor** | What this rule matches, what it does — and, through the tester, what it *would* do, including while it is still a draft |
| **Profiles & AI settings** | Whether AI is configured at all, and what numbers the engine is deciding by right now |
| **Bulk actions** | How many groups a change covers, before it runs; then per-group progress and retry-failed |
| **Decisions** | What has been happening, one row per inbound customer message |
| **Why did the system respond?** | The rule that acted, the rules that matched and lost, whether the AI ran, what knowledge it saw, whether anything actually reached the customer |
| **Waiting for a human** | Who is waiting, for how long, and whether resolving hands the conversation back to automation or keeps it with a person |
| **Broadcasts** | What is drafted, what it will reach, and a confirmation that states the number before anything sends |

Two presentation rules are enforced rather than assumed:

- **A confidence number is never shown bare.** It always carries "self-reported, uncalibrated", and
  a web test asserts that the caveat is rendered.
- **"The AI answered" and "the customer received something" are never conflated.** The trace states
  which happened; a second web test asserts the "Nothing reached the customer" wording appears when
  `responseMessageId` is null.

---

## 5. The single-authority guarantee

Convention would not survive a future phase, so it is structural in three places:

1. **The engine cannot send.** `DecisionEngine`'s constructor takes no `MessageService`, no channel
   adapter and no queue. It returns a decision; it has no way to act on one.
2. **A send must cite a decision.** `MessageService.send()` rejects any `AUTOMATION` or `AI` source
   without a `decisionId`. An automatic message that no decision produced cannot be created.
3. **The claim comes first.** The first write of `handleInbound` is the decision-log row. Losing
   that race means returning without deciding.

---

## 6. Idempotency

Database-backed, not `if (!processed)`. `claim()` inserts the decision log and treats a `23505` as
"somebody else owns this message" — returning `null` rather than deciding again.

Verified directly: `handleInbound` called twice for one message returns a log the first time and
`null` the second, with exactly one outbound message in the database.

---

## 7. The confidence problem

A language model's self-reported confidence reads like a probability and is calibrated against
nothing. Three decisions follow from taking that seriously:

- **Objective signals are authoritative and evaluated first.** `needsHuman`, `knowledgeSufficient
  === false`, zero knowledge passages, or no confidence supplied at all each force an escalation on
  their own.
- **The number can only lower an outcome.** No combination of flags plus a high number produces a
  reply that the flags alone would not allow. A dedicated pure unit test asserts this across the
  combinations.
- **`decision_logs.confidenceCalibrated` is stored, and is always `false`.** So that no dashboard,
  report or later phase mistakes the number for a measurement.

Thresholds resolve profile → setting → code default and are never literals at the point of use. The
dry run resolves them the same way — a simulation judging by different numbers than the live engine
would be confidently wrong, which is worse than not having one.

---

## 8. Loop protection

| Guard | Stops |
|---|---|
| Classification exclusion | The system answering a team member, another bot, or itself. `BOT_MESSAGE`, `TEAM_MESSAGE` and `SYSTEM` never enter the pipeline |
| Reply budget | Two automatic systems ping-ponging. N replies per conversation per window, held in Redis, peeked before deciding and consumed only on an actual send |
| Repeat suppression | The same answer going to the same person repeatedly |
| Self-message exclusion | The account's own outbound traffic re-entering as inbound |

---

## 9. Security

| Requirement | How |
|---|---|
| No credential to the browser | Bundle scanned after build against every secret in `.env` plus explicit markers — clean |
| No credential in a decision log | The decision log stores no prompt, no message body, no answer, no key. It explains a decision; the inbox holds the conversation |
| No credential in an AI prompt | The prompt carries the question, the history and published knowledge. Nothing else |
| No credential in an error | Provider failures are classified and reported by status, never by echoing a request |
| No arbitrary execution | Rules are JSON. No `eval`, no `new Function`, no dynamic import of user input. `REGEX` conditions are length-capped, case-insensitive-only, compiled once and cached; a broken pattern matches nothing rather than throwing |
| Layer boundaries | ESLint `no-restricted-imports` extended: `automation/**`, `decision/**` and `escalation/**` cannot import `channel/**` or the gateway |

---

## 10. Tests

| Suite | Count | Covers |
|---|---|---|
| `rule-evaluator.spec.ts` + `decision-policy.spec.ts` | 41 unit | Every condition type, negation, ALL/ANY, cooldowns, caps, effective windows, winner ordering, regex limits, and the confidence policy including the "a high number cannot override an objective signal" property |
| `decision-engine.integration-spec.ts` | 54 integration | The whole pipeline against real Postgres and Redis: classification exclusion, takeover, pause, all four loop guards, rule reply, AI reply, escalation, failure handling, duplicate suppression, decision-log contents |
| `bulk-broadcast.integration-spec.ts` | 16 integration | 120 real groups through the real Job Center queue, per-item progress, retry-failed, repeated-run idempotency; broadcast create/start/counters/no-double-send/double-start-refusal/cancel |
| `decisions.test.tsx` | 2 web | The two presentation guarantees in §4 |

The large-scale test is queue-driven by construction: it seeds 120 real group rows, queues a real
job, waits for a terminal state and asserts every row changed. It is not a loop inside a unit test.

### Gate results

| Gate | Result |
|---|---|
| Unit (`pnpm test`) | **214 passed** |
| Integration (`pnpm test:integration`) | **348 passed**, 10 suites |
| Web (`vitest run`) | **5 passed** |
| Lint (api + web) | **clean** |
| Typecheck (api + web) | **clean** |
| Production build (`vite build`) | **clean** |
| Docker build (api image) | **clean** |
| Migration up → down → up | **clean**, verified against a real database |
| Bundle credential scan | **clean** |

No existing test was weakened, skipped or deleted.

---

## 11. Live verification

The console was driven against a running API, worker, PostgreSQL and Redis. Executed end to end:

- Created a rule, edited it, saved it — version 2 recorded.
- Tested it against "What are your office hours?" **while it was still a draft**: the tester reported
  the reply it would send, stated that the rule answers nobody today, and stated that nothing was
  sent.
- Submitted for review, then activated it. The review queue appeared and cleared.
- Created an automation profile; confirmed the settings screen shows the thresholds in force
  (`0.9`, `0.8`) rather than empty boxes, and reports honestly that no AI provider is configured.
- Previewed a bulk change over 6 groups, applied it, watched the job go `queued → completed`, and
  confirmed all 6 rows changed in the database.
- Created a broadcast draft, opened the send confirmation, and cancelled it. Nothing was sent.
- Reverted the Phase 5 migration on the live database, confirmed all nine tables and the three added
  columns were gone, re-applied it, and confirmed the unique index was back.

All demonstration data created during this pass was removed afterwards.

---

## 12. Defects found and fixed

Five, three of them pre-existing and none of them cosmetic.

1. **The worker registered no queue consumer outside Docker.** `worker.ts` set
   `process.env.RUN_MODE = 'worker'` in its body, but `import` statements are hoisted above it — so
   the eight modules that read `RUN_MODE` *at import time* all saw it unset. The worker booted,
   reported itself healthy, and consumed nothing. Invisible under Docker Compose, which supplies the
   variable, and fatal for anyone running the stack locally. Found by watching a queued bulk job sit
   at `QUEUED` with the worker plainly running. Fixed with a side-effect module imported first
   (`run-mode-worker.ts`, `run-mode-api.ts`); the queued job then completed all 6 items.

2. **Migrations could not run outside Docker.** `data-source.ts` called `dotenv`'s `config()` with no
   path; the CLI runs with the working directory set to `apps/api`, where there is no `.env`, so
   every migration command fell back to the built-in defaults and failed authentication. The same
   fault stopped the API booting locally. Both now resolve the repository-root `.env` from the file's
   own location.

3. **A draft rule could not be tested.** The evaluator refuses anything that is not `ACTIVE` —
   correctly, since that is what keeps an unapproved rule away from customers — which meant the
   tester reported "would not match" for exactly the rule somebody most needs to test. Targeted dry
   runs now evaluate a copy with the status raised and report `testedAsIfActive`, which the UI turns
   into an explicit caveat. The live engine passes no rule ids and is untouched.

4. **The dry run judged by hardcoded thresholds** (`0.9` / `0.8` / `ESCALATE`) while the live engine
   used the configured ones. Now both resolve the same way.

5. **"New rule" produced a rule the API refuses.** The knowledge editor's create-blank-then-edit
   pattern does not transfer: a rule with no conditions would match every message and one with no
   actions would do nothing, so both are rejected. The button now creates an inert starter draft.

Two smaller honesty fixes came out of driving the UI: unset settings showed empty boxes when the
engine was in fact deciding by a default (now shown as the in-force value), and a broadcast draft
reported "0 recipients" when it targeted two groups (recipients are resolved at start, so a draft is
now described by what it targets).

---

## 13. BLOCKED — real-WhatsApp validation

**Attempted, not achieved. Nothing here is claimed as passing.** Full detail, per-item results and
the operator runbook are in [`docs/PHASE_5_REAL_WHATSAPP_VALIDATION.md`](PHASE_5_REAL_WHATSAPP_VALIDATION.md).

A re-runnable harness was written for it — `scripts/validate-phase5-whatsapp.mjs` — and its first
pass was executed against the real gateway: **4 PASS, 0 FAIL, 11 BLOCKED**.

| Passed without a phone | Blocked on a phone |
|---|---|
| No broadly-scoped rule is active (0 active rules) | The account is connected |
| Automation is off by default for new conversations | Rule match, delivery, unmatched message |
| Gateway reachable, authenticating, rejecting anonymous calls | AI answer and low-confidence escalation *(also blocked on `AI_PROVIDER=none`)* |
| No credential in any live API payload | Takeover, duplicate replay, loop echo, trace, realtime |

Two physical blockers, neither of which configuration can remove:

1. **Nobody has paired the account.** The gateway retains the session for `final-validation` — number
   and display name intact — but reports `disconnected`. Re-linking means scanning a pairing code on
   the handset.
2. **There is no dedicated test group, and no second test number.** The account here is a live
   personal one, so its real groups are not a test environment; and a message the CRM's own account
   sends is classified `BOT_MESSAGE` and excluded from the pipeline by the anti-loop guard — so the
   account cannot test itself. A customer-side inbound message has to come from another number the
   operator controls.

What was prepared, so the remaining work is a scan and about six messages: the validation gateway is
running and isolated; both directions of CRM ↔ gateway reachability are verified; every automation
rule was deleted so nothing can fire; and the harness refuses to send into any group but one the
operator names, authorises, and that has at most four participants.

Safety properties verified rather than assumed, before any of this:

- 0 ACTIVE rules exist, so no rule can fire against any conversation.
- `conversations.automationEnabled` defaults to `false` at the database level and is never set at
  creation, so **connecting the account cannot cause a reply to anybody**.
- `fromMe` messages are classified `BOT_MESSAGE` and never enter the pipeline.

## 14. Known limitations

- **A group-level automation switch does not enable anything on its own.** The engine ANDs
  conversation × group × profile, and `conversations.automationEnabled` defaults to `false` and is
  never inherited from the group at creation — so the group switch is a veto, not an enabler, and the
  bulk "turn automation on" operation changes nothing observable until each conversation is opted in
  individually. Found while writing the Phase 5L runbook and deliberately **not** changed: it makes
  automation easier to trigger, which is not a change to make unilaterally during a safety
  validation. A one-line fix and its rationale are in
  [`docs/PHASE_5_REAL_WHATSAPP_VALIDATION.md`](PHASE_5_REAL_WHATSAPP_VALIDATION.md) §6.
- **Confidence is uncalibrated, and always will be** until real outcomes are measured against it.
  The system records this rather than papering over it; a later phase could compare `AI_REPLY`
  decisions against subsequent escalations and produce a real calibration curve.
- **No scheduled broadcasts yet.** `scheduledAt` is stored and a scheduled broadcast is not started
  automatically; starting is a deliberate action.
- **Business-hours conditions need hours on a profile.** With none configured, a `BUSINESS_HOURS`
  condition cannot match — deliberately, rather than assuming an office day.
- **The decision list is not yet filtered by group or account** in the UI; the API supports
  conversation and outcome filters only.
- **Bulk operations cap at 10,000 groups per job.** Beyond that an operator should be filtering
  rather than selecting.

---

## 15. Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | One central decision path; no automatic response bypasses it | **PASS** — structural, §5 |
| 2 | A duplicate message never produces a duplicate reply | **PASS** — unique index, asserted |
| 3 | Deterministic rules are evaluated before any AI | **PASS** |
| 4 | Rules are data; no user-provided code is ever executed | **PASS** |
| 5 | Rule lifecycle with approval, versions and rollback | **PASS** |
| 6 | Writing a rule and activating it are separate permissions | **PASS** |
| 7 | Winner selection is deterministic and explainable | **PASS** — losing candidates recorded and shown |
| 8 | AI answers only from published, in-scope knowledge | **PASS** — Phase 4 retrieval, unchanged |
| 9 | AI does not answer everything; thresholds are configurable | **PASS** |
| 10 | No fabricated confidence; objective signals decide | **PASS** — §7, with a dedicated property test |
| 11 | Insufficient knowledge escalates instead of guessing | **PASS** |
| 12 | No AI provider configured → escalate, never invent | **PASS** |
| 13 | Escalation raises, deduplicates and queues for a human | **PASS** |
| 14 | Human takeover is authoritative and silences automation | **PASS** |
| 15 | Team messages never enter the customer pipeline | **PASS** |
| 16 | Loop protection stops two systems answering each other | **PASS** — four independent guards |
| 17 | Every runtime decision is logged and explainable | **PASS** — `decision_logs`, distinct from audit |
| 18 | A dry run tests a rule without sending anything | **PASS** — including drafts |
| 19 | Bulk changes run on the existing queue with per-item progress | **PASS** — 120 groups, real queue |
| 20 | No second queue system was introduced | **PASS** |
| 21 | No credential reaches a browser, log, decision, prompt or error | **PASS** |
| 22 | `decision/**` and `escalation/**` cannot import the channel layer | **PASS** (ESLint) |
| 23 | Every existing suite still passes; all gates green | **PASS** |
| 24 | Real-WhatsApp end-to-end validation | **BLOCKED** — §13, and `docs/PHASE_5_REAL_WHATSAPP_VALIDATION.md` |

**Phase 5 is complete apart from the blocked item. Phase 6 has not been started.**
