# Deployment

Deploying Support CRM on a fresh Ubuntu VPS, WhatsApp included.

One command brings up the whole product — database, cache, API, worker, console and the WhatsApp
gateway. Nothing is installed on the host except Docker itself, and nothing is paired by hand
outside the console.

## 1. What runs

| Container | Purpose | Published |
|---|---|---|
| `web` | React bundle on nginx; also proxies `/api` and `/socket.io` to the API | **12000** |
| `api` | HTTP + WebSocket, `RUN_MODE=api` | no |
| `worker` | Queue consumers and schedulers, `RUN_MODE=worker` | no |
| `openwa` | The WhatsApp gateway (Chromium + WhatsApp Web) | no |
| `postgres` | Everything durable (PostgreSQL 16 + pgvector) | no |
| `redis` | Locks, rate limits, BullMQ | no |
| `migrate` | Runs migrations and the seed once, then exits | no |

**`web` is the only service reachable from outside.** The API, database, cache and the WhatsApp
gateway are reachable only on the compose network. A database — or a WhatsApp gateway — on a host
port is the most common way a system like this ends up on the internet.

There is no Caddy, no second nginx, and no host-level nginx. The `web` container already serves the
console and proxies the API on one origin, which is what lets the browser call `/api` relatively.

```
Internet → :12000 → web ─┬→ /api/*       → api:4000
                          └→ /socket.io/* → api:4000

api, worker ⇄ openwa:2785        (pairing, sending)
openwa      → api:4000           (inbound webhooks)
api, worker → postgres:5432, redis:6379
```

The browser never talks to `openwa`. A pairing code travels gateway → API → browser.

## 2. Fresh VPS

Ubuntu 22.04 or 24.04, 4 GB RAM minimum (see §7).

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh

# 2. The application
git clone <your-repository-url> support-crm
cd support-crm

# 3. Configuration
cp .env.example .env
```

Fill in `.env`. The five that have no safe default are:

```bash
POSTGRES_PASSWORD=…        # also set DATABASE_PASSWORD to the same value
SECRET_ENCRYPTION_KEY=…    # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
SESSION_COOKIE_SECRET=…    # same generator, a different value
OPENWA_API_KEY=…           # same generator; the CRM and the gateway share this one
SEED_ADMIN_PASSWORD=…      # your first login. Production refuses to boot on the documented default
```

Then:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The first build compiles the console and the gateway image (Chromium), so allow ten to twenty
minutes on a small VPS. Afterwards:

```bash
docker compose ps          # wait until every service reports (healthy)
```

Open `http://SERVER-IP:12000`, sign in with `admin` and your `SEED_ADMIN_PASSWORD`.

## 3. Connecting WhatsApp

Entirely in the console. You never open the gateway.

1. **WhatsApp** in the sidebar.
2. **Connect** on the account, or fill in a name and press **Get QR code**.
3. The gateway starts a browser and produces a pairing code. First boot takes up to a minute.
4. On your phone: WhatsApp → **Linked devices** → **Link a device** → scan.
5. The console switches to **Connected** on its own. Codes rotate every ~20 s; a fresh one appears
   automatically, so a code going stale needs no action.
6. Groups sync, and inbound messages start arriving.

If the code never appears, see §9.

## 4. Session persistence

The paired session lives in the `support_crm_openwa_data` volume, not in the container. It survives
`restart`, `down`/`up`, image rebuilds and a server reboot.

`OPENWA_AUTO_START_SESSIONS` defaults to `true`: when the gateway boots it resumes sessions that are
already authenticated. Only authenticated ones — an account that was never paired does not start a
browser. This is what makes a reboot survivable; with it off, the container comes back healthy while
WhatsApp stays offline.

Verified end to end: gateway restart, `api`/`worker` restart, and a full `down` → `up` all restored
the session with **zero** pairing codes issued.

A QR is needed again only if WhatsApp itself invalidates the session (unlinked from the phone), the
operator disconnects the account, or the volume is deleted.

> Give the gateway a minute after a deploy before sending. Restoring a session means starting
> Chromium and loading WhatsApp Web; a send issued during that window fails with *"Session is not
> active"*, which is accurate rather than a defect.

## 5. Updating

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations run automatically before the API starts. Data and the WhatsApp session are untouched.

**Never use `docker compose down -v`.** The `-v` deletes the volumes — the database, uploaded
documents and the WhatsApp pairing all go with it.

## 6. Environment

`.env.example` marks each variable REQUIRED, OPTIONAL or DEVELOPMENT ONLY. The ones worth
understanding here:

| Variable | Why it matters |
|---|---|
| `OPENWA_BASE_URL` | Where the API finds the gateway. `http://openwa:2785` — a service name, not `localhost`, which inside a container means the container itself |
| `OPENWA_API_KEY` | Shared by the CRM and the gateway (`API_MASTER_KEY`). Never reaches the browser |
| `API_BASE_URL` | What the gateway is told to POST webhooks to. `http://api:4000` — must be reachable **from the gateway** |
| `OPENWA_SSRF_ALLOWED_HOSTS` | The gateway refuses to deliver webhooks to internal addresses. `api` is allowlisted so inbound messages arrive; the guard stays on for everything else |
| `SEED_ADMIN_PASSWORD` | First login. The seed never overwrites an existing admin's password |
| `WEB_PORT` | The single public port. Default 12000 |

