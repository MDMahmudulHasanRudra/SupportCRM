# Security

`PROJECT_SPEC.md` §109, §177–§179, §201.

This document states what the system actually does, not what would be nice. Where a control is
partial, it says so.

---

## 1. Authentication

| Control | How |
|---|---|
| Session | `httpOnly`, `sameSite`, signed cookie. No token in `localStorage` — a token JavaScript can read is a token an XSS payload can steal |
| Password storage | Argon2id, per-user salt |
| Session lifetime | `SESSION_LIFETIME_HOURS`, default 12 |
| Secure cookie | `SESSION_COOKIE_SECURE=true` in production (set by `docker-compose.prod.yml`) |
| Brute force | Redis-backed rate limit on the login route |

## 2. Authorisation

Every route carries `@RequirePermissions`. The permission catalogue is a single file
(`rbac/permissions.catalogue.ts`) and a unit test asserts that every permission `PROJECT_SPEC.md`
§107 names exists.

Two tiers appear repeatedly and are deliberate:

- `automation.create` writes a rule; `automation.approve` activates it. Writing words and putting
  them in front of customers are different rights.
- `reports.view` reads a figure; `reports.export` downloads customer data as a file.

**The Copilot does not bypass this.** Every Copilot tool declares the permission its *caller* must
hold, checked when the action is proposed and again when a write is confirmed.

## 3. Secrets

| Secret | Where it lives | Who can read it |
|---|---|---|
| AI provider keys | `ai_providers.apiKeyEncrypted`, AES-256-GCM, AAD-bound to the row id | The API process only |
| Gateway API key | Environment | The API and worker processes |
| Webhook secret | Environment | Signature verification only |
| Session secret | Environment | Cookie signing only |
| Encryption master key | Environment (`SECRET_ENCRYPTION_KEY`) | The crypto service only |

Enforced properties:

- **No API returns a credential.** Providers are serialised with `hasApiKey: boolean`. There is no
  route that reveals a key, not even a masked prefix — a "last four characters" convenience is what
  ends up in a screenshot.
- **No credential reaches the browser.** The built bundle is scanned against every secret in `.env`
  as part of the release check.
- **No credential reaches a log.** The logger redacts secret-named fields; a unit test asserts it.
- **No credential reaches an AI prompt.** The prompt carries the question, conversation history and
  published knowledge. Nothing else.
- **Envelopes are bound to their row.** An envelope copied to another provider id fails to decrypt.

## 4. Input handling

- Global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`: an undeclared property is
  rejected, not ignored.
- Uploads: extension, declared MIME and magic bytes must agree; size-capped; stored outside the
  web root under a generated name.
- Automation rules are **data**. No `eval`, no `new Function`, no dynamic import of user input.
  `REGEX` conditions are length-capped, case-insensitive only, compiled once and cached; a broken
  pattern matches nothing rather than throwing.
- CSV exports defuse leading `=`, `+`, `-` and `@` so a spreadsheet cannot execute an exported value.

## 5. Webhooks

`X-OpenWA-Signature: sha256=…` over the raw body, verified with a timing-safe comparison before the
payload is parsed. Deliveries are idempotent on `X-OpenWA-Idempotency-Key`.

## 6. Rate limiting

Configurable per session, group, destination, broadcast, automation, AI and API
(`rate_limit_policies`, §57). Defaults are conservative. These exist for **account safety** — they
are not a mechanism for exceeding a platform's own limits.

## 7. Network exposure

In production (`docker-compose.prod.yml`) only the reverse proxy publishes a port. Postgres, Redis,
the API, the worker and the WhatsApp gateway are reachable only on the compose network.

## 8. Audit

Every administrative change writes an `audit_logs` row with actor, IP, action, resource and a
before/after summary. Distinct from `decision_logs`, which explains *runtime* decisions — conflating
them would make both harder to read.

## 9. Production checklist (§201)

| Check | Where |
|---|---|
| No debug mode | `NODE_ENV=production` |
| Swagger disabled | `ENABLE_SWAGGER=false` in the prod overlay |
| No default credentials | The seed refuses to create an admin when users already exist, and never resets a password |
| No plaintext secrets | Envelope encryption; `.env` is not baked into any image |
| CORS restricted | `CORS_ORIGINS`, explicit list, no wildcard |
| Admin API not public | Everything behind the session guard except the two liveness probes |
| Secure headers | Helmet in the API, plus the proxy's own headers |

## 10. Known gaps

Stated rather than omitted:

- **No 2FA.** Single-factor session login only.
- **No per-field encryption of message bodies.** They are stored in plaintext in Postgres; disk
  encryption and database access control are the protection.
- **The AI provider sees customer message text.** Unavoidable for the feature, but worth stating:
  choosing a provider is choosing who processes that text.
- **Backups are documented, not automated** — see `BACKUP.md`.
- **No penetration test has been performed.**
