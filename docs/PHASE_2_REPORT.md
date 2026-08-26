# Phase 2 — WhatsApp Channel: completion report

> Date: 2026-08-23 · Track A (`docs/adr/0001-track-a-openwa-gateway-foundation.md`)
> Every claim below was executed and observed. Nothing is reported from intent.
> Phase 1 was not redesigned; three defects found in it are listed at §4.

---

## 1. Implementation summary

Phase 2 builds the WhatsApp channel between Support CRM and the vendored OpenWA gateway: a
normalized, observable, idempotent messaging foundation that Phase 3+ can depend on. It does **not**
implement AI, RAG, automation rules, the decision engine, escalation, or support-activity scoring
(brief §24) — only the interfaces, events and data those will read.

What now works end to end: a WhatsApp account is registered and driven through a normalized
connection lifecycle; its webhook is provisioned with a per-account HMAC secret; signed deliveries
are verified, deduped, persisted and queued; the worker normalizes and classifies messages, applies
delivery receipts, and tracks session state; groups and participants synchronize (paginated, and
per-group through the Job Center); and every outgoing message passes through one control point,
gets rate-limited and re-validated, and is sent by exactly one consumer.

---

## 2. Architecture

```
WhatsApp ↔ OpenWA gateway (own process, own DB, own API key)
     │ webhook POST (HMAC over raw bytes)        ── ingress
     ▲ REST /api/sessions/{id}/…  (X-API-Key)    ── egress
     │
  ┌──┴────────────────────────────────────────────────────────────┐
  │ modules/channel/whatsapp/  ← the ONLY code that knows OpenWA  │
  │   OpenWaClient · WhatsAppChannelAdapter · mappers · signature │
  └──┬────────────────────────────────────────────────────────────┘
     │  ChannelAdapter (neutral) via ChannelRegistryService
     ▼
  ingestion → verify · dedupe · persist · enqueue · 200   (nothing heavy)
     ▼ message-incoming queue
  InboundProcessor → normalize · classify · persist · receipts · session state
     ▼
  messages · groups · group_participants · provider_events

  MessageService (the single outbound control point)
     ▼ message-outgoing queue
  OutboundProcessor → re-validate · rate-limit · adapter.send() · record
```

**Layer separation.** Business code speaks `channelAccountId`, `externalConversationId` and
`NormalizedInboundMessage`. Gateway vocabulary — sessions, chat ids, JIDs, `IncomingMessage`,
`message.ack` — stops at the adapter. `channel-adapter.interface.ts` does not contain the word
"WhatsApp", which is the test of whether the seam is in the right place.

**Enforcement.** An ESLint `no-restricted-imports` rule blocks `**/channel/whatsapp/**` and the
gateway packages from every other directory. It is not decorative: it caught three real violations
during this phase (§4).

---

## 3. OpenWA contracts verified

Read from the vendored source at `gateway/` (v0.23.1) and from its checked-in `openapi.json`.
Nothing below was inferred; the full record is in `docs/adr/0001` §2 and
`src/modules/channel/whatsapp/openwa.contracts.ts`.

| Contract | Verified value | Source |
|---|---|---|
| Session status | `created \| initializing \| qr_ready \| authenticating \| ready \| disconnected \| action_required \| failed` | `openapi.json` `GET /api/sessions/{id}` |
| Delivery status | `pending \| sent \| delivered \| read \| failed` | `engine/interfaces/whatsapp-engine.interface.ts:513` |
| Webhook envelope | `{ event, timestamp, sessionId, idempotencyKey, deliveryId, data }` | `webhook-delivery.service.ts:25` |
| Webhook headers | `X-OpenWA-Event`, `-Idempotency-Key`, `-Delivery-Id`, `-Retry-Count`, `-Signature` | `webhook-delivery.service.ts:385–390, 453–457` |
| Signature | `sha256=<hex>`, HMAC-SHA256 over the **exact serialized body** | `webhook-delivery.service.ts:784` |
| `message.received` payload | `IncomingMessage` — incl. `author` (real sender in groups), `mentionedIds`, `media`, `quotedMessage`, `isStatusBroadcast` | `whatsapp-engine.interface.ts:86` |
| `message.ack` payload | `{ id, messageId, status, ack }` (`ack` is deprecated; read `status`) | `message-projector.service.ts:517` |
| Send | `POST …/messages/send-text\|reply\|send-image\|send-document` → `{ messageId, timestamp }` | `openapi.json` |
| Groups | `GET …/groups?limit&offset` → `[{id,name}]`; `GET …/groups/{id}` → `+description, owner, isAnnounce, participants[]` | `openapi.json` |
| Webhook registration | `POST …/webhooks {url, events, secret, retryCount}` | `openapi.json` |
| Automation rules | `GET …/automation-rules` → `[{id,name,enabled,replyText,…}]` | `openapi.json` |
| Auth | `X-API-Key`; roles `admin \| operator \| viewer` | `modules/auth/entities/api-key.entity.ts` |

