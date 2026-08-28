# Phase 2 — Group Operations, AI Monitoring, Support Analytics

Implementation report. Every claim below is marked with how it was checked. Anything that could not
be verified end-to-end says so plainly.

---

## 1. What already existed

The audit came first, and most of the requested surface was already present. Reused unchanged:

| Area | State found |
|---|---|
| `/groups/operations/{list,summary,matching-ids}` | Present, server-side paginated/filtered/sorted |
| Bulk operations | Present — 10 operations, queued server-side via the Job Center |
| Job progress | Present — `status`, `completedItems`, `failedItems`, cancel, retry, `GET /jobs/:id` |
| `TeamMemberIdentity` + CRUD | Present, with `TEAM_MESSAGE` classification wired to it |
| Support analytics + `/support-members`, `/support-activity` | Present |
| Knowledge profiles | Present — `GET/POST /knowledge/profiles` |
| AI safety composition | Present — `conversation && group && profile`, with 8 pinning tests |
| RBAC | All required permissions present (`groups.bulk_update`, `team.manage`, `reports.view`) |
| Group detail page | Present, with Overview / Messages / Members / AI activity / Human support / Settings |

No entity was duplicated. No working backend logic was replaced.

---

## 2. What was extended

- **`DecisionContextBuilder`** — now composes AI and automation permission through a shared helper
  that returns both the boolean *and* the layers that produced it.
- **`GroupOperationsService`** — added `activeToday` and `knowledgeProfileId` filters, today-based
  counters, and today-based sort keys.
- **`BulkOperationsService`** — added `CLEAR_KNOWLEDGE_PROFILE`.
- **`BulkController`** — the audit record now includes the *selection* (filter or explicit-id count),
  not just the operation and total.
- **`ReportsController` / `ReportsModule`** — added the operations dashboard endpoints rather than a
  new controller, since there is no new domain boundary.
- **`Group` entity** — declared `knowledgeProfileId`, which existed in the database with a foreign
  key but had never been declared, so TypeORM could not read it.
- **Groups page** — tabs, two filters, an Automation column, today-based counters.
- **Group detail** — an "AI & automation" tab.
- **Dashboard** — an operations section added *alongside* the existing conversation reporting.

---

## 3. What was newly created

| File | Purpose |
|---|---|
| `common/http/query-boolean.ts` | Correct boolean parsing for query strings |
| `decision/permission-chain.ts` | Composes a permission and names the layers withholding it |
| `groups/group-ai-status.service.ts` | Why AI can or cannot reply in a group |
| `reports/operations-analytics.service.ts` | Coverage, AI vs human, top groups |
| `web/pages/groups/ai-automation-tab.tsx` | The permission chain, rendered |
| `web/pages/dashboard-operations.tsx` | The operations dashboard section |
| 4 spec files | 62 new tests |

---

## 4. Database migrations

**`1788200000000-Phase12MessageForeignKeyIndexes`** — indexes on the five foreign-key columns that
reference `messages`.

This came out of a measurement, not a guess. Five tables carry a foreign key to `messages`
(`messages.quotedMessageId`, `outbound_messages`, `automation_executions`, `escalations`,
`ai_messages`) and none indexed the referencing column. Postgres does not index the referencing side
automatically, so every message deletion required a sequential scan of each of those tables.

Measured on 201,000 messages:

| | Time |
|---|---|
| Before | **>11 minutes, cancelled without completing** |
| After | **12.5 seconds** |

This matters well beyond test cleanup: retention policies, erasure requests and account purges all
delete messages, and all three were effectively impossible at volume.

Applied and verified: `[migrate] applied Phase12MessageForeignKeyIndexes1788200000000`.

No other migration was needed — `patternAnalysisEnabled`, `knowledgeProfileId`, `monitoringState`,
`aiEnabled` and `automationEnabled` all already existed.

---

## 5. API changes

**New**

- `GET /groups/:id/ai-status` — the effective AI permission and what is withholding it
- `GET /reports/operations?days=` — coverage, today, window, daily series, top groups
- `GET /reports/ai-vs-human?days=` — per-day AI and human, replies and unique groups
- `GET /reports/group-coverage`

**Extended**

- `GET /groups/operations/list` — `activeToday`, `knowledgeProfileId` filters; `messagesToday`,
  `aiRepliesToday`, `humanSupportToday` sorts
