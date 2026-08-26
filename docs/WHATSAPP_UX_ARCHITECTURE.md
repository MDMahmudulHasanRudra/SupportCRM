# WhatsApp UX Architecture

> How a Support CRM administrator connects a WhatsApp account, and where the boundary between
> Support CRM and the internal OpenWA gateway sits.
>
> Companion documents: `docs/adr/0001-track-a-openwa-gateway-foundation.md` (why OpenWA),
> `docs/GATEWAY_VALIDATION_REPORT.md` (what the real gateway actually does).

---

## 1. The rule

**OpenWA is internal infrastructure. Support CRM is the only user-facing application.**

An administrator never opens the OpenWA dashboard, never sees its port, never enters its API key,
never creates a session by hand, and never configures a webhook. They log into Support CRM, click
**Connect WhatsApp**, scan a QR code with their phone, and the account is connected.

Everything OpenWA-shaped lives behind one seam.

---

## 2. Layers

```
┌────────────────────────────────────────────────────────────┐
│  Admin browser                                             │
│    Support CRM UI — login, WhatsApp Accounts, Connect flow  │
│    Knows: accountId, status, phoneNumber, qr, expiresAt     │
│    Never sees: gateway URL, API key, session UUID, raw errs │
└───────────────┬────────────────────────────────────────────┘
                │ session cookie (httpOnly) · REST + Socket.IO
┌───────────────▼────────────────────────────────────────────┐
│  Support CRM API                                           │
│    channel/          neutral: accounts, states, capabilities│
│    crm/ messaging/   neutral domain                         │
│    realtime/         normalized events                      │
└───────────────┬────────────────────────────────────────────┘
                │ ChannelAdapter — a neutral interface
┌───────────────▼────────────────────────────────────────────┐
│  modules/channel/whatsapp/   ← THE ONLY OpenWA-AWARE CODE   │
│    OpenWaClient      URLs, X-API-Key, timeouts              │
│    WhatsAppAdapter   session UUIDs, JIDs, payload shapes    │
└───────────────┬────────────────────────────────────────────┘
                │ HTTP (X-API-Key) ▲ webhook (HMAC)
┌───────────────▼────────────────────────────────────────────┐
│  OpenWA gateway — internal, not published, not linked to    │
└────────────────────────────────────────────────────────────┘
```

The boundary is enforced by an ESLint `no-restricted-imports` rule: nothing outside
`modules/channel/whatsapp/` may import the gateway client, its contracts, or its mappers. It has
already caught three real violations.

---

## 3. API-key ownership

The gateway API key is **infrastructure credential, not application configuration**.

| Property | Rule |
|---|---|
| Source | `OPENWA_API_KEY` environment variable only |
| Reachable from | `OpenWaClient` and nothing else |
| In an API response | never |
| In the admin UI | never — there is no field for it |
| In a websocket payload | never |
| In an audit row | never |
| In a log line | never — errors log the path and status, not the header |
| Rotatable by an admin | no; it is a deployment change |

**Deliberately removed:** the key was previously also readable from a `openwa.api_key` settings row,
which meant an administrator with `settings.manage` could set it through the API. That is a
user-facing path to an infrastructure credential, so it is gone. `SettingsService` now refuses that
key outright, and the refusal is tested.

The same reasoning applies to per-account **webhook secrets**: generated server-side, stored
AES-256-GCM encrypted and bound to the account id by AAD, never returned by any endpoint.

---

## 4. Connection lifecycle

Nine normalized states. The first seven are `ChannelConnectionState` in the database; the last two
describe transitions the UI needs to show and are derived, never stored.

| State | Meaning | What the admin sees |
|---|---|---|
| `DISCONNECTED` | No live session | "Not connected" |
| `CONNECTING` | Session starting, no QR yet | "Starting…" |
| `QR_REQUIRED` | A QR is waiting to be scanned | The QR, with a countdown |
| `CONNECTED` | Paired and live | "Connected ✓" with the number |
| `DISCONNECTING` | Stop in progress | "Disconnecting…" |
| `ERROR` | The gateway reported a failure | "WhatsApp connection could not be started." |
| `UNKNOWN` | The gateway could not be reached | "Connection status unavailable." |
| `AUTH_FAILURE`¹ | The pairing was revoked from the phone | "This account needs to be linked again." |
| `RECONNECTING`¹ | An automatic recovery is in progress | "Connection is being restored…" |

