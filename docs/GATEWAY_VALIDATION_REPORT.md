# Real-gateway validation report

> Date: 2026-08-23 · Gateway: OpenWA v0.23.1, built from `gateway/` and run in isolation
> Harness: `scripts/validate-gateway.mjs` (re-runnable)
> **Result: 12 pass, 0 fail, 9 blocked on a physical QR scan.**

---

## 1. Safety

The validation ran against a **freshly built, empty gateway instance**, isolated by construction:

- Its own named volume (`openwa_validation_data`), created empty. It contained **zero WhatsApp
  sessions** at start — confirmed by `GET /api/sessions` returning `[]` — so it could not resume,
  disturb, or even see any existing pairing.
- Published on `127.0.0.1` only.
- The production WhatsApp account was never touched. The legacy Support Message Automation system
  was never started, contacted, or modified.
- No WhatsApp account of any kind was ever paired, so no customer group was ever reachable.

`docker-compose.validation.yml` carries these constraints and is labelled validation-only.

---

## 2. Result

| # | Item | Result |
|---|---|---|
| 0 | Gateway reachable, `X-API-Key` accepted, unauthenticated rejected (401) | ✅ |
| 0b | Live OpenAPI matches every endpoint and status the adapter targets | ✅ |
| 1 | **QR pairing** | ⛔ real 6,334-char QR retrieved; scan needs a human |
| 2 | **Session connection** | ✅ session created and started on the real gateway |
| 3 | **Session status** | ✅ gateway `qr_ready` → `QR_REQUIRED`, persisted |
| 4 | **Inbound message** | ⛔ needs a paired number |
| 5 | **Webhook signature** | ⛔ webhook registered and active; no delivery yet without pairing |
| 5b | Forged and unsigned webhooks rejected (401), nothing created | ✅ |
| 6 | **Message persistence** | ⛔ needs a paired number |
| 7 | **Duplicate event handling** | ⛔ replay needs the encrypted per-account secret |
| 8 | **Group synchronization** | ⛔ an unpaired gateway has no groups |
| 9 | **Participant synchronization** | ⛔ needs a real group |
| 10 | **Outbound message** | ⛔ needs a paired session and a recipient |
| 11 | **Delivery state** | ⛔ needs a real receipt |
| 12 | **Reconnect** | ✅ stop+start; 2 transitions recorded |
| 13 | **Gateway restart recovery** | ✅ session survived; Support CRM re-established contact |
| 14 | **Support CRM restart recovery** | ✅ session cookie still authenticates; health HEALTHY |
| 15 | **Redis restart recovery** | ✅ health recovered; a new job queued and completed |
| 16 | **Concurrent processing** | ✅ 4 concurrent ops → 1 winner, 3 conflicts; 5 idempotent creates → 1 job |
| 17 | **Zero native OpenWA automation** | ✅ 0 rules; guard safe; no write call site in the image |
| 18 | **Secret redaction in logs** | ✅ ~8,000 lines scanned, no leak |

**No critical defect remains open.** Five were found and fixed (§3); the run above is post-fix.

---

## 3. Defects found and fixed

Every one was invisible to the 254-test suite, because the Phase 2 contract stub was more permissive
than the real gateway. That is the finding behind the findings.

### 3.1 CRITICAL — `{sessionId}` is a UUID, not the session name

`POST /api/sessions {name}` returns `{ id, name }` where `id` is a UUID, and **every**
`/api/sessions/{sessionId}/…` route validates the parameter as a UUID:

```
GET /api/sessions/validation-test
→ 400 {"message":"Validation failed (uuid is expected)"}
```

Phase 2 stored the operator-chosen name in `channel_accounts.externalId` and passed it everywhere.
**The entire session lifecycle was broken against the real gateway** — connect, QR, disconnect,
groups, send, webhooks — while every test passed, because the stub keyed sessions by name and
answered to either.

**Fix.** Migration `FixGatewaySessionIdentity1787150000000` splits the column: `externalName` holds
the operator's name, `externalId` holds the gateway's UUID and is nullable until a session exists.
A single private `gatewaySessionId()` accessor is now the only way to obtain a path parameter, and
it throws rather than substituting the name. `connect()` find-or-creates by name and stores the id.

This also fixed an inconsistency nobody had noticed: the webhook envelope's `sessionId` is the UUID,
so inbound lookup and outbound path construction now finally agree on one value.

### 3.2 CRITICAL — a 15 s timeout on every route