- `PATCH /groups/:id/config` — `patternAnalysisEnabled` now actually persists (it was accepted and
  silently dropped)
- `POST /bulk/groups/apply` — `CLEAR_KNOWLEDGE_PROFILE`; audit records the selection

No endpoint was duplicated.

---

## 6. UI changes

- **Groups** — tabs (All / Monitored / AI enabled / AI disabled / Active today), Activity and
  Knowledge profile filters, Automation column, today-based counters, "Remove knowledge" bulk action.
  Tabs *write through* to the filters rather than filtering independently, so a tab can never
  contradict the dropdown beneath it.
- **Group detail** — an "AI & automation" tab showing the full permission chain, every blocking
  layer marked, and one sentence naming the switch to change.
- **Dashboard** — a "Group operations" section: six KPI cards, AI vs human (replies *and* unique
  groups), coverage bars, unique-groups-reached trend, most active groups, support members.

---

## 7. Dashboard metrics

Every figure is an aggregate over rows that exist. Definitions, as required:

| Metric | Definition |
|---|---|
| AI replies | `COUNT(*) WHERE classification = 'BOT_MESSAGE'` |
| AI supported groups | `COUNT(DISTINCT "groupId")` with at least one `BOT_MESSAGE` in period |
| Human support | `COUNT(*) WHERE classification = 'TEAM_MESSAGE'` |
| Human supported groups | `COUNT(DISTINCT "groupId")` with at least one `TEAM_MESSAGE` in period |
| Groups monitored | `monitoringState = 'MONITORED'` |
| **AI configured** | Groups whose own switch is on — **deliberately not** "AI will reply here" |

That last distinction is carried into the field name (`aiConfigured`, not `aiEnabled`) and the UI
label, because a profile, the monitoring state, an emergency stop or a dropped session can each
still withhold a reply. The effective answer lives on the per-group screen.

Verified against real data: the dashboard reported **7 AI replies across 1 group** — replies and
groups are not interchangeable and are never substituted.

---

## 8. Support Members

Built on the existing `TeamMemberIdentity`. **No second entity was created.** The UI label is
"Support Members"; the model underneath is the same one the classifier consults, so the two lists
cannot disagree about who is on the team.

Matching is on stable identifiers only — WhatsApp JID *or* phone, never display name:

```sql
AND (m."senderExternalId" = i."externalId" OR m."senderPhone" = i.phone)
```

Registration is **not retroactive** — classification happens at ingest, so registering someone today
does not reclassify yesterday. The form says so, because otherwise the first thing an admin sees
after adding a colleague is a zero that looks like a bug.

---

## 9. Group Operations

Server-side throughout: search, filtering, sorting, counting and select-all are all SQL. The browser
holds one page.

"Select all" means all matching. The page, its count, and the select-all resolution now share **one**
filter-mapping function (`toFilter`) — previously two hand-written copies, which is exactly how a
bulk operation ends up on a different set than the operator saw.

---

## 10. AI safety enforcement

The composition is unchanged and remains authoritative in the backend:

```
conversation.aiEnabled && group.aiEnabled && profile.aiEnabled
```

What changed is that the boolean and its *explanation* now come from one derivation
(`composePermission`). Two independent derivations would drift, and the failure is silent: a screen
reporting AI as blocked while the engine replies, or the reverse.

`aiEnabled` is read off the chain (`aiChain.effective`), not computed beside it. 65 exhaustive tests
assert `effective === (blockedBy.length === 0)` and that `effective` still equals the plain AND
composition across every combination of the three layers.

New reason codes: `AI_DISABLED_GROUP`, `AI_DISABLED_CONVERSATION`, `AI_DISABLED_PROFILE`.
`reasonCode` is a varchar column, so no migration was needed — but rows written before this change
carry the general `AI_DISABLED`, and a query counting "AI was off" must include it.

**A permissive layer cannot re-enable a blocked one.** Pinned by test.

---

## 11. Performance and indexing

Measured on **3,000 groups / 201,000 messages**, seeded and then removed.

**A real defect was found and fixed.** The group list computed per-group counters with a
`LEFT JOIN LATERAL`. Postgres evaluates that for *every matching group* before applying `LIMIT` —
the plan showed `loops=3009` for one page of 50 — and its cost grew with total message history:

| Approach | One page of 50 |
|---|---|
| Per-row lateral (before) | **191 ms** |
| Date-bounded grouped CTE (after) | **3.3 ms** |

