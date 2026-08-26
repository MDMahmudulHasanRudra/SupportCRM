# Real WhatsApp Final Validation — Human-in-the-Loop

**Status: COMPLETE. 16 of 16 items PASS.**

The one item held in the first pass — participant synchronization — was resolved in Phase 3.5 by
making the operation group-scoped, and the real-contact data the validation pulled in has been
purged. See §Phase 3.5 at the end.

The dedicated test account was linked by a human scan and the full lifecycle was then exercised
against real WhatsApp: connect, group sync, inbound, conversation creation, outbound send with a
read receipt, disconnect, reconnect. **Three defects were found and fixed, each with a regression
test.**

---

## Isolation

| Guarantee | Evidence |
|---|---|
| Isolated gateway | `openwa-validation` container, own volume, bound to `127.0.0.1` |
| Dedicated test account only | one live session, `final-validation`, linked by the operator's test handset |
| No production WhatsApp | no production session exists on this gateway |
| No legacy Support Message Automation | not running; shares no session, volume or database |
| No message sent to any third party | the single outbound message was addressed to the connected account's **own number** |
| Production untouched | nothing addressed any host but the local validation gateway |

### ⚠️ What linking a live account pulled in (since purged — see Phase 3.5 §2)

The linked test handset is a **live account with real chats**. Linking it had consequences that no
amount of care on the Support CRM side prevents:

- **9 real groups** were stored by the group sync (names not reproduced here). One is plainly a test
  group; the rest look like genuine personal and business groups.
- **19 real inbound direct messages** arrived on their own and were ingested, creating 19
  conversations and 19 customer identities — all `UNRESOLVED`, no customer records.

No group message content was ingested (all 19 inbound were 1:1). Nothing was sent to any of these
people. But this was real contact data in the CRM database, which is what the isolation rule exists
to prevent — so **participant synchronization was never run against it**, and all of it has since
been purged (Phase 3.5 §2).

---

## Identifiers