Two findings shaped the implementation:

- **`GET /api/sessions/{id}/status` is WhatsApp Stories, not connection status.** Connection status
  lives on `GET /api/sessions/{id}`. Using the obvious-looking route would have been silently wrong.
- **The gateway documents that a queue failure can double-POST an event** with the same idempotency
  key, and states the receiver must dedupe. That is why the guarantee is a database unique index.

---

## 4. Files changed

58 new/changed TypeScript files; 113 files and ~15,000 lines in `apps/api` in total.

| Area | Files |
|---|---|
| Channel — neutral | `channel-connection.ts`, `webhook.types.ts`, `channel-account.service.ts`, `channel-maintenance.processor.ts`, `entities/channel-connection-event.entity.ts`, extended `channel-adapter.interface.ts`, `channel-account.entity.ts`, `channel.module.ts` |
| Channel — WhatsApp (isolated) | `whatsapp/openwa.contracts.ts`, `openwa.client.ts`, `openwa.mappers.ts`, `openwa.signature.ts`, `whatsapp.adapter.ts`, `whatsapp-automation.guard.ts`, `whatsapp.controller.ts` |
| Ingestion | `ingestion.service.ts`, `webhook.controller.ts`, `entities/provider-event.entity.ts`, `ingestion.module.ts` |
| Messaging | `message-types.ts`, `message.service.ts`, `inbound-message.service.ts`, `delivery.service.ts`, `inbound.processor.ts`, `outbound.processor.ts`, `messages.controller.ts`, 3 entities, module |
| Groups | `group-sync.service.ts`, `participant-sync.handler.ts`, `groups.controller.ts`, 2 entities, module |
| Team | `team-identity.service.ts`, `team.controller.ts`, entity, module |
| Common | `common/metrics/*`, `common/http/body-parsers.ts` |
| Tests | 3 new unit specs, `test/openwa-stub.ts`, `test/whatsapp-channel.integration-spec.ts` |

**Three Phase 1 defects were found and fixed** — each surfaced by a Phase 2 test, none by inspection:

1. **BullMQ rejects a custom job id containing `:`** unless it splits into exactly three parts — a
   legacy allowance BullMQ's own source marks for removal. Phase 1's `${id}:retry:${ts}` passed only
   by accident. All job ids are now hyphen-separated.
2. **The integration harness did not mirror `main.ts`'s body parsers**, so every signed webhook was
   rejected with a 400. Parser wiring is now one shared function used by both.
3. **`JobProcessor` was not exported from `JobsModule`**, so no domain module could register a job
   handler. Exported in worker mode.

---

## 5. Migrations

One migration, `Phase2WhatsAppChannel1787100000000`, explicit SQL with a working `down()`.
**Verified reversible on the live database** by reverting and re-applying it.

**Tables (8 new):** `channel_connection_events`, `team_member_identities`, `groups`,
`group_participants`, `provider_events`, `outbound_messages`, `messages`, `message_attachments`.

**`channel_accounts` extended:** `ownershipEnabled`, `accountPhone`, `webhookExternalId`,
`webhookSecretEncrypted`; Phase 1's `ACTION_REQUIRED` status remapped to `QR_REQUIRED` in both
directions.

**Constraints that carry the guarantees** — all confirmed present in the running database:

| Index | What it guarantees |
|---|---|
| `UQ_messages_account_external` on `(channelAccountId, externalId)` | **Duplicate webhook delivery can never create two messages.** The brief's §5 requirement. |
| `UQ_provider_events_account_key` on `(channelAccountId, providerIdempotencyKey)` | One logical event per provider delivery, across replicas |
| `UQ_outbound_idempotencyKey` (partial) | A retried send request cannot message a customer twice |
| `UQ_team_identity_channel_phone` | One number cannot be claimed by two team members |
| `IDX_messages_body_fts` (GIN, `simple`) | Message search without Elasticsearch; `simple` not `english` because traffic is Bangla + English |
| `IDX_groups_name_trgm` (GIN) | Group search stays indexed across thousands of rows |

---

## 6. API endpoints

All under `/api/v1`, all RBAC-enforced, all in OpenAPI except the webhook.