The counters are now bounded to one day, so cost grows with today's traffic rather than with
everything ever stored. All-time counters moved to the group detail screen, where the scope is one
group. A dedicated `(sentAt, groupId)` index saved a further 0.9 ms and was **not** added — the
existing `IDX_messages_account_time` already serves it.

**HTTP timings at 3,009 groups / 201k messages:**

| Endpoint | Time |
|---|---|
| List, page 1 | 41–130 ms |
| List, deep offset (page 40) | 72 ms |
| Search | 56 ms |
| Summary | 38 ms |
| `matching-ids` (select-all) | 45 ms |
| Support roster | 40 ms |
| **Dashboard** | **400–1000 ms warm** |

A speculative `messages(sentAt)` index was tested against the dashboard and gave no material benefit
(the 14-day window is ~7.5% of rows, so Postgres correctly prefers a sequential scan). It was
dropped rather than kept on a hunch.

---

## 12. Tests

**388 API tests / 24 suites, 21 web tests — all passing. 0 typecheck errors, 0 lint warnings.**

62 added this phase. Against the requested list:

| # | Requirement | Status |
|---|---|---|
| 1 | Group AI disabled → cannot reply | Covered |
| 2 | Profile disabled → cannot reply | Covered |
| 3 | Conversation disabled → cannot reply | Covered |
| 4 | Emergency stop → cannot reply | Covered |
| 6 | Pattern analysis off → detector ignores group | Covered (SQL asserted) |
| 7, 8, 9 | Match by JID / phone / not display name | Covered |
| 10 | Inactive member not counted | Covered |
| 12 | Many messages in one group = one unique group | **Verified against real rows**: 3 replies → `replies=3, groups=1` |
| 13 | Many AI replies in one group = one group | Verified: 7 replies, 1 group |
| 14, 15 | Select-all respects filters | **Verified at 3,000 groups**: 750 selected under `aiEnabled=true`, not 3,009 |
| 16 | Pagination correct at 3,000+ | Verified |
| 17 | Dashboard matches DB aggregates | Verified |
| 18 | Timezone boundaries | Partially — "today" is asserted to be local midnight; DST boundaries not tested |
| 19, 20 | Existing conversations / messaging still work | Regression suite passes; **no live WhatsApp message was sent** |

**Not covered:** #5 (monitoring off does not delete stored messages) and #11 (support message
increments the counter) have no dedicated test. #11 is covered indirectly by the verified
aggregation; #5 is asserted nowhere and is listed as a gap.

---

## 13. Docker build status

All four images rebuild cleanly. Six services healthy:

```
api · openwa · postgres · redis · web · worker
```

`docker compose -f docker-compose.yml -f docker-compose.prod.yml config` validates. Deployment
remains one command. Architecture unchanged.

---

## 14. Security scan

Production bundle (571 KB) scanned for every secret-shaped variable in `.env`, by value:

- `OPENWA_API_KEY`, `SECRET_ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`, `DATABASE_PASSWORD`,
  `POSTGRES_PASSWORD`, `SEED_ADMIN_PASSWORD` — **none present**
- Internal hostnames/ports (`api:4000`, `postgres:5432`, `redis:6379`, `openwa:2785`) — **none present**
- `redis://`, `postgres://` — **absent**

One match on `REDIS_KEY_PREFIX` was investigated and is a **false positive**: the value is
`support-crm`, the product name, appearing as a DOM event name and a localStorage key.

**Port audit:** only `0.0.0.0:12000 → 80` is published. `postgres`, `redis` and `openwa` expose
container ports with no host binding; `api` and `worker` publish nothing.

---

## 15. Browser verification

**Verified:**

- 15 routes swept — no blank pages, **0 console errors**
- Deep-link hard refresh on `/support-activity` and `/groups/:id` (nginx SPA fallback)
- Tabs write through to filters — every tab checked, dropdown never contradicts
- Filters: AI disabled → 9, AI enabled → 0, Active today → 3
- Permission chain renders all six layers, both blocking layers marked
- Pattern-analysis toggle persists server-side (confirmed by re-fetch, then reverted)
- At 3,000 groups: 50 rows rendered, `1–50 of 3,009`, select-all → 750 under filter
- Bulk confirmation states the count and the monitoring/AI distinction — **cancelled, not applied**