## 7. Memory

Chromium is the reason this needs real memory. One WhatsApp session runs a full browser.

| | |
|---|---|
| Minimum VPS | **4 GB RAM** for one WhatsApp account |
| Comfortable | 8 GB for two to four accounts |
| Measured, one active session | ~730 MB of the gateway's 2 GB limit |
| Gateway limit | `OPENWA_MEM_LIMIT`, default `2g` |
| Shared memory | `OPENWA_SHM_SIZE`, default `512m` — Chromium's default 64 MB `/dev/shm` is not enough for WhatsApp Web |
| Process ceiling | `OPENWA_PIDS_LIMIT`, default `2048` (~8–10 sessions). Never set `-1` |

Practical guidance: **one to two accounts on 4 GB, three to four on 8 GB.** Each additional session
adds roughly 400–700 MB.

If the gateway exits with **137**, it was OOM-killed. Raise `OPENWA_MEM_LIMIT` (and the VPS), or
reduce concurrent sessions. Operators running many accounts on a small VPS can set
`OPENWA_AUTO_START_SESSIONS=false` and reconnect accounts deliberately from the WhatsApp screen,
which avoids every session starting at once after a reboot.

## 8. Domain and TLS

Not handled here, deliberately. The application is happy behind anything.

```
https://crm.example.com → your reverse proxy / load balancer → 127.0.0.1:12000
```

Bind the public port to loopback (`WEB_PORT=127.0.0.1:12000`) once a proxy is terminating TLS.

**`SESSION_COOKIE_SECURE` and HTTPS go together, or not at all.** A browser never returns a `Secure`
cookie over plain HTTP, so with it `true` and no TLS in front, login appears to succeed and then
every subsequent request is unauthenticated — the session simply never comes back. Set it `true`
only once HTTPS genuinely terminates upstream (Cloudflare, a load balancer, or your own proxy), and
leave it `false` while you are reaching the box over `http://SERVER-IP:12000`.

Socket.IO needs nothing special: it shares the one origin and the same cookie, so whatever terminates
TLS must forward WebSocket upgrades — the default for Cloudflare and nginx `proxy_pass` with
`Upgrade`/`Connection` headers.

## 8b. Obsolete volumes

Upgrading from an earlier layout can leave volumes nothing mounts any more. Nothing deletes them
automatically — a volume that looks obsolete and holds the only copy of something is a bad day.

```bash
docker volume ls | grep -E 'support_crm|openwa'
```

| Volume | Status |
|---|---|
| `support_crm_pg_data`, `support_crm_redis_data`, `support_crm_storage`, `support_crm_openwa_data` | **In use. Never delete.** |
| `support_crm_caddy_data`, `support_crm_caddy_config` | Obsolete — the Caddy proxy was removed. Safe to delete |
| `openwa_openwa-data` | Obsolete *only if* you migrated from the standalone gateway stack. It holds the pre-migration copy of the WhatsApp session — keep it until the current pairing has survived a restart |

Delete one deliberately, and only after a backup:

```bash
docker volume rm support_crm_caddy_data support_crm_caddy_config
```

## 9. Troubleshooting

**The QR never appears.** Check `docker compose ps openwa` is healthy; Chromium takes up to a minute
on first boot. Then `docker compose logs openwa | grep qr_generated`.

**Paired, but no incoming messages.** The webhook is not registered. Check it:

```bash
curl -s -b cookies http://localhost:12000/api/v1/channels/whatsapp/accounts/<id>/health
```

If `webhookRegistered` is `false`, press **Connect** on the account — reconnect alone does not
register one. If the gateway logs *"Destination address is not allowed"*, `api` is missing from
`OPENWA_SSRF_ALLOWED_HOSTS`.

**Gateway exits 137.** Out of memory — see §7.

**"Session is not active" when sending.** The session is still restoring after a restart. Wait for
the account to read Connected.

**Console loads but the API fails.** `docker compose logs api`. A production boot refuses to start
on the default `SEED_ADMIN_PASSWORD`, or with `SESSION_COOKIE_SECURE=true` and no TLS in front.

## 10. Health

```bash
docker compose ps                                  # container health
curl http://localhost:12000/api/v1/health/live     # liveness, public
```

Signed in, `GET /api/v1/health` reports database, redis, queue, storage, AI, worker and WhatsApp
separately. WhatsApp is reported from the real session state — "1 of 2 accounts connected" — not
from whether the gateway's HTTP port answers.

## 11. Backups

See [BACKUP.md](./BACKUP.md). The short version: back up the database, the storage volume, **the
WhatsApp session volume**, and `.env` — losing the session volume means pairing every account again.