| Method | Route | Permission |
|---|---|---|
| POST | `/channels/whatsapp/accounts` | `channels.manage` |
| POST | `/channels/whatsapp/accounts/:id/connect` | `channels.manage` |
| GET | `/channels/whatsapp/accounts/:id/qr` | `channels.manage` |
| POST | `/channels/whatsapp/accounts/:id/disconnect` · `/reconnect` | `channels.manage` |
| POST | `/channels/whatsapp/accounts/:id/ownership` | `channels.manage` |
| GET | `/channels/whatsapp/accounts/:id/health` | `channels.read` |
| GET | `/channels/whatsapp/accounts/:id/connection-events` | `channels.read` |
| POST | `/channels/whatsapp/webhook/:channelAccountId` | **public** — HMAC-authenticated |
| GET | `/channels` · `/channels/accounts` · `/channels/accounts/:id/capabilities` | `channels.read` |
| GET | `/groups` · `/groups/:id` · `/groups/:id/participants` | `groups.read` |
| POST | `/groups/sync` · `/groups/sync-participants` | `groups.update` |
| PATCH | `/groups/:id/config` | `groups.update` |
| GET | `/messages` · `/messages/:id` · `/messages/outbound/list` · `/messages/outbound/:id` | `messages.read` |
| POST | `/messages` · `/messages/outbound/:id/cancel` | `messages.send` |
| GET/POST/PATCH | `/team/identities…` | `team.manage` |

**Deliberately absent:** session `logout`. The gateway exposes it, but it destroys the device
pairing — one accidental click on a production account costs a customer a re-scan. It waits for a UI
with a real confirmation flow. No stub was shipped in its place (`PROJECT_SPEC.md` §209).

---

## 7. Queues

| Queue | Consumer | Purpose |
|---|---|---|
| `message-incoming` | `InboundProcessor` | Verified provider events → normalize, classify, persist, receipts, session state |
| `message-outgoing` | `OutboundProcessor` | The only path to `adapter.send()` |
| `channel-maintenance` | `ChannelMaintenanceProcessor` | Repeatable 60s sweep: session health, stalled-send reconciliation, payload retention |
| `job-center` | `JobProcessor` + `ParticipantSyncHandler` | Participant sync, one item per group |

All jobs are idempotent (a redelivered job finds the row already terminal and returns), retryable
(exponential backoff, durable row in Postgres), and observable (metrics + structured logs).
Processors register **only** when `RUN_MODE=worker`, so scaling the API never means sending more
messages in parallel.

The maintenance sweep is a repeatable BullMQ job with a fixed id, not a `setInterval` — with several
worker replicas an interval would run the sweep N times concurrently.

---

## 8. Real-time events

Normalized names, never the gateway's: `whatsapp.account.status_changed`,
`whatsapp.message.received`, `whatsapp.message.sent`, `whatsapp.message.delivery_updated`,
`whatsapp.group.updated`, `whatsapp.sync.started`, `whatsapp.sync.completed`, `whatsapp.error`.

A closed TypeScript union, so a typo is a compile error. Clients subscribe with `subscribe:channel`
(gated on `channels.read`) to one account or a firehose room. **Payloads carry identifiers and state
only — never message bodies, QR codes or gateway error internals**, because this is a fan-out to
every subscribed admin socket and content belongs behind an authorised fetch.

---

## 9. Security

- **Webhook**: HMAC-SHA256 over the raw bytes, constant-time compare, shape-checked before decoding
  (so `sha256=zz` cannot decode to an empty buffer and compare equal), replay window on the signed
  timestamp, and an envelope `sessionId` that must match the verifying account. A missing secret is a
  **rejection**, never a bypass. Every failure returns one opaque 401 — no enumeration oracle.
- **Secrets**: per-account webhook secrets are AES-256-GCM envelopes bound to the account id by AAD,
  so a row copied to another account will not decrypt. Never returned by any API, never logged. The
  gateway API key travels in a header and appears in no log line.
- **QR codes** are treated as credential-equivalent: returned to the authorised caller only, never
  persisted, never logged; the audit entry records that a QR was *viewed*, not its contents.
- **Untrusted input**: group names, display names, phones, message text, filenames, MIME types and
  external ids are all sanitised at the adapter boundary — control characters stripped, lengths
  capped, path traversal removed from filenames (`../../etc/passwd` → `passwd`), MIME reduced to a
  validated `type/subtype` or `application/octet-stream`.
- **SSRF**: the gateway base URL is validated at construction — scheme restricted to http/https,
  cloud metadata endpoints rejected.
- **Body size** capped at 1 MB on every route.
- **PII**: phone numbers are not written to logs or audit rows; message bodies are not audited.
  `provider_events.rawPayload` is retained 72h then nulled while the row (which provides
  idempotency) is kept.