**Not verified:** responsive/mobile layout. The browser pane reported `clientWidth: 0` on every
route, so those measurements are invalid. A horizontal-overflow reading pointed at the pre-existing
`.topbar`/`.user-menu`, not at any new component, but this was **not** confirmed and should not be
read as either a pass or a regression.

---

## 16. Known limitations

1. **Responsive layout unverified** — see above.
2. **All support figures are legitimately zero.** No `TeamMemberIdentity` is registered and no group
   is monitored, so every inbound message classifies as `UNKNOWN`. This is correct behaviour, not a
   bug: the system genuinely cannot tell a colleague from a customer yet. The aggregation was proven
   correct separately, against real rows inside a rolled-back transaction.
3. **Not live-verified with WhatsApp traffic.** No message was sent to any real group. The outbound
   path and AI reply path are **implemented but not live-verified** in this phase.
4. **No AI provider is configured**, so the engine cannot generate a reply at all. The permitted
   branch of the permission chain is covered by unit test, not by a live AI reply.
5. **Dashboard at 400–1000 ms** on 200k messages. Acceptable now; at millions of messages the
   `aiVsHumanDaily` series (14 index scans) will dominate and want revisiting. No index is justified
   by current measurements.
6. **Knowledge Contribution setting** (`Disabled / Candidates Only / Approved Content`) was **not
   built.** The existing candidate → review → approve pipeline already implements the safe flow, and
   adding a third control over it was not justified without a clearer product decision. Flagged
   rather than guessed at.
7. **Bulk job progress is not surfaced in the Groups UI.** The Job Center has full progress
   (`completedItems`, `failedItems`, cancel, retry) and the bulk apply returns its `jobId`, but the
   Groups page does not yet render that progress inline.
8. **Support Activity date filters** are fixed windows (7/30/90 days). Today / Yesterday / This month
   / Custom range are not implemented.
9. **Historical `reasonCode` values.** Decisions recorded before this phase carry the general
   `AI_DISABLED` rather than a per-layer code.

---
---

# Phase 3 — Timezone correctness, knowledge contribution, support activity detail

A second pass over the same system. Most of the requested surface was already built in Phase 2 and
was reused unchanged; what follows is only what was genuinely missing or wrong.

## A. Already existed and was reused

The knowledge candidate pipeline turned out to be complete: `KnowledgeCandidate` with
`question`/`context`/`sourceType`/`occurrences`/scope, plus `create`, `convert` (→ article) and
`dismiss`, and endpoints for all three. That is exactly the "candidate → review → knowledge"
workflow §33 describes, so **no second knowledge system was created**. The same is true of the
day-drill-down endpoints, `TeamMemberIdentity`, bulk operations, the Job Center and RBAC.

`patternAnalysisEnabled` was already enforced in `candidate-detector.service.ts` — reused, not
reimplemented.

## B. Newly implemented

**Two real bugs found by measurement, both fixed.**

### 1. Postgres and Node disagreed about what day it is

`.env` sets `TZ=Asia/Dhaka` and Node honoured it, but the database session ran `Etc/UTC`. So
`date_trunc('day', now())` in SQL and `new Date(y, m, d)` in Node were **six hours apart**, and
eight SQL sites computed day boundaries themselves.

The symptom was partial and time-of-day dependent: between local midnight and 6am the groups list
and the support roster covered different days, both looked plausible, and after 6am the discrepancy
vanished. Fixed by pinning the session on the connection (`-c timezone=${TZ}`) so a query written
later inherits the right answer. Verified — both now report `2026-08-25T18:00Z`.

### 2. "Today" had no upper bound

Every "today" filter was `sentAt >= midnight` with no upper bound. WhatsApp messages carry the
*sending device's* timestamp, so a skewed clock produces rows dated in the future — and those
inflate "today" permanently. Measured on a controlled fixture: the roster reported **23 replies
today against 12 that actually happened today**. Now `>= midnight AND < tomorrow` throughout, and
the rolling 7/30-day windows are bounded at `now()` too. After the fix the roster and the day-by-day
view agree exactly (12 messages / 2 groups).

### 3. Knowledge contribution, with a real consumer

`knowledgeContributionEnabled` (migration `Phase13KnowledgeContribution`, **defaults false**) plus
`GroupKnowledgeHarvestService`, which mines opted-in groups for repeated questions that needed a
person and creates `KnowledgeCandidate` rows carrying a new `GROUP_MESSAGES` source.