¹ Derived. `AUTH_FAILURE` is `ERROR` where the gateway's reason indicates a logout or revoked
pairing; `RECONNECTING` is `CONNECTING` on an account that has connected before. Both are computed
at the presentation edge so the stored state machine keeps its seven values and no migration is
needed to describe a transition.

### The happy path

```
Admin clicks "+ Connect WhatsApp", types a name
        │
        ▼
POST /channels/whatsapp/accounts/connect          ← ONE call
        │  registers the account row (externalName = the chosen name)
        │  finds-or-creates the gateway session   → learns its UUID
        │  starts the session
        │  provisions the webhook with a fresh per-account secret
        ▼
status = QR_REQUIRED,  socket: whatsapp.account.qr_ready  (QR + expiresAt)
        │
        │  the gateway pushes a fresh session.qr every ~20s;
        │  each one is relayed to the same private room
        ▼
Admin scans with WhatsApp → Linked Devices
        │
        ▼
gateway session.authenticated → socket: whatsapp.account.status_changed (CONNECTED)
        │  QR is dropped, group sync is queued
        ▼
Connected ✓   — no page refresh at any point
```

---

## 5. QR lifecycle

A QR is a **credential**: whoever holds it can pair a device to the customer's WhatsApp account. It
is treated accordingly.

| Rule | Where |
|---|---|
| Never persisted | no column, no cache, no `provider_events` retention of it |
| Never logged | `redact()` and explicit omission in the adapter |
| Never audited | the audit row records that a QR was *viewed*, not its contents |
| Never broadcast | see below |
| Dropped on connect | the room is closed when the account reaches `CONNECTED` |

### Targeted delivery, not broadcast

Ordinary channel events go to `channel:<id>` and a `channel:all` firehose. **The QR does not.** It
is emitted only to `channel-qr:<accountId>`, a room that requires `channels.manage` to join — the
same permission the REST QR endpoint requires. An operator with read-only access sees the *status*
change to `QR_REQUIRED` and never receives the payload.

### Rendered or raw — the `format` field

This gateway does not send a pairing *string*; it sends the code **already drawn to a PNG**, as a
`data:` URL. Re-encoding that string into a second QR produces an unscannable mess, which is exactly
what happened the first time the flow ran against the real gateway.

Deciding which it is belongs to the adapter, not the browser — the browser is not allowed to know
what kind of gateway is behind the API. So `PairingPayload` carries a `format` of `image` (show it
as-is) or `text` (encode it), and both the websocket payload and `GET /accounts/:id/qr` carry the
same field. The client keeps an encoder for the `text` case; other engines, and older builds of this
one, emit raw payloads.

### Refresh and expiry

WhatsApp rotates the QR roughly every 20 seconds and the gateway emits a new `session.qr` each time.
Support CRM relays what arrives, stamped with an `expiresAt`, so the UI can dim the code and say
*"Refreshing the code…"* while it waits for the next push.

The open dialog also re-reads `GET /accounts/:id/qr` on a 12-second timer. That is a floor under the
push path, not a replacement for it: a socket that drops mid-pairing would otherwise leave an
operator staring at an expired code with no way to tell, and a stale QR looks exactly like a working
one until they have already tried to scan it. The timer runs only while the dialog is open.

---

### Cross-process delivery

Every one of these events is produced by the **worker**, and the operator's socket lives on an **API**
process. Socket.IO delivers only to sockets connected to the emitting process, so the two are joined
by `RedisIoAdapter`, installed in both run modes (`redis-io.adapter.ts`). Without it the UI connects,
subscribes, acknowledges — and silently receives nothing.

Redis is a transport here, not a source of truth: an event nobody is connected to receive is dropped,
and the durable record is the row the processor already wrote to PostgreSQL.

The gateway serves the `/realtime` namespace, not the default one. A client that connects to `/`
completes the transport handshake and then receives nothing, because the handlers are not there.

---

## 6. Session lifecycle — the UUID/name distinction

This is the defect real-gateway validation found, and it must not regress.