- **RBAC** on every route; **CSRF** mitigated by `sameSite=lax` on the session cookie, and the
  webhook uses no cookie at all.

---

## 10. Tests

**254 tests, all passing.**

```
Unit         9 suites, 141 tests   (pure logic — no infrastructure)
Integration  4 suites, 113 tests   (real Postgres + real Redis + contract stub gateway)
```

New in Phase 2 — unit (78): signature verification incl. tamper, wrong secret, missing secret,
malformed hex, raw-bytes-not-reserialized, replay window · provider state/delivery/content-type/role
mapping incl. "unknown never becomes CONNECTED" · phone extraction incl. group-JID rejection ·
normalization incl. group author attribution, status-broadcast drop, mention bounding, body capping ·
sanitisers incl. path traversal and MIME coercion.

New in Phase 2 — integration (56): account registration and session-id validation · normalized state
persistence and no-history-on-repeat-poll · concurrent session-lock serialisation · signed/forged/
unsigned/tampered/replayed/mismatched-session webhooks · idempotency at 5 sequential and 8 concurrent
deliveries plus the database-level guarantee · unowned-account and unsubscribed-event handling ·
payload retention · message normalization and all five classifications · media metadata · quoted
linking · group sync incl. pagination, deactivation and never-reset-operator-config · participant
sync incl. team/account typing and the **UNKNOWN-not-CUSTOMER** guarantee · outbound queue-not-send,
adapter send, reply routing, idempotency, no-resend-on-redelivery, disconnected/unowned refusal,
emergency-stop cancellation, gateway rejection, rate-limit deferral · delivery progression and
out-of-order rejection · stalled-send reconciliation · the gateway-automation guard in all four
states · encrypted-secret storage and AAD binding.

### The test gateway is a stub, and why

The real gateway drives WhatsApp Web through Chromium and is only useful once a real account is
paired by QR. The brief (§22) forbids connecting tests to a real customer account, and ADR-0001 §12
records that two systems on one account send customers duplicate replies.

`test/openwa-stub.ts` is therefore a contract stub — but not a hand-waved mock: every route, request
shape, response shape and header is transcribed from `gateway/` source, and it signs webhooks with
the same algorithm, so signature verification is tested against a genuinely-produced signature.

**The honest limit:** this proves Support CRM speaks the gateway's documented contract correctly. It
does not prove the running gateway matches its own source. That check requires a manual pairing
against a dedicated test number — listed at §12.

---

## 11. Acceptance criteria

Each was executed and observed. No criterion is marked passed on inspection alone.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | WhatsApp account representable | ✅ | Registered on the live stack: `{"externalId":"prod-smoke","status":"DISCONNECTED","ownershipEnabled":true}` |
| 2 | Communicates with the gateway through an adapter | ✅ | `OpenWaClient` + `WhatsAppChannelAdapter`; integration tests drive connect/QR/groups/send against the contract stub |
| 3 | Connection state normalized and persisted | ✅ | 7-state lifecycle; `channel_connection_events` history; repeat polls write no row; unmapped status → `UNKNOWN`, never CONNECTED |
| 4 | Secure webhook ingestion | ✅ | 8 integration tests; live stack returns **401** to an unsigned delivery |
| 5 | Duplicate events idempotent | ✅ | 5 sequential deliveries → 4 duplicates, 1 event, 1 message; 8 concurrent → 1 event; raw SQL insert of a duplicate key rejected by the index |
| 6 | Inbound messages normalized and persisted | ✅ | 8 tests incl. group author attribution and media metadata |
| 7 | Groups synchronize | ✅ | 5 tests incl. 450-group pagination and soft deactivation |
| 8 | Participants synchronize | ✅ | 2 tests incl. team/account typing and departed-member retention |
| 9 | Team WhatsApp identities associable | ✅ | `team_member_identities`; a registered identity flips classification to `TEAM_MESSAGE` |
| 10 | Outbound uses the channel abstraction | ✅ | `adapter.send()` has exactly one caller, `OutboundProcessor`; lint rule blocks any other path |
| 11 | Outbound queued safely | ✅ | `send()` returns `QUEUED` with `stub.sentMessages` empty — nothing reached the gateway during the request |
| 12 | Delivery status normalized | ✅ | 5 tests; out-of-order `delivered`-after-`read` rejected; stalled sends reconciled |
| 13 | Redis locks work | ✅ | 3 concurrent connects → 1 succeeded, 2 got a 409; `maxConcurrent === 1` |
| 14 | Rate limiting enforced | ✅ | Second message to one conversation deferred with `scheduledAt` in the future; only 1 send reached the gateway |
| 15 | Socket.IO emits normalized events | ✅ | 8 `whatsapp.*` names, closed union, permission-gated subscribe |
| 16 | Gateway automation not used | ✅ | Client has no create/update method; guard tested in all 4 states; a full connect + webhook + sync cycle issued **zero** non-GET automation-rule calls |
| 17 | No arbitrary service can call OpenWA | ✅ | ESLint boundary; it caught 3 real violations this phase, all fixed |
| 18 | RBAC enforced | ✅ | Every route permissioned; live unauthenticated `/groups` → **401** |
| 19 | Secrets encrypted | ✅ | Stored as `v1:…` AES-256-GCM; AAD-bound (a copy to another account fails to decrypt) |
| 20 | Integration tests use real Postgres and Redis | ✅ | `docker-compose.test.yml`, isolated ports, `--runInBand` |
| 21 | No real WhatsApp account needed | ✅ | Contract stub only; zero external network calls |
| 22 | Full test suite passes | ✅ | 141 unit + 113 integration = **254 passing** |
| 23 | Typecheck passes | ✅ | `tsc --noEmit` clean |
| 24 | Lint passes | ✅ | 0 errors, 0 warnings, including the boundary rule |
| 25 | Docker build succeeds | ✅ | api, worker, migrate images built |
| 26 | Docker stack starts cleanly | ✅ | `migrate` applied Phase 2 and exited 0; api + worker + postgres + redis all `healthy` |
| 27 | Health checks pass | ✅ | `/api/v1/health` → `HEALTHY` (database 21ms, redis 16ms, queue ok) |