A flag with no consumer would have repeated the `patternAnalysisEnabled` bug fixed in Phase 2 — a UI
toggle that silently does nothing — so the harvester was built rather than the column alone. Consent
is enforced **in the SQL**, not the caller, so no future code path can harvest a group that withheld
permission.

Proven against real rows: two groups with identical message content, one opted in and one not. The
gated query reached only the opted-in group; the ungated version reached both. Rolled back.

### 4. Support activity, day by day

`GET /support/members/:id/activity` returns each day with its groups **named**, message counts and
first/last times. UI presets: Today / Yesterday / Last 7 / Last 30 / Custom.

Verified with a fixture: a day reading `2 groups · 12 messages`, expanding to
`Admissions candidate — 9 messages · 03:00 PM–11:00 PM`. Twenty messages in one group reads as
**one** group throughout. Fixture removed afterwards.

## C–E. Database, API, frontend

- Migration `Phase13KnowledgeContribution` — one boolean, default false, partial index, reversible.
- New: `GET /support/members/:id/activity`, `POST /knowledge/candidates/harvest-groups`.
- Extended: group config/filters/serializer with `knowledgeContributionEnabled`; bulk with
  `ENABLE_/DISABLE_KNOWLEDGE_COLLECTION`.
- UI: knowledge toggle (dependent on pattern analysis, with an explanation of what it does *not*
  do), knowledge filter, two bulk actions with their own confirmation copy, day-by-day activity.

## F. AI safety

Unchanged from Phase 2 and still backend-authoritative. No change was made to the permission chain.

## L. Tests

**408 API tests / 26 suites, 21 web tests. 0 typecheck errors, 0 lint warnings.**

20 added: knowledge harvest consent (7), bounded windows (2), day-by-day grouping (5), timezone
pinning (3), plus updated group-operations assertions.

## M–N. Deployment and security

Six services healthy, prod compose valid, one-command deploy unchanged. Bundle scan: no secret
value, no internal hostname or port. Only `12000` published. The single `REDIS_KEY_PREFIX` match
remains a false positive — the value is `support-crm`, the product name, used as a DOM event key.

## O. Remaining limitations

1. **A group's AI was enabled outside my tooling.** The audit trail shows `ENABLE_MONITORING` then
   `ENABLE_AI` on "Auto SMS Test Group" at 14:58–14:59 UTC from a **browser** user agent; every
   operation I scripted is `curl`-tagged and was reverted. I have **not** reverted it — enabling AI
   on a real group is not a change to make unilaterally. No AI provider is configured, so the engine
   cannot reply regardless. Flagged for a decision.
2. **Still no live WhatsApp verification.** No message was sent to any real group. Outbound and AI
   reply paths remain **implemented but not live-verified**.
3. **Harvester not live-verified end-to-end.** Its consent gate was proven against real rows, but no
   candidate has been produced from genuine traffic — that needs a group to opt in and accumulate
   repeated questions.
4. **Responsive layout still unverified** — the browser pane reports `clientWidth: 0`.
5. **Not built:** group message filters/search (§12), dashboard support-member leaderboard and
   AI-status-with-reason (§21), monthly per-group counters (§3), and the additional filters/sorts in
   §2. These are polish on surfaces that already work, and were left rather than rushed.
6. **DST boundaries untested.** Day bucketing is pinned to the configured zone and asserted to be
   local midnight, but no test covers a DST transition. Asia/Dhaka does not observe DST, so this is
   latent rather than active.

---
---

# Phase 4 — Activity analytics, group stats, multi-account audit

Testing was explicitly skipped for this phase at the user's instruction. Typecheck, lint, builds and
real-data verification were still performed; **no test was written or executed**.

## 1. What already existed

The audit found most of the brief already implemented and reused it unchanged: the AI permission
chain and its absolute group-level veto, `TeamMemberIdentity` as Support Members, the groups
directory with server-side paging/filtering/sorting, bulk operations on the Job Center, the
knowledge candidate pipeline, `patternAnalysisEnabled` wired to the candidate detector, and the
support activity APIs including the executive day-by-day drill-down.

Two audit findings worth recording:

- **§26 multi-account is structurally safe.** `UQ_groups_account_external` on
  `(channelAccountId, externalId)` means the same WhatsApp group synced under two accounts is two
  rows with two ids. `COUNT(DISTINCT "groupId")` therefore cannot merge them. No fix was needed;
  optional account scoping was added as a *view* choice rather than a correctness patch.
