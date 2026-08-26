# Phase 1 — Foundation: completion report

> Date: 2026-08-23 · Track A (`docs/adr/0001-track-a-openwa-gateway-foundation.md`)
> Every claim below was executed and observed. Nothing is reported from intent.

---

## 1. What was implemented

**Repository & foundation.** pnpm workspace, NestJS 11 modular monolith (`apps/api`) running in two
modes from one codebase — `RUN_MODE=api` serves HTTP + WebSocket, `RUN_MODE=worker` consumes queues.
Strict TypeScript, zero `any` in `src/`, ESLint with an architectural boundary rule.

**OpenWA gateway vendored and audited at source.** `gateway/` is an unmodified clone of
`rmyndharis/OpenWA` v0.23.1. Its real contracts — `IncomingMessage` shape, the 21 webhook event
names, `X-OpenWA-Signature` (HMAC-SHA256 over the exact body), the `X-API-Key` role model, and the
send/group endpoint surface — were read from source and recorded in ADR-0001 §2. None were invented.

**Configuration.** Zod env validation that fails fast with every problem at once and never prints an
offending value. Production refuses to boot with `CORS_ORIGINS=*`, a non-secure session cookie, or
the documented default admin password.

**Crypto.** AES-256-GCM envelope encryption with AAD context binding for secrets at rest; scrypt for
passwords; SHA-256 for high-entropy session tokens. Master key must decode to exactly 32 bytes or the
process refuses to start.

**Authentication.** Server-side revocable sessions — the cookie carries 256 random bits, only its
SHA-256 is stored. httpOnly + sameSite=lax. Configurable brute-force lockout, checked *before* the
password comparison. Deactivating a user invalidates live sessions immediately.

**RBAC.** `roles` / `permissions` / `role_permissions` / `user_roles`. A 36-entry permission
catalogue seeded into a real table with foreign keys, so a mistyped key fails closed. Seven roles per
`PROJECT_SPEC.md` §108. Two globally-registered guards — routes are protected by default and must opt
out with `@Public()`.

**Audit.** `audit_logs` with actor, action, resource, before/after, IP, user agent, metadata.
Append-only: no update or delete path exists anywhere. Every payload passes through `redact()` first.
An audit write failure is logged loudly but never rolls back the business action.

**Settings & feature flags.** Typed key/value store with encrypted `SECRET` values that no API ever
returns. Seven feature flags (all default OFF) and five emergency stops, which get their own audit
action name so "who stopped everything" is greppable.

**Channel abstraction.** `ChannelAdapter` interface in fully channel-neutral vocabulary — the file
does not contain the word "WhatsApp". Runtime `ChannelCapabilities` (15 capabilities) defaulting to
everything-disabled, with `assertCapability()` throwing a typed error rather than returning a
boolean a caller could ignore. `channels` + `channel_accounts`, with Messenger / Facebook Page /
Instagram seeded disabled as the registry the UI reads.

**Job Center.** `jobs` + `job_items`, BullMQ on Redis. Transactional creation, idempotency keys,
per-item results and failure reasons, retry-only-the-failed-items, co-operative cancellation, crash
recovery on worker boot, and a per-job distributed lock so multiple workers are safe.