Additionally verified on the live database: all 8 tables present, all 6 guarantee-carrying indexes
present, and the migration **reverted and re-applied successfully**.

---

## 12. Known limitations

All deliberate and scheduled; none is an oversight.

1. **Never connected to a real WhatsApp account.** Everything is verified against a contract stub.
   Before Phase 3 depends on it, the gateway should be paired **once, manually, against a dedicated
   test number** to confirm the running gateway matches its own source.
2. **Media metadata only — no media bytes.** Downloading needs the validated upload pipeline
   (`PROJECT_SPEC.md` §126/§179). `message_attachments.storageRef` is always null.
3. **No conversations, customers, or inbox.** `Message.conversationId` exists as a nullable column
   with no FK, awaiting Phase 3.
4. **No `decision_logs`.** Mandatory per §112, lands with the decision engine in Phase 5.
5. **Group membership events do not update participants.** A `group.join` webhook carries no
   participant list; the sync remains the source of truth. The event is recorded and emitted so the
   Phase 3 UI can prompt a resync.
6. **`message.revoked` does not delete the original.** A message a customer deleted is still part of
   the support record; erasing it would break the audit trail (§127).
7. **Outbound media is modelled but untested end to end.** `send()` routes to `send-image`/
   `send-document`, but with no storage layer there is nothing real to attach yet.
8. **One channel implemented.** Messenger/Facebook/Instagram are seeded rows with `hasAdapter:false`.
9. **Metrics are in-process counters**, not a Prometheus endpoint. Every event §18 names is
   instrumented; exporting them is Phase 11 hardening.
10. **No HTTP rate limiting on the API surface** (`@nestjs/throttler` unwired). Outbound sending is
    rate-limited; inbound API throttling is Phase 11.
11. **No admin UI.** Everything is REST + WebSocket.
12. **Message search is `simple`-configuration FTS.** Adequate for Bangla + English mixed traffic;
    Phase 4 will add semantic retrieval where it belongs.

---

## 13. Phase 3 dependencies

Ready and in place:
- Normalized `messages` with a stable idempotency guarantee and a nullable `conversationId` to
  attach to.
- `MessageClassification` on every message — the input Support Activity and the decision engine need.
- `groups` with monitoring/AI/automation flags and `lastMessageAt` for inbox ordering.
- `group_participants` typed `UNKNOWN`/`TEAM_MEMBER`/`ACCOUNT`, awaiting customer matching.
- `team_member_identities` — who is internal.
- `MessageService` as the single send path, with the pre-send hook where conversation state and
  human takeover will plug in.
- Realtime transport, Job Center, locks, rate limits, metrics, audit.

Phase 3 must supply: `conversations` + participants + the state machine, `conversation_state_history`,
`customers` + `customer_contacts` and the matching layer that finally decides `CUSTOMER`, `tags`,
`support_activities`, assignment, and the Support Inbox. `Message.conversationId` gains its FK there.

**Operational prerequisite:** the manual gateway pairing at §12.1. Support CRM and the existing
production system must never hold the same WhatsApp account.

---

## 14. Commands

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