`POST /start` launches Chromium and drives WhatsApp Web to a QR. It takes tens of seconds on a
healthy host. One 15 s timeout aborted it every time and surfaced as *"the gateway is unreachable"* —
a misleading message for a gateway working exactly as designed.

**Fix.** Per-operation timeouts: 15 s for reads and sends, 60 s for bulk reads, **120 s for session
lifecycle**. A timeout now reports itself as a timeout, with the limit and the route, rather than as
unreachability.

### 3.3 HIGH — connect was not idempotent

Two ways `POST /start` fails while the session is fine:

- `400 "Session is already started"` — the caller asked for a running session and there is one.
- `504` — the gateway's own engine-init timeout elapsed while Chromium was still starting; the
  session reaches `qr_ready` moments later. Observed live on this host.

Both were treated as hard failures, so a retried or double-clicked connect broke a healthy session.

**Fix.** After any start failure, re-read the session. If it is in a live state
(`initializing | authenticating | qr_ready | ready | action_required`), report that real state.
The session is a better description of reality than the HTTP result.

### 3.4 MEDIUM — `JobsService.create` had no unique-violation catch

`MessageService.send` has handled the idempotency race since Phase 2; job creation did not. Five
concurrent creates with one key produced one job and four 500s.

**Fix.** The same insert-and-catch-23505 that returns the winner. Verified: 5 concurrent → 1 job.

### 3.5 LOW — a stale setting silently overrode the environment

`openwa.api_key` in the settings table takes precedence over `OPENWA_API_KEY`, by design. A stale
value left from Phase 2's smoke test made every gateway call 401 with nothing indicating why.

**Fix.** Not a behaviour change — the precedence is correct — but the client now warns when the two
differ, naming the source and never the key.

### 3.6 The stub was corrected too

`test/openwa-stub.ts` now generates UUIDs, keys sessions by id, treats `name` as a separate lookup
used only by `POST /api/sessions`, returns `400 "uuid is expected"` for a non-UUID path parameter,
and `409` on a duplicate name. **A stub more permissive than the system it stands in for is worse
than no stub at all** — that is the lesson this validation actually taught.

---

## 4. What is still blocked, and exactly how to finish it

Nine items need a **dedicated non-production WhatsApp number** on a physical phone. Everything is in
place; the only missing input is a human scanning a QR code.

**Never use the production account, or any number the legacy Support Message Automation system
controls.** Two systems on one account send customers duplicate replies.

```bash
docker compose -f docker-compose.yml -f docker-compose.validation.yml up -d openwa-validation
```

Get the gateway API key:

```bash
docker exec openwa-validation cat /app/data/.api-key
```

Run the harness once to create and start the session:

```bash
node scripts/validate-gateway.mjs --gateway-key "<key>" --admin-pass "<admin password>"
```

Open `http://localhost:2785` and scan the QR with the **test number**. Then re-run, adding a chat id
you control to exercise the outbound path:

```bash
node scripts/validate-gateway.mjs --gateway-key "<key>" --admin-pass "<admin password>" --send-to "8801XXXXXXXXX@c.us"
```

For item 8 and 9, add the test number to one or two throwaway test groups first.

Item 7 (duplicate replay) is blocked differently: it needs the per-account webhook secret, which
Support CRM encrypts and never returns — correctly. Pass `VALIDATION_WEBHOOK_SECRET` if you decrypt
it deliberately, or rely on the database-level unique index and the integration tests, which cover
the same guarantee.

---

## 5. Environment note

Docker Desktop on this machine has **3.7 GB** allocated. That is enough to build and run the gateway
alongside the Support CRM stack, but it is tight — the gateway build OOM-killed the running stack
once, and the 504 in §3.3 is a symptom of Chromium starting slowly under memory pressure. For the
pairing run, consider raising Docker's memory limit or stopping the API and worker while the gateway
starts.

`WEBHOOK_SSRF_PROTECT=false` is set on the validation gateway. It is a documented opt-out
(`gateway/src/common/security/ssrf-guard.ts:46`) required for delivering to an internal sidecar;
Support CRM is only reachable on the Docker network, which the guard would otherwise refuse as a
private address. It is validation-only and is not set in `docker-compose.yml`.

---

## 6. Verdict

The five defects are fixed, all 254 automated tests pass against the corrected stub, and the twelve
items that can be verified without a phone pass against the real gateway with **zero failures**.

No critical defect remains open, so Phase 3 proceeded.

The nine blocked items remain genuinely unverified. They should be completed against a dedicated
test number before any production cutover — and, given that §3.1 broke the entire session lifecycle
while every test was green, before placing much confidence in the untested paths.