- **§27 direct chats already excluded from group figures.** `groupId` is null for one-to-one
  conversations and `COUNT(DISTINCT)` ignores nulls. Confirmed live: an `AI_DISABLED` block in a
  direct chat reports `uniqueGroups: 0` while still counting as an event.

## 2. What was added

| File | Purpose |
|---|---|
| `reports/activity-analytics.service.ts` | AI/support daily + monthly series, AI block events, pattern analytics |
| `groups/group-stats.service.ts` | One-call group detail data: activity, AI, support, patterns |

New endpoints, all under the existing `/reports` and `/groups` surfaces:

- `GET /reports/ai/daily`, `/reports/ai/monthly`
- `GET /reports/support/daily`, `/reports/support/monthly`
- `GET /reports/ai/blocks` — recorded reasons the engine declined
- `GET /reports/patterns` — detector output with summary
- `GET /groups/:id/stats`

All accept an optional `channelAccountId`. Groups list gained `hasAiActivity` /
`hasSupportActivity` filters and `createdAt`, `lastAiActivityAt`, `lastSupportActivityAt` fields.

**On endpoint naming:** the brief suggested `/analytics/ai/daily`. These live under `/reports`
instead, because that module is already the read-only aggregation surface with its own guards, DTO
and pagination conventions — a parallel `/analytics` namespace would be exactly the second API style
§30 forbids. The frontend client exposes them as `activityAnalytics.*`.

## 3. Business rules

- **Replies and unique groups are never interchangeable.** Verified live: August shows **7 AI
  replies across 1 unique group**, not 7 groups.
- **AI blocks are recorded, not inferred.** Every entry is a `decision_logs` row the engine wrote
  when it declined. Live: 9 `MONITORING_DISABLED` across 3 groups, 1 `AI_DISABLED`.
- **`uniqueMembers` counts people, not messages**, derived from the identity breakdown so the two
  cannot disagree.
- **Pattern totals come from window functions**, not the length of the capped page — otherwise
  "detected" would silently understate past 25.

## 4. Performance

`lastAiActivityAt` / `lastSupportActivityAt` are all-time maxima and are deliberately **not** in the
main list query. Computing them there would reintroduce the per-group aggregate over full history
that measured 191ms per page at 3,000 groups. They are one extra query over the page's ids only —
two queries, never N+1, answered from the existing `(groupId, classification, sentAt DESC)` index.
Measured 23–51ms at page size 100.

Activity filters use `EXISTS`, which stops at the first matching row rather than counting every
message a group ever received.

**No index was added this phase** — the existing ones already serve these access paths.

## 5. Status

| Check | Result |
|---|---|
| API typecheck | 0 errors |
| Web typecheck | 0 errors |
| API lint | 0 warnings |
| Web lint | 0 warnings |
| Production build (web + api) | PASS |
| Docker build (all 5 images) | PASS |
| Compose validation | PASS |
| Migration `Phase13KnowledgeContribution` | applied |
| Existing endpoints (13 checked) | all HTTP 200 |
| Orphan outbound messages | 0 |
| Secrets / internal hosts in bundle | none |
| Public ports | only `0.0.0.0:12000` |

The Docker build failed once on a transient `puppeteer browsers install chrome@…` download in the
gateway image. The gateway was not modified this phase; a retry succeeded and all five images now
build.

## 6. Not implemented, and why

- **No tests written or run.** Skipped at the user's instruction. This means the AI-safety tests
  §23 requires were not added, and the existing 408 were not executed. Test files were not modified
  (0 changed), but I cannot assert they still pass.
- **Group message filters/search** (§12) and the dashboard leaderboard remain unbuilt — UI surfaces,
  and another agent owns UI.
- **Cursor/keyset pagination** (§4) — the existing offset pagination measured 72ms at a deep offset
  across 3,000 groups, so the added complexity was not justified by a measurement.

## 7. Requires manual verification

- No WhatsApp message was sent. Ingestion, classification and AI gating remain **implemented and
  previously verified, but not re-verified live this phase**.
- The knowledge harvester's consent gate was proven against real rows in an earlier phase; it has
  still never produced a candidate from genuine traffic.
- A group's AI was enabled from a browser session outside my tooling (flagged in Phase 3, still
  unreverted).