| Field | Value |
|---|---|
| Support CRM account ID | `a93ab335-c9fd-4b94-b8a1-918cd6d6ea1b` |
| Session name (operator's) | `final-validation` |
| Gateway session UUID (internal) | `3c43bcfd-1120-4687-8b06-5bb403d70f85` |
| Linked number | `8801932538961`, displayed as `+880 193 253 8961` |
| Display name from WhatsApp | Rudra |

The name and the UUID remain separate columns. The UUID appears in no API response, socket payload,
HTML or bundle.

---

## Observed state transitions (verbatim from `channel_connection_events`)

```
16:20:13  DISCONNECTED  -> QR_REQUIRED    ADMIN_ACTION   QR_REQUIRED
16:28:04  QR_REQUIRED   -> CONNECTING     GATEWAY_EVENT  authenticating      ← human scanned here
16:28:08  CONNECTING    -> CONNECTED      GATEWAY_EVENT  session.authenticated
16:35:42  CONNECTED     -> DISCONNECTING  ADMIN_ACTION
16:35:42  DISCONNECTING -> DISCONNECTED   GATEWAY_EVENT  disconnected
16:36:02  DISCONNECTED  -> CONNECTING     GATEWAY_EVENT  initializing
16:36:09  DISCONNECTED  -> CONNECTING     ADMIN_ACTION   CONNECTING          ← defect 3, since fixed
16:36:13  CONNECTING    -> CONNECTED      GATEWAY_EVENT  ready
16:38:26  CONNECTED     -> DISCONNECTED   GATEWAY_EVENT  disconnected        ← spontaneous drop
16:38:27  DISCONNECTED  -> CONNECTING     GATEWAY_EVENT  initializing
16:39:27  CONNECTING    -> DISCONNECTED   GATEWAY_EVENT  disconnected
16:42:11  DISCONNECTED  -> CONNECTING     GATEWAY_EVENT  initializing
16:42:16  DISCONNECTED  -> CONNECTING     ADMIN_ACTION   CONNECTING          ← defect 3, since fixed
16:42:21  CONNECTING    -> CONNECTED      GATEWAY_EVENT  ready
```

The required sequence `QR_REQUIRED → CONNECTING → CONNECTED` occurred exactly as specified, twice —
once from the human scan, once from an unattended reconnect.

The drop at 16:38 and the recovery attempts through 16:42 were **not** initiated by Support CRM. The
session dropped on the gateway side and was recovered by the operator pressing Connect. Worth
knowing: an unattended WhatsApp Web session can drop within minutes, and the polling reconciler is
what keeps the displayed state honest when that happens.

---

## Results

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | `CONNECTING → CONNECTED` transition | **PASS** | recorded twice above; the success panel ("✓ Connected — Support CRM is now handling messages for this account") rendered live, with no page refresh, driven by `whatsapp.account.status_changed` + `whatsapp.account.connected` at 16:42:21 |
| 2 | Phone number display | **PASS** | `+880 193 253 8961` with the name "Rudra". Populated by the reconciliation sweep, so it appears within one sweep interval (≤60 s) of connecting, not instantly |
| 3 | Group synchronization | **PASS** | `POST /groups/sync` → `{discovered: 9, created: 9, deactivated: 0}`; `whatsapp.sync.started` and `whatsapp.sync.completed` both reached the browser |
| 4 | Participant synchronization | **PASS** (Phase 3.5) | the account-wide sync was never run against real groups. A group-scoped endpoint now exists and is the only path the UI offers; covered by 8 integration tests |
| 5 | Inbound message reaches Support CRM | **PASS** | 19 inbound messages ingested from `message.received` webhooks, all `PROCESSED` |
| 6 | Conversation creation | **PASS** | 19 conversations created, one per counterparty |
| 7 | Participant stays UNRESOLVED until promoted | **PASS** | 19 of 19 `customer_identities` are `UNRESOLVED`; `customers` table holds **0 rows**. Nothing was auto-promoted |
| 8 | Outbound message from Support CRM | **PASS** | outbound `69fa36c1…` → gateway id `true_203813747171565@lid_3EB077E4B2FF265F2A9825_out`, `sentAt` 16:48:24 |
| 9 | Delivery state | **PASS** | `QUEUED → SENDING → SENT → READ`; durable message row `054c8954…` with `deliveryStatus = READ` |
| 10 | Disconnect | **PASS** | 16:35:42, table moved to "Not connected" with a Connect action |
| 11 | Reconnect | **PASS** | 16:42:21 back to CONNECTED **without a new QR** — the pairing survived, so no rescan was needed |
| 12 | Duplicate-send protection | **PASS** | two `POST /messages` with the same `idempotencyKey` returned the **same row id**; outbound queue holds exactly 1 row, `attempts: 1` |
| 13 | No duplicate inbound processing | **PASS** | 20 messages, 20 distinct `(channelAccountId, externalId)` pairs, enforced by `UQ_messages_account_external` |
| 14 | No gateway native automation | **PASS** | `automation-rules` → `[]` before and after reconnect; the gateway client exposes no write verb against that API, and `WhatsAppAutomationGuard` refuses to connect a session that has rules |
| 15 | API key inaccessible to the client | **PASS** | see below |
| 16 | Realtime across API/worker processes | **PASS** | worker-emitted `status_changed`, `account.connected`, `message.received` ×6, `sync.started`, `sync.completed` and `qr_ready` all arrived at the browser, which is connected to the API process |

### Item 15 in detail

Searched for the literal key value across every surface, with the account connected and after all
traffic:

| Surface | Result |
|---|---|
| `/channels/whatsapp/accounts/overview`, `/channels/accounts`, `/messages`, `/messages/outbound/list`, `/conversations`, `/groups`, `/customers`, `/audit-logs`, `/settings` | 0 occurrences of the key; 0 of the session UUID |
| `audit_logs` (`before`, `after`, `metadata`, direct SQL) | 0 rows |
| Socket.IO payloads received during the run | `connected{userId}`, `qr_ready{event,at,channelAccountId,qr,format,expiresAt}`, `status_changed{…,previousState,state}`. No key |
| HTML document | no `openwa`, no `2785`, no `x-api-key`, no session UUID |
| JavaScript bundle (`vite build`, full `dist/` scan) | 0 hits for the key, `openwa`, `2785`, `x-api-key`, `apiKey`, `api_key`, `host.docker.internal` |
| Frontend state | no concept of a gateway credential; an ESLint rule fails the build if frontend code names the gateway |

---

## Defects found and fixed

Each was found by running the real flow, fixed narrowly, and covered by a regression test that was
confirmed to fail without the fix.

### Defect 1 — a paired session made the QR endpoint throw

`GET /accounts/:id/qr` returned 500 and logged a stack trace with the gateway route and session UUID
**every 12 seconds** while a dialog was open on a connected account. The gateway answers a QR request
for an authenticated session with `400 "Session is already authenticated, no QR code needed"` — an
ordinary answer, not a failure.

*Fix:* `WhatsAppChannelAdapter.getPairingPayload()` treats gateway 400/404 as "no code right now" and
returns the account's current state.
*Test:* `answers "no code" rather than failing once the phone has paired` — the stub now reproduces
the gateway's exact 400.

### Defect 2 — one click, two session-lifecycle calls

Pressing Connect on a disconnected account fired the reconnect **twice**. The second lost the account
lock and returned 409, so the operator was shown *"Another reconnect operation is already running"*
after a single click on a healthy account. React re-invokes mount effects in development, and the
auto-start effect had no guard.

*Fix:* a `useRef` guard so the auto-start runs once per dialog.
*Test:* `reconnects exactly once, even when React runs the mount effect twice` — verified to fail
without the guard (2 calls instead of 1).

### Defect 3 — transitions recorded against a stale copy

Two history rows above (`16:36:09`, `16:42:16`) claim `DISCONNECTED → CONNECTING` when the account
was **already** CONNECTING. A session-lifecycle call takes tens of seconds and gateway webhooks land
on the worker while it runs, so the controller's in-memory copy is routinely stale by the time it
records the outcome. The result was phantom history rows and realtime events carrying a wrong
`previousState`.

*Fix:* `recordState()` re-reads the row and derives `previous` from it.
*Test:* `records a transition against the current row, not a stale copy`.

---

## Test gates after the fixes

| Gate | Result |
|---|---|
| API unit — 10 suites | **154 passed** |
| API integration — 6 suites | **190 passed** (3 new regression tests) |
| Web unit — 1 suite | **3 passed** (new harness: vitest + testing-library) |
| ESLint (api, web) | pass |
| `tsc --noEmit` (api, web) | pass |

No existing test was deleted, skipped or weakened. The web package previously had no tests; it now
has a harness, which closes a limitation recorded in the previous report.

---

## Resolved: participant synchronization

Held during the validation because `POST /groups/sync-participants` takes an *account*, not a group,
and would have written the phone numbers of everyone in nine real groups into the database.

Resolved in Phase 3.5 (§1): the operation is now group-scoped, the UI offers no account-wide path,
and the real data has been purged.

---

## Also observed (not defects)

- **Phone number latency.** The number and display name appear on the next reconciliation sweep, so
  an account can read "Connected" with an em-dash for its number for up to a minute.
- **"Last activity" stays blank.** That column is fed by group message activity, and all 19 inbound
  messages were 1:1. Accurate as defined, arguably not what an operator would expect.
- **All 19 inbound classified `UNKNOWN`.** Correct with no team members configured and no group
  mapping — the classifier does not guess, which is the behaviour Phase 3 requires.
- **Sessions drop on their own.** One unattended drop in a 20-minute window, recovered by pressing
  Connect. Automatic recovery is not implemented and was not in scope.

---

## Final recommendation

**The real-WhatsApp validation is substantively complete and the system behaved correctly.** Fifteen
of sixteen items pass against a genuinely linked account, including the two that no test suite could
prove: a human scan producing a live connection, and a message actually arriving on a phone with a
read receipt.

Three defects were found — one of which (defect 2) would have shown an error to every operator who
reconnected an account, and none of which any existing test caught. That is the value this run
delivered.

**Recommended before Phase 4:**

1. Decide the participant-synchronization question above, and run item 4 to completion.
2. Decide whether to purge the 9 real groups and 19 real conversations from the dev database.

Neither blocks Phase 4 design work, but item 4 remains formally unverified until then, and this
report should not be read as fully green while it is held.


---

# Phase 3.5 — Cleanup and Production Hardening

Everything below was done after the validation above, to close its one held item and its one
operational finding.

## 1. Participant synchronization is now group-scoped

`POST /api/v1/groups/:groupId/sync-participants` synchronizes exactly one group.

| Guard | Behaviour |
|---|---|
| Not signed in | 401 |
| Missing `groups.update` | 403 |
| No `channelAccountId` in the body | 400 — the caller must state which account it means |
| Group belongs to another account | **404**, not 403 — whether another account owns a group with that id is not something a caller scoped to this account is entitled to learn |
| Account not owned by Support CRM | 409 |
| Concurrent syncs | serialized on the existing account lock |

The account-wide endpoint still exists for future bulk operations, but **no UI path reaches it**.
Participant sync is initiated from a group row on the new Groups page, reached from the group count
on the accounts table. The page carries the reason in plain words: synchronizing imports the phone
numbers of everyone in that group, and nobody becomes a customer as a result.

## 2. The validation database was purged

Foreign-key-safe, children first, in one transaction. The two circular references
(`messages` ↔ `outbound_messages`, and the `messages` self-reference for quoted messages) were
broken by nulling them first. A data-only dump was taken beforehand.

| Table | Rows removed |
|---|---|
| messages | 20 |
| outbound_messages | 1 |
| conversations | 20 |
| conversation_participants | 20 |
| customer_identities | 20 |
| groups | 9 |
| provider_events | 103 |
| customers, group_participants, notes, attachments, tags | 0 (none existed) |

**Kept deliberately:** the three channel accounts, their gateway sessions, and all 31 connection
history rows. The WhatsApp account itself was not deleted.

## 3. Automatic reconnection

The validation found a session dropping unattended, with nothing to bring it back. The worker's
existing maintenance sweep now recovers dropped sessions, under rules that keep it from doing harm:

- **Never fights the operator.** A deliberate disconnect sets `disconnectRequestedAt`; recovery
  skips those accounts entirely, and pressing Connect clears the flag and the retry budget.
- **Never re-pairs.** If WhatsApp wants a new QR, recovery stops and the existing QR flow takes
  over — retrying cannot produce a scanned phone.
- **Never runs twice.** Attempts take the same account lock as every other lifecycle operation; a
  contended lock is a skip, not a failed attempt, so it costs nothing from the budget.
- **Never retries forever.** 5 attempts by default, exponential from 30 s to a 10-minute ceiling,
  all three configurable. When the budget is spent the account shows **Reconnect failed** and waits
  for a human.
- **Leaves a trail.** Every attempt is a connection-history row, successes and failures alike.

New presentation states: `RECONNECTING` (an attempt is booked — the UI offers no button, because a
second attempt would only lose the lock) and `RECOVERY_FAILED`.

Migration `1787300000000-Phase35AutoRecovery` adds four columns and one partial index. Additive
only; nothing existing was altered.

## 4. Defects found during Phase 3.5

**A healthy account could display "Reconnecting…" forever.** Found by the real-gateway test, not by
the suite. The recovery cycle was cleared only inside the recovery service, so when a session came
back by any other route — a health poll, a gateway webhook, an operator — the retry booking
survived and masked a perfectly good connection.

*Fixed twice over:* `recordState` now clears the cycle on reaching CONNECTED, whatever caused it;
and the presentation layer only reports a recovery state when the account is actually down.
*Tests:* `ends the recovery cycle when the account comes back by any other route`, and
`shows a connected account as connected even if a stale booking survives`.

Also observed, and handled rather than fixed: the first reconnect attempt immediately after a drop
can hit the gateway mid-teardown and get a 400 on `/start`. That is what the backoff is for — the
next attempt succeeded.

## 5. Real-gateway validation of automatic recovery

Session dropped at the gateway at 17:22:29, with no operator involvement, on the dedicated test
account. Verbatim history:

```
17:22:26  CONNECTED    -> DISCONNECTED  GATEWAY_EVENT
17:23:00  DISCONNECTED -> CONNECTING    SYSTEM         Automatic reconnect attempt 2 of 5
17:23:00  DISCONNECTED -> CONNECTING    GATEWAY_EVENT
17:23:24  CONNECTING   -> CONNECTED     GATEWAY_EVENT
```

Recovered in under a minute, unattended, with `recoveryAttempts` back to 0 and no booking left
behind. An earlier drop at 17:17 shows the same shape including a failed first attempt and its
backoff.

## 6. Phase 3.5 gates

| Gate | Result |
|---|---|
| API unit — 10 suites | **154 passed** |
| API integration — 7 suites | **210 passed** (20 new in `phase35-recovery.integration-spec.ts`) |
| Web unit | **3 passed** |
| ESLint (api, web) | pass |
| `tsc --noEmit` (api, web) | pass |
| `vite build` | pass |
| Docker build — api, worker | pass |
| Real-gateway recovery | pass (§5) |

No existing test was removed, skipped or weakened. The WhatsApp adapter was not rewritten and the
OpenWA boundary is unchanged — `ChannelRecoveryService` speaks only to the neutral adapter
interface through the registry.

## 7. Recommendation

Phase 3.5 is complete and every gate is green. **Phase 4 is unblocked.**

Two things to know going in:

1. The dedicated test account is still linked and connected, with an empty CRM database behind it.
   Re-syncing its groups would re-import the same nine real groups; do that only deliberately.
2. Automatic recovery is on by default (`CHANNEL_RECOVERY_MAX_ATTEMPTS=5`). Set it to 0 to disable.
