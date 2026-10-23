# Technical Requirements — Support CRM

## Current stack

| Layer | Actual implementation |
|---|---|
| Web | React 19, TypeScript, React Router 7, Vite 6; shared CSS tokens/components; route-level lazy loading |
| API | NestJS 11, Express, class-validator DTOs, versioned REST and Swagger |
| Persistence | PostgreSQL, pgvector where available, TypeORM entities and explicit migrations; synchronization disabled |
| Coordination | Redis, BullMQ queues, distributed locks/rate counters, Socket.IO Redis adapter |
| Workers | Same module graph, distinct worker entrypoint and run mode |
| WhatsApp | Go WhatsApp v9.6.0 integration behind `modules/channel/whatsapp`; web client calls only Support CRM |
| Files | Existing storage service and knowledge-document parsing/indexing pipeline; protected WhatsApp media storage/streaming is implemented; runtime acceptance is deferred |
| Deployment | Existing Docker Compose, API and worker processes, web/nginx proxy, health checks and volumes |
| Documentation tooling | Python 3.9+ for offline source-reference and theme-contrast checks; not part of the application runtime |
| Browser acceptance | Playwright/Chromium against a localhost deployment; session cookies remain in memory, no storage-state or credential artifacts |

Exact versions and scripts are defined in the root and application `package.json` files and lockfile. Do not introduce another framework for a visual change.

## Technical rules

1. Keep channel/provider vocabulary at the adapter boundary. Only the WhatsApp adapter knows gateway URLs, API keys and session contracts.
2. The decision engine decides. The outbound processor sends. HTTP/UI changes must not bypass queues, ownership, capability checks, rate policies or kill switches.
3. Session credentials use httpOnly cookies. The browser receives safe user/account presentation data, never encryption keys or gateway credentials.
4. Validate writes with DTOs and enforce permissions on the server. Frontend visibility improves usability but is not authorization.
5. Use additive explicit migrations. Preserve original data and history. Verify rollback in an isolated database where practical.
6. Heavy sync/import/broadcast/indexing operations become jobs. Their progress and failures must remain inspectable.
7. Every new page uses the shared theme and design system. Native form controls remain correctly labelled; modal interactions preserve keyboard access.
8. Respect existing uncommitted work. Do not reset the database or rewrite unrelated modules. The owner-authorized Go WhatsApp replacement is a distinct implementation phase.

## Build and runtime constraints

Root scripts select the correct workspace. Vite development uses port 3000 and the configured API origin; production uses the existing same-origin proxy. API paths begin `/api/v1`. CORS must match the selected frontend origin. Gateway connectivity and a physical device are prerequisites for live QR acceptance.

UI-only releases do not need new database migrations or external provider calls. The earlier workspace expansion does require migration `1788400000000-WorkspaceOperations` before its updated API/worker runs. See `WORKSPACE_RELEASE.md`.

The schedule lifecycle extension also requires `1788400001000-ShiftLifecycle`. The Windows local-preview script builds current source, shares the API runtime image across migration/API/worker, mounts compiled builds read-only and restarts application processes after rebuilding. Production continues using immutable built images, with no source mounts. Preview CORS includes the configured local web port, and that port binds to loopback.

## Reliability and review

Directory and private-inbox extensions require the additive customer-directory (`1788400002000`) and inbox-reading (`1788400003000`) migrations. Customer CSV requests are synchronous and bounded to 512 KiB/250 rows with transactional preview revalidation; larger import jobs are not exposed. Inbox read receipts remain channel-neutral, per user and exact message ID, independent of native-channel read receipts and support lifecycle.

Reused mechanisms include provider-event/message uniqueness, outbound idempotency, retries, job history, reconnect health, audit and encrypted credentials. Realtime/polling behavior is defined by the existing `usePairing` hook, not an assumed SSE implementation. Verification gates and infrastructure isolation are defined in `10-TESTING-DEPLOYMENT.md`.

## Go WhatsApp implementation

The only active transport is GoWaClient within the WhatsApp boundary. Native operations are generated from the checked-in v9.6.0 OpenAPI snapshot using YAML; AJV validates bounded typed inputs and permissions are checked on the server. Native account operations use CRM-bound device IDs and per-account webhooks. OpenWA wire-client and vendored runtime source are removed; compatibility-named normalization types/mappers remain for stored addresses and historical fixtures, not an alternate gateway.

Environment: GOWA_BASE_URL, environment-only GOWA_BASIC_AUTH, GOWA_MANAGED_AUTOMATION_DISABLED and optional exact GOWA_LINK_PREVIEW_HOSTS. Provider autonomous replies, public UI/MCP and direct Chatwoot sending remain disabled in managed configuration; existing CRM automation and the managed bridges provide those entry points. Link sharing defaults to text; native preview retrieval requires a trusted host in the deployment allowlist. Uploads are actor/account-bound and capped at 25 MiB, with actual provider limits still authoritative. Media streams use private authenticated endpoints, bounded downloads, safe MIME selection and no executable inline content.

Migrations 1788400004000 through 1788400008000 are required before updated API/worker execution. They have not been applied to the owner's running database in this phase. Native gateway execution and functional tests are deferred by request.

CRM_PUBLIC_URL identifies the external browser/callback URL independently of internal API_BASE_URL. A new Chatwoot configuration stays disabled until explicitly enabled.
