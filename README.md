# Support CRM

WhatsApp-first Support CRM: automation + knowledge base + AI + human escalation + analytics,
built on the [OpenWA](https://github.com/rmyndharis/OpenWA) gateway.

`PROJECT_SPEC.md` is the canonical specification. Nothing in this repository overrides it.

## Status — Phase 3 (CRM domain) complete

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository & OpenWA audit | ✅ `docs/ARCHITECTURE_AUDIT.md` |
| 1 | Database, auth, RBAC, audit, settings, channel contract, jobs, realtime, health | ✅ [report](docs/PHASE_1_REPORT.md) |
| 2 | WhatsApp — OpenWA adapter, sessions, webhooks, messages, groups, outbound | ✅ [report](docs/PHASE_2_REPORT.md) |
| 3 | CRM — customers, identities, conversations + state, assignment, takeover | ✅ [report](docs/PHASE_3_REPORT.md) |
| 4 | Knowledge base — articles, documents, chunking, embeddings, retrieval | ⏳ next |
| 5–11 | Automation, AI, escalation, scale, analytics, copilot, hardening | planned |

A real-gateway validation was run against an isolated OpenWA instance before Phase 3:
[report](docs/GATEWAY_VALIDATION_REPORT.md) — 12 pass, 0 fail, 9 blocked on a physical QR scan.
It found and fixed five defects the contract stub had hidden.

See `docs/IMPLEMENTATION_PLAN.md` for every phase, and
`docs/adr/0001-track-a-openwa-gateway-foundation.md` for the architecture decision.

**The WhatsApp channel has been validated against a real OpenWA gateway, but never paired with a
real WhatsApp account.** Nine validation items — QR pairing, inbound messages, group and participant
sync, outbound send, delivery receipts — still need a human to scan a QR with a **dedicated
non-production test number**. Never the number the existing production system is on. Exact steps:
`docs/GATEWAY_VALIDATION_REPORT.md` §4.

## Architecture

A modular monolith (`PROJECT_SPEC.md` §120) in two run modes from one codebase:

```
Internet → :12000 → web (nginx: React bundle + /api and /socket.io proxy)
                          │
                     api  (RUN_MODE=api)     HTTP + WebSocket
                     worker (RUN_MODE=worker) BullMQ consumers
                          │        ▲
       REST (X-API-Key)   ▼        │ webhook (HMAC)
                     openwa  ↔  WhatsApp
                          │
                 PostgreSQL + Redis
```

`web` is the only service published to the host (port 12000). The API, worker, database, cache and
the WhatsApp gateway are reachable only on the compose network — the browser never talks to the
gateway, and a pairing code travels gateway → API → browser.

- **PostgreSQL** — the source of truth for everything.
- **Redis** — queues, distributed locks, rate limits, job progress, dedupe. Never a source of
  truth (`PROJECT_SPEC.md` §184).
- **`gateway/`** — an unmodified clone of OpenWA, built and run as the `openwa` service in this
  stack. Extension happens through its hook/plugin system so the fork stays mergeable. Only
  `modules/channel/whatsapp` may talk to it, enforced by an ESLint rule.

## Requirements

- Docker + Docker Compose
- Node.js 22+ and pnpm 11 (only for running outside Docker)

## Quick start

```bash
cp .env.example .env
```

Generate the two secrets and put them in `.env` (`SECRET_ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Also set `OPENWA_API_KEY` (same generator) — the CRM and the WhatsApp gateway share it — and a real
`SEED_ADMIN_PASSWORD`.

Then bring the whole stack up. This migrates, seeds, and starts the console, API, worker and the
WhatsApp gateway:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

```bash
docker compose ps          # wait for every service to report (healthy)
```

- Console: <http://localhost:12000>
- Health: <http://localhost:12000/api/v1/health/live>

Sign in with `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`, then **WhatsApp → Connect** and scan the
code with your phone. Nothing else needs installing or configuring — the gateway is part of the
stack, and the paired session survives restarts.

For a fresh Ubuntu VPS end to end, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

A plain `docker compose up -d --build` (no `-f`) is the development variant: same stack, plus
loopback-only debug ports for Postgres, Redis and the API.

## Local development (without Docker)

Start only the infrastructure, then run the processes on the host:

```bash
pnpm install
```

```bash
pnpm infra:up
```

```bash
pnpm db:migrate && pnpm db:seed
```

```bash
pnpm dev:api
```

```bash
pnpm dev:worker
```

## Tests

Unit tests are pure logic — no infrastructure needed:

```bash
pnpm test
```

Integration tests run against a **real** Postgres and Redis on isolated ports, so they can never
touch your dev stack. Start that infrastructure first:

```bash
pnpm test:infra:up
```

```bash
pnpm test:integration
```

```bash
pnpm test:infra:down
```

Quality gates:

```bash
pnpm lint && pnpm typecheck && pnpm build
```

## Scaling workers

Every job is claimed under a Redis lock, so more than one worker is safe:

```bash
docker compose up -d --scale worker=3
```

## Repository layout

```
PROJECT_SPEC.md      canonical specification — never edited by implementation
docs/                audit, implementation plan, ADRs
gateway/             unmodified OpenWA clone (its own compose file; not started by ours)
apps/api/            the Support CRM monolith — API and worker run modes
  src/common/        crypto, redis (locks, rate limits), logging with secret redaction
  src/config/        env validation and typed configuration
  src/database/      TypeORM data source, migrations, migrate entrypoint
  src/modules/       auth, rbac, audit, settings, jobs, realtime, health
                     channel/ + channel/whatsapp/  ← the only code that knows OpenWA exists
                     ingestion/ messaging/ groups/ team/
                     crm/       customers, identities, conversations, state, assignment
scripts/             validate-gateway.mjs — re-runnable real-gateway validation harness
docker-compose.yml       dev / single-host stack
docker-compose.test.yml  isolated Postgres + Redis for integration tests
```

## Safety rules that outrank convenience

1. Only `modules/channel/whatsapp` may reference the gateway (§54). Lint-enforced.
2. The decision engine decides; only the outbound layer sends (§161).
3. No bulk work runs inside an HTTP request — it becomes a job (§49).
4. Every inbound message is idempotent on `(channel_account, external_id)` (§59).
5. Secrets are encrypted at rest, never returned by an API, never logged (§109, §129).
6. Support CRM and the existing production system never hold the same WhatsApp account.
"# SupportCRM" 