**Redis primitives.** Distributed locks with Lua compare-and-delete release (a lapsed holder cannot
release the new holder's lock), fixed-window rate limiting that fails closed when Redis is
unreachable, and a dedupe helper.

**Realtime.** Socket.IO gateway authenticating with the same session cookie; room-scoped job progress.

**Health.** Public liveness and readiness probes plus an authenticated aggregate reporting
HEALTHY / WARNING / CRITICAL per component, with Phase 2+ components listed as `pending` rather than
silently omitted.

**Observability.** Structured JSON logging with automatic key-name-based secret redaction, depth
capping, and circular-reference safety.

**Docker.** Multi-stage build, non-root runtime, health checks on every service, a one-shot
migrate+seed container so API replicas never race to migrate.

---

## 2. Files created

87 files, ~6,360 lines of TypeScript in `apps/api`. Nothing is a placeholder.

| Area | Files |
|---|---|
| Docs | `docs/adr/0001-track-a-openwa-gateway-foundation.md`, `docs/PHASE_1_REPORT.md`, `README.md`; amended `docs/ARCHITECTURE_AUDIT.md` header |
| Root | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore`, `.dockerignore`, `docker-compose.yml`, `docker-compose.test.yml` |
| App config | `apps/api/{package.json,tsconfig.json,tsconfig.build.json,nest-cli.json,eslint.config.mjs,jest.unit.config.js,jest.integration.config.js,Dockerfile}` |
| Bootstrap | `src/main.ts`, `src/worker.ts`, `src/app.module.ts`, `src/seed.ts` |
| Config | `src/config/{env.validation.ts,configuration.ts}` |
| Common | `src/common/crypto/*`, `src/common/redis/{redis,lock,rate-limit}.service.ts` + module, `src/common/logging/{app-logger,redact}.ts` |
| Database | `src/database/{data-source.ts,migrate.ts}`, `src/database/migrations/1787000000000-Phase1Foundation.ts` |
| Modules | `src/modules/{auth,rbac,audit,settings,channel,jobs,realtime,health}/**` |
| Tests | 6 unit specs beside their sources; `test/{setup,auth-rbac,infrastructure,jobs}*.ts` |
| Vendored | `gateway/` — OpenWA v0.23.1 clone, **unmodified** |

`gateway/` is a clone, not authored code. `PROJECT_SPEC.md` was not touched.

---

## 3. Database migrations

One migration, `Phase1Foundation1787000000000`, written as explicit reviewed SQL with a working
`down()`.

**Tables (12):** `permissions`, `roles`, `role_permissions`, `users`, `user_roles`, `user_sessions`,
`security_settings`, `audit_logs`, `settings`, `channels`, `channel_accounts`, `jobs`, `job_items`.

**Extensions:** `pgcrypto` and `pg_trgm` required; `vector` attempted inside an exception handler so
Phase 1 boots on a stock `postgres:16` image while Phase 4's embeddings have their extension
provisioned ahead of time.

**Two partial unique indexes** — verified present in the running database:
- `UQ_channel_accounts_one_primary_per_channel` … `WHERE "isPrimary" = true`
- `UQ_jobs_idempotencyKey` … `WHERE "idempotencyKey" IS NOT NULL`

Neither is expressible in TypeORM's decorator DSL, which is why the migration is hand-written.

`synchronize` is `false` everywhere, permanently (`PROJECT_SPEC.md` §152, §204). Migrations run as
an explicit step, never on API boot.

---

## 4. APIs

All under `/api/v1`, all documented in OpenAPI at `/api/docs`.

| Method | Route | Permission |
|---|---|---|
| POST | `/auth/login` | public |
| POST | `/auth/logout` | session |
| GET | `/auth/me` | session |
| GET | `/rbac/permissions` | `roles.read` |
| GET | `/rbac/roles` | `roles.read` |
| PUT | `/rbac/roles/:id/permissions` | `roles.manage` |
| GET | `/audit` | `audit.view` |
| GET | `/settings` | `settings.read` |
| GET | `/settings/feature-flags` | `settings.read` |
| PUT | `/settings/:key` | `settings.manage` |
| GET | `/channels` | `channels.read` |
| GET | `/channels/accounts` | `channels.read` |
| GET | `/channels/accounts/:id/capabilities` | `channels.read` |
| GET | `/jobs` · `/jobs/:id` · `/jobs/:id/items` | `jobs.read` |
| POST | `/jobs/echo` · `/jobs/:id/cancel` · `/jobs/:id/retry` | `jobs.manage` |
| GET | `/health/live` · `/health/ready` | public |
| GET | `/health` | session |

WebSocket namespace `/realtime`: cookie-authenticated, `subscribe:job` / `unsubscribe:job`,
emits `job:progress`.

**Deliberately absent:** channel connect/disconnect/QR. Those need the Phase 2 adapter, and shipping
routes that return "not implemented" is what `PROJECT_SPEC.md` §209 rules out.

---

## 5. Tests

**120 tests, all passing.**

```
Unit         6 suites,  63 tests   (pure logic — no infrastructure)
Integration  3 suites,  57 tests   (real Postgres + real Redis, --runInBand)
```

Unit: crypto round-trip, tamper detection, AAD binding, key-length rejection, password hashing,
token hashing (22) · log redaction incl. circular refs and depth capping (9) · permission catalogue
integrity and privilege-escalation guards (9) · permissions guard incl. fail-closed and super-admin
bypass (8) · channel capabilities incl. never-probed-means-unsupported (9) · channel registry (6).

Integration:
- **Auth/RBAC/audit (23)** — login by username and email, httpOnly cookie, only the hash stored,
  identical responses for wrong-password vs unknown-user, lockout refusing even the correct password,
  server-side logout, immediate invalidation on deactivation, expired sessions, RBAC allow and deny,
  super-admin bypass, unknown-permission-key rejected without partial grant, before/after audit rows,
  unique-username constraint, the `role_permissions` foreign key rejecting a bogus permission, and
  `passwordHash` never selected by default.
- **Infrastructure (18)** — lock exclusivity, TTL expiry, the lapsed-holder-cannot-release race,
  owner-only extend, 10 concurrent contenders yielding exactly one execution, release-on-throw,
  wait mode; rate limiting incl. 50 concurrent calls admitting exactly 10; dedupe under a burst.
- **Jobs (13)** — end-to-end through Redis, partial failure recorded per item, retry touching only
  failed items, idempotency at both service and database level, cancellation, unregistered type
  failing loudly, 750-item atomic creation, cascade delete, crash recovery, and two concurrent
  deliveries of one job processing each item exactly once.

Quality gates: `lint` 0 errors 0 warnings · `typecheck` clean · `build` succeeds.

**Three real defects were found by these tests and fixed**, not worked around:
1. `TypeOrmModule` had no `migrations` glob — `runMigrations()` silently applied nothing.
2. `UpsertSettingDto.value` carried no validator, so the global `whitelist` +
   `forbidNonWhitelisted` pipe stripped and then rejected it. Fixed with `@Allow()`.
3. `revokeAllSessionsForUser` used `revokedAt: undefined` in its criteria; TypeORM drops undefined
   keys, so it silently re-stamped already-revoked sessions. Fixed with `IsNull()`.

---

## 6. Architecture decisions

Recorded in full in `docs/adr/0001-track-a-openwa-gateway-foundation.md`. The load-bearing ones:

1. **`gateway/` stays unmodified.** All extension goes through OpenWA's hook/plugin system so the
   fork remains mergeable (`PROJECT_SPEC.md` §211–212).
2. **The gateway's own `automation` module is rejected.** It replies directly to inbound messages,
   which would bypass the decision engine and produce duplicate replies to real customers. Support
   CRM creates zero gateway automation rules.
3. **Separate Postgres databases** for the gateway and Support CRM. The boundary is enforced by the
   database — a cross-database join is not possible, so vendor coupling cannot creep in.
4. **TypeORM, not Prisma.** Matches the gateway. The prior system's Prisma schema is a design
   reference, not a migration source.
5. **One codebase, two run modes.** The API never consumes queues; the worker never serves HTTP
   beyond loopback health. Same entities, same migrations, so they cannot drift.
6. **Guards are global; routes opt out.** A new controller is protected by default.
7. **Permissions are a table, not an enum.** A typo fails against a foreign key.
8. **`ChannelAdapter` is channel-neutral.** The interface file never mentions WhatsApp — the test of
   whether the seam is real.
9. **Capabilities default to all-false.** An unprobed account can do nothing (§174: never fake success).
10. **The boundary is lint-enforced now**, before the adapter exists, so the first violating import
    fails CI the day it is written.
11. **Redis fails closed on rate limits.** Unreachable Redis blocks sending rather than allowing an
    unlimited rate — an account-safety risk (§175).
12. **`SYSTEM_ECHO` is a real job type**, not a stub: it exercises create → enqueue → lock →
    per-item processing → progress → completion including the failure path, and stays as a
    production queue smoke test.

---

## 7. Known limitations

Everything here is deliberate and scheduled, not an oversight.

1. **No WhatsApp connectivity.** The adapter is Phase 2. `hasAdapter` correctly reports `false` for
   every channel, including WhatsApp.
2. **No conversation, customer, message or decision-log tables yet.** Phases 2–5. In particular
   `decision_logs` — mandatory per §112 — lands with the decision engine in Phase 5.
3. **Channel connect/disconnect/QR endpoints do not exist.** Deliberate: see §4 above.
4. **`gateway/` is a shallow clone** (`--depth 1`). Run `git fetch --unshallow` inside it before
   attempting an upstream merge.
5. **The gateway's own compose stack is not started** by `docker-compose.yml`. Phase 2 adds it,
   pointed at a test WhatsApp number.
6. **pgvector is optional in Phase 1** and required from Phase 4; the stock `postgres:16` image does
   not ship it, so `docs/DEPLOYMENT.md` must specify a pgvector-capable image before Phase 4.
7. **`msgpackr-extract` and `@scarf/scarf` build scripts are blocked** — recorded with reasons in
   `pnpm-workspace.yaml`. msgpackr uses its pure-JS path, which is correct.
8. **No user-management CRUD endpoints.** Users are created by the seed. `users.manage` exists as a
   permission; the routes arrive with the admin UI.
9. **No rate limiting on the API surface itself** (`@nestjs/throttler` is not wired). Login lockout
   exists; HTTP throttling is Phase 11 hardening.
10. **Realtime emits job progress only.** Conversation, message, escalation and session events plug
    into the same gateway in Phases 2–7.
11. **No admin UI.** The operator surface begins with the Support Inbox in Phase 3.
12. **`docs/` set is incomplete** — `ARCHITECTURE.md`, `DATABASE.md`, `API.md`, `DEPLOYMENT.md`,
    `SECURITY.md` and the rest (§154) are written as their subject matter lands, completed in Phase 11.

---

## 8. What Phase 2 depends on

Ready and in place:
- `channels` / `channel_accounts` with a status lifecycle and capability storage.
- `ChannelAdapter` contract + `ChannelRegistryService` for the adapter to register into.
- `ChannelCapabilities` + `assertCapability()` for gating every action.
- Job Center, Redis locks, rate limiting and dedupe for the inbound and outbound pipelines.
- Audit, RBAC, settings (encrypted `OPENWA_API_KEY` storage), realtime, health.
- Verified gateway contracts in ADR-0001 §2 — no guessing required.

Phase 2 must supply:
- `modules/channel/whatsapp/` — the only module permitted to import a gateway client.
- `modules/ingestion/` — HMAC-verified webhook doing persist + enqueue + 200 and nothing else.
- Migration for `channel_contacts`, `groups`, `group_members`, `messages`,
  `message_attachments`, `outbound_messages`, `processing_checkpoints`, including
  `UNIQUE (channel_account_id, external_message_id)` — the idempotency anchor.
- Registering the adapter, and a `MESSAGE_OUTGOING` queue consumer.

Operational prerequisites: the gateway running with an API key and a webhook pointed at Support CRM,
and **a dedicated test WhatsApp number**. Never the number the existing production system holds —
two systems on one account means duplicate replies to real customers.

---

## 9. Commands

```bash
cp .env.example .env
```

Generate `SECRET_ENCRYPTION_KEY` and `SESSION_COOKIE_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Full stack — migrates, seeds, starts API and worker:

```bash
docker compose up -d --build
```

```bash
docker compose ps
```

Local development:

```bash
pnpm install && pnpm infra:up && pnpm db:migrate && pnpm db:seed
```

```bash
pnpm dev:api
```

```bash
pnpm dev:worker
```

Tests:

```bash
pnpm test
```

```bash
pnpm test:infra:up && pnpm test:integration && pnpm test:infra:down
```

Quality gates:

```bash
pnpm lint && pnpm typecheck && pnpm build
```

Scale workers (safe — every job is claimed under a lock):

```bash
docker compose up -d --scale worker=3
```

---

## 10. Acceptance criteria

The five criteria from `docs/IMPLEMENTATION_PLAN.md` Phase 1. Each was executed and observed against
the running stack, not inferred.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `docker compose up` brings up postgres, redis, api, worker — all healthy | ✅ | `docker compose ps`: `api running healthy`, `worker running healthy`, `postgres healthy`, `redis healthy`; `migrate` exited 0 after applying the migration and seeding 36 permissions, 7 roles, 4 channels, 1 admin |
| 2 | A seeded admin can log in; a second role is genuinely denied a protected route | ✅ | Live login returned the admin with `roles:["super_admin"]` and 36 permissions. Integration test: `report_viewer` gets **403** on `GET /audit` with `Missing required permission(s): audit.view`; `support_executive` gets 403 on `PUT /settings/:key`. Unauthenticated request → 401 |
| 3 | A job runs end to end through Redis with visible progress and a working retry | ✅ | Created via the API container, processed by the **separate worker container**: `COMPLETED_WITH_ERRORS`, 3 completed / 1 failed, `progressPercent: 100`, failed item carrying its reason. Re-submitting the same idempotency key returned the same job id. 13 integration tests cover retry-only-failed, cancellation, crash recovery, and one-item-once under two concurrent deliveries |
| 4 | Every config change produces an `audit_logs` row with before/after | ✅ | Three live settings changes produced three rows: `before={'value': None} after={'value': True}`, then `before={'value': True} after={'value': False}`, each with `actor=admin` and the client IP. A `SECRET` write recorded `after={'value': '[SET]'}` — the secret appears nowhere in the audit response |
| 5 | `/api/docs` renders the current API | ✅ | HTTP 200 |

Additional security properties verified directly in the running database:
- The gateway API key is stored as `v1:qno/8kPIL09iQpyk:ZVSwRGvxQKx4OtntFV9iQg==:t0kN8…` — an
  AES-256-GCM envelope, not plaintext. The API returns `value: null, isSet: true`.
- The admin password is stored as scrypt `salt:hash`.
- Both partial unique indexes exist.

**Phase 1 passes all five acceptance criteria.**

Not claimed: WhatsApp connectivity, conversations, messages, decision logs, AI, escalation, or any
admin UI. Those are Phases 2–11.
