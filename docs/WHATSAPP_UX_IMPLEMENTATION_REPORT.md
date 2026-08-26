# WhatsApp UX Implementation Report

**Scope:** make Support CRM the only application an administrator ever touches to connect WhatsApp.
Phases 1–3 were not rewritten, no second WhatsApp architecture was created, and no second realtime
system was created. Phase 4 was not started.

Companion documents: `docs/WHATSAPP_UX_ARCHITECTURE.md` (the design), `docs/adr/0001-…` (why the
adapter boundary exists), `docs/PHASE_2_REPORT.md` (the adapter this builds on).

---

## 1. Audit — what already existed

Read-only inspection, before any change was made.

| # | Area | Finding |
|---|---|---|
| 1 | Frontend application | **None.** `apps/` contained only `api`. No login screen, no dashboard, no page of any kind. |
| 2 | WhatsApp Accounts page | Did not exist. |
| 3 | Connect flow | Did not exist as a flow. Two separate REST calls (`POST /accounts`, then `POST /accounts/:id/connect`) with no UI. |
| 4 | QR delivery to a user | **Missing end to end.** `session.qr` webhooks were ingested and moved the account to `QR_REQUIRED`, but the payload was dropped. Nothing carried it to a browser. |
| 5 | REST QR endpoint | Existed (`GET /accounts/:id/qr`), returning `{state, qrCode, available}`. Reachable only with a hand-made HTTP request. |
| 6 | Realtime infrastructure | Socket.IO gateway with cookie auth and room scoping existed (Phase 1) — and **no client, and no cross-process delivery** (see §3.7). |
| 7 | Gateway API key | Read from config **or** from the `openwa.api_key` setting, which any admin could write through `PUT /settings/:key`. |
| 8 | Key exposure in responses | No endpoint returned the key. `GET /settings` masked secret values. |
| 9 | Session UUID exposure | `externalId` — the gateway's session UUID — **was returned** by both account serializers. |
| 10 | UUID/name separation | Correct in the database since `1787150000000-FixGatewaySessionIdentity`. `externalName` (operator's name) and `externalId` (gateway UUID) are distinct columns. |
| 11 | Connection states | Seven stored states, correct. No distinction between a revoked pairing and an ordinary error, and none between a first connection and a recovery. |
| 12 | Error surfaces | Gateway errors reached the HTTP response with route, status, host and port in the message. |
| 13 | Webhook provisioning | Fully automatic already — the adapter registers the callback and mints a per-session secret. Nothing for an admin to configure. |
| 14 | Account list data | `GET /accounts` returned status only. No group count, no last activity, no phone number in one call. |
| 15 | Gateway automation guard | Present and enforced (`WhatsAppAutomationGuard`), refusing to connect a session with its own autoreply rules. |
| 16 | Adapter boundary | Enforced by ESLint; only `channel/whatsapp/**` may import the gateway client. |

**The headline finding:** the backend was substantially ready; the product had no user interface at
all, and the QR — the one thing the whole flow exists to deliver — had nowhere to go.

---

## 2. What was built

### 2.1 The operator console (`apps/web`) — new

A Vite + React + TypeScript application. Small on purpose: the pages that exist are the ones this
task needs, and no placeholder screens were added for later phases.

| File | Purpose |
|---|---|
| `src/api/client.ts` | The only way the app talks to a server. Typed calls, error messages already phrased for humans. |
| `src/api/realtime.ts` | One Socket.IO connection, `/realtime` namespace, cookie-authenticated, shared by every page. |
| `src/auth-context.tsx` | Who is signed in. No token in `localStorage` — the session is an `httpOnly` cookie. |
| `src/app.tsx` | Routing and the shell. |
| `src/pages/login.tsx` | Sign in. |
| `src/pages/dashboard.tsx` | "Is WhatsApp working?", and a link to the page that fixes it. |
| `src/pages/whatsapp-accounts.tsx` | The accounts table and its actions. |
| `src/components/connect-dialog.tsx` | Connect / re-link, live QR, waiting → connecting → connected. |
| `src/components/status-badge.tsx` | Status as a glance; the sentence comes from the API. |
| `eslint.config.js` | Lint, including a rule that fails the build if frontend code names the gateway. |

The flow the user asked for, working: **Login → Dashboard → WhatsApp Accounts → + Connect WhatsApp →
name it → QR appears → "Open WhatsApp on your phone / Go to Linked Devices / Scan this QR code" →
"Waiting for scan…" → connected.** No page refresh at any point.

### 2.2 Backend gaps closed

| Change | File |
|---|---|
| QR extraction from the `session.qr` event, with an expiry and a rendered/raw `format` | `whatsapp.adapter.ts`, `channel-adapter.interface.ts` |
| QR relayed to a private per-account room; room closed on connect | `inbound.processor.ts`, `realtime.gateway.ts` |
| `subscribe:qr` socket handler, gated on `channels.manage` | `realtime.gateway.ts` |
| **Cross-process realtime delivery** — `RedisIoAdapter`, installed in both run modes | `redis-io.adapter.ts`, `main.ts`, `worker.ts` |
| One-call `POST /accounts/connect` (register + connect) | `whatsapp.controller.ts` |
| `GET /accounts/overview` — every column the page shows, one grouped query, no N+1 | `whatsapp.controller.ts` |
| Presentation states (`AUTH_FAILURE`, `RECONNECTING`) and human sentences | `whatsapp-presentation.ts` |
| Gateway errors shaped into sentences before they leave the API | `whatsapp-presentation.ts`, `whatsapp.controller.ts` |
| Gateway API key is environment-only; the settings route refuses it | `openwa.client.ts`, `settings.service.ts` |
| Session UUID removed from every API response | `whatsapp.controller.ts`, `channel.controller.ts` |
| `express` declared as a direct dependency (it is imported directly) | `apps/api/package.json` |

**Database changes: none.** No migration was needed or written.

---

## 3. Defects found by running it for real

Six, all fixed. The last three were invisible to a 341-test suite and only appeared when a browser
was pointed at a live gateway.

**3.1 The API key could be overridden from the UI.** A stale `openwa.api_key` setting silently beat
the environment. Now `SettingsService.set()` refuses `INFRASTRUCTURE_ONLY_KEYS` — **including for a
super admin**, because this is an infrastructure boundary, not a permission.

**3.2 The gateway session UUID leaked into API responses.** Removed from both serializers. A test
now asserts it appears in no response.

**3.3 Gateway internals reached the operator.** Routes, ports, hosts and stack frames were passed
through in error messages. `toUserFacingError()` maps them to sentences; the default for an
unrecognised error is deliberately vague, since that is the case most likely to carry an internal.

**3.4 The QR had no delivery path.** Extracted, formatted, and pushed to `channel-qr:<id>`.

**3.5 The pairing code was double-encoded.** The gateway sends the QR **already rendered as a PNG
data URL**, not a raw string. The client re-encoded it into a second QR and threw *"The amount of
data is too big to be stored in a QR Code"* — an empty frame and a spinner, forever. Fixed by
carrying a `format` discriminator from the adapter (which is allowed to know what the gateway does)
through to the client (which is not).

**3.6 Realtime events never crossed processes.** `@socket.io/redis-adapter` was a declared
dependency that was **never wired**. Every realtime event in Support CRM is produced by the worker;
every browser connects to an API process. Nothing the worker emitted had ever reached a client —
not connection states, not message events, not the QR. The UI connected, subscribed, received an
acknowledgement, and then silently received nothing. Fixed with `RedisIoAdapter` in both run modes;
confirmed by watching the broadcasts on Redis and then watching the code change in the browser.

This one is worth flagging beyond this task: it means **no realtime feature has ever worked in a
deployed configuration**, and nothing in the test suite would have caught it, because the
integration tests exercise a single in-process app.

---

## 4. Security review

| Requirement | How it is met | Test |
|---|---|---|
| Key never returned by an API | Read from config only; no endpoint serialises it | asserted across 7 endpoints |
| Key never in frontend state or JavaScript | Frontend has no concept of it; lint rule forbids naming the gateway | built bundle scanned: 0 hits for `openwa`, `2785`, `api-key`, `apiKey` |
| Key never logged | `redact()` plus explicit omission | existing Phase-1 tests |
| Key never in a websocket payload | Not present in any emitted event | — |
| Key never in an audit log | — | asserted |
| Key never shown in an admin UI | The settings route rejects the key outright | asserted, including for super admin |
| QR is not a broadcast | Private room, `channels.manage` to join | asserted: absent from the firehose |
| QR never persisted / audited | — | asserted |
| Session UUID never leaves the API | Removed from serializers | asserted |
| Gateway internals never surface | `toUserFacingError()` | asserted against a hostile error containing a URL, port, key and stack frame |
| Authorization unchanged | Same permissions as the REST endpoints, on the socket too | read-only operator denied the QR |

The OpenWA dashboard is neither embedded nor linked. Support CRM never redirects to it.

---

## 5. Tests

**Added:** 13 unit (`whatsapp-presentation.spec.ts`) + 29 integration
(`whatsapp-connect-ux.integration-spec.ts`), covering the connect flow, API-key confinement, session
UUID confinement, QR lifecycle and expiry, reconnect, and connection state transitions.

**No existing test was deleted, skipped or weakened.**

| Gate | Result |
|---|---|
| `tsc --noEmit` (api) | pass |
| `tsc --noEmit` (web) | pass |
| ESLint (api) | pass |
| ESLint (web) | pass |
| Unit — 10 suites | **154 passed** |
| Integration — 6 suites | **187 passed** |
| `vite build` | pass; bundle scanned for gateway strings, 0 hits |

### Live verification against the real gateway

Run against the isolated validation gateway with a throwaway session. **No production WhatsApp
account was involved and nothing was scanned with a real phone.**

| Activity | Result |
|---|---|
| Start the app, sign in | pass |
| Dashboard renders, shows account health | pass |
| WhatsApp Accounts page renders every column | pass |
| "+ Connect WhatsApp" creates the account and starts the session | pass — session created by name, addressed by UUID |
| Webhook provisioned automatically | pass — no admin input |
| QR appears in the UI | pass, after fixing 3.5 |
| QR refreshes without a page reload | pass — 7 distinct codes in 80 s, after fixing 3.6 |
| Status changes without a page reload | pass — disconnect reflected live in the table |
| Instructions shown next to the code | pass |
| Error text carries no gateway detail | pass |

**Not verified live:** the transition to `CONNECTED` and the success screen, which need a real phone
to scan a real code. The path is covered by integration tests
(`closes the QR room once the account connects`, `whatsapp.account.connected`).

---

## 6. Limitations

1. **The success state has not been seen with a real phone.** Scanning is a human act; the code path
   is tested, the experience is not.
2. **The console is not yet served in production.** `apps/web` builds to static files; no Docker
   service or reverse-proxy entry was added, since the brief was development/test mode.
3. **The web app has no automated UI tests.** It was verified by driving a real browser against a
   real gateway, which found two defects — but that is a manual gate, not a repeatable one.
4. **`RedisIoAdapter` has no integration test**, for the reason it was missed in the first place: the
   harness runs one process. Proving it needs a two-process test.
5. **A dropped socket is not surfaced to the operator.** The pairing dialog is covered by its REST
   fallback; the accounts table would quietly stop updating. A connection indicator is worth adding.
6. **The websocket upgrade fails in the sandboxed test browser** and falls back to long-polling. The
   fallback works; the upgrade should be re-checked in an ordinary browser.