| Concept | Column | Chosen by | Used for |
|---|---|---|---|
| Session **name** | `channel_accounts.externalName` | the operator | `POST /api/sessions {name}` — the only route that takes it |
| Session **id** | `channel_accounts.externalId` | the gateway | **every** `/api/sessions/{sessionId}/…` route, and the webhook envelope's `sessionId` |

Every `{sessionId}` route validates the parameter as a UUID; passing the name yields
`400 "Validation failed (uuid is expected)"`. `externalId` is nullable because an account
legitimately exists before its session does — registration records the intent, `connect()` learns
the id.

A single private accessor, `WhatsAppChannelAdapter.gatewaySessionId()`, is the only way to obtain a
path parameter. It throws rather than substituting the name. The test stub enforces the same rule.

---

## 7. Reconnect lifecycle

```
Admin clicks Reconnect
        │  (under the account's Redis lock — concurrent attempts get a clear 409)
        ▼
stop  (already stopped is fine — the goal is "running", not "was stopped by me")
        ▼
start  ── 400 "already started" or 504 while Chromium boots?
        │      re-read the session; if it is live, that is the truth
        ▼
QR_REQUIRED (pairing survived → usually straight to CONNECTED) or a fresh QR
```

Reconnect never calls `logout`. Logout destroys the device pairing and would cost the customer a
re-scan; it is deliberately not exposed by any endpoint.

Background recovery is separate: the channel-maintenance sweep polls every owned account every 60
seconds and records what the gateway actually reports. An unreachable gateway yields `UNKNOWN`,
never `DISCONNECTED` — the distinction matters, because `DISCONNECTED` asserts something about the
WhatsApp session and we have learned nothing about it, only that we could not ask.

---

## 8. Failure states and what the admin is told

Gateway detail never reaches the browser. Each internal condition maps to one sentence.

| Internal condition | Message shown |
|---|---|
| Gateway unreachable / connection refused | "WhatsApp service is temporarily unavailable. Please try again shortly." |
| Gateway timed out starting a session | "Starting WhatsApp is taking longer than usual. This can take up to a minute." |
| Session start rejected | "WhatsApp connection could not be started." |
| QR expired, awaiting the next | "QR code expired. Generating a new QR…" |
| Session disconnected | "WhatsApp disconnected." |
| Automatic recovery under way | "Connection is being restored…" |
| Pairing revoked from the phone | "This WhatsApp account needs to be linked again." |
| Gateway autoreply rules detected | "This WhatsApp session has its own auto-reply rules enabled. Disable them before connecting, or customers will receive duplicate replies." |
| Account ownership disabled | "Support CRM is not managing this account. Enable it in settings first." |

Never surfaced: stack traces, the gateway URL or port, the API key, Docker errors, session UUIDs, or
any OpenWA type name.

---

## 9. Security boundaries

| Boundary | Enforcement |
|---|---|
| Only the adapter knows OpenWA | ESLint `no-restricted-imports`, plus review |
| API key is environment-only | `SettingsService` refuses the key; only `OpenWaClient` reads it |
| Webhook authenticity | HMAC-SHA256 over the raw bytes, constant-time, shape-checked before decode |
| Webhook freshness | replay window over the signed timestamp |
| Webhook identity | the envelope's `sessionId` must match the account whose secret verified it |
| QR confidentiality | private room gated on `channels.manage`; never stored, logged or audited |
| Secrets at rest | AES-256-GCM with per-account AAD binding |
| Every mutating route | RBAC-gated and audited with before/after |
| Realtime payloads | identifiers and state only — no message bodies, no phone numbers, except the QR room |
| Untrusted input | group names, display names, filenames, MIME types sanitised at the adapter boundary |

### What the browser is allowed to receive

```jsonc
{ "accountId": "…", "status": "QR_REQUIRED", "phoneNumber": "8801…", 
  "qr": "2@…",          // only in the channels.manage-gated QR room
  "expiresAt": "…" }
```

And nothing else about the gateway.

---

## 10. The OpenWA dashboard

It stays available for development, diagnostics and infrastructure administration. It is **not** part
of any Support CRM workflow: not embedded, not linked to, not redirected to, and not required for
any administrator task. Its compose service is separate and publishes on `127.0.0.1` only.
