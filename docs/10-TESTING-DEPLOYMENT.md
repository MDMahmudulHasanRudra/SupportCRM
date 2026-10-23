# Testing and Deployment Strategy

## Gates for this release

| Gate | Method | Evidence boundary |
|---|---|---|
| Documentation | `pnpm docs:check` | Source inventories match generated sections; manual requirements/design review still required |
| Theme contrast | `pnpm design:check` | 20 core foreground/background pairs meet 4.5:1; not a complete rendered-page WCAG audit |
| Frontend types | `pnpm --filter @support-crm/web typecheck` | Type safety, not visual correctness |
| Frontend lint | `pnpm --filter @support-crm/web lint` | Hook/TypeScript rules, not provider acceptance |
| Production bundle | `pnpm --filter @support-crm/web build` | Vite output and lazy routes compile |
| Frontend regression | `pnpm --filter @support-crm/web test` | Existing and added interaction tests, pairing state handling, navigation permissions and safe rendering |
| Account API integration | Isolated existing WhatsApp connect/channel suites | Real database/queues with test provider; not a physical-device connection |
| Browser acceptance | `pnpm test:browser`, local Playwright/Chromium | All 30 navigation destinations in both themes at 375/768/1280/1440px, page headings/data loading, document overflow, API/browser errors, keyboard page finder, mobile drawer and account-form focus |
| Live device | Real gateway plus owner-controlled phone | Add → real QR → phone scan → connected → reconnect/logout; no automatic assumption of success |

Backend unit/integration suites are necessary for backend changes; a purely visual change does not need all external-provider tests repeated. Integration tests must use the isolated test database/Redis, never the owner's real data. Existing scripts and harness are documented in `WORKSPACE_RELEASE.md`.

Customer-directory acceptance is opt-in with `CRM_E2E_CUSTOMERS=1`; inbox acceptance uses `CRM_E2E_INBOX=1`. Both require the dedicated localhost integration-fixture API and synthetic `owner@example.test` account, and perform writes only in that isolated database. They cover create/edit/clear/import/export and private unread/archive/shared-pin workflows at 375/1440px in both themes. Run no write-capable acceptance against the owner's data. These suites disable automatic screenshots/traces, saving only explicit ordinary-page screenshots after actions. No gateway session or outbound provider send is part of them.

The optional real-gateway check is opt-in (`CRM_E2E_PAIRING=1`, test name `real gateway QR`), localhost-only, and skips if any account already exists. It creates one unpaired local support account, requests and checks the rendered real QR, then stops its session while retaining its CRM account/history. Screenshots and traces are disabled for this credential-bearing flow. A physical scan is never automated. Ordinary browser smoke tests are read-only apart from session creation and local theme preference.

Browser results from the fresh workspace cover real empty/list/error states, not a populated production dataset, full WCAG compliance, every nested detail screen or physical-device behavior. Keep those acceptance boundaries explicit.

## Manual directory and inbox acceptance

After local startup and the additive migrations, use a permitted account:

1. Customers: create a client with code/country/service/owner; reopen Client 360, edit it and clear optional values. Confirm the code remains immutable. Change filters and move between customer pages.
2. Download the CSV template, preview a small file, check validation/shared-contact warnings and explicitly confirm import. Repeating a completed request must not create duplicate clients. Export matching CSV and compare all matching rows, including rows outside the visible page.
3. Inbox: open a conversation with stored inbound history. Visible messages become read; scrolling older history into view reads those exact messages. On mobile, offscreen messages remain unread. Mark loaded read explicitly clears loaded inbound history; Mark unread closes the thread and retains the manual flag.
4. Select conversations and archive them; switch to Archived, then unarchive. A second user's view should retain its own archive/read state. Pin/unpin is shared and unavailable without management permission. Conversation lifecycle and automation must remain unchanged.
5. Check light/dark and mobile layouts; failed actions should retain selections and offer a useful retry. Inbox view filtering currently covers the loaded latest 100 conversations, as labelled.

## Manual WhatsApp account acceptance

1. Sign in with channel management permission. Reach WhatsApp from overview and sidebar.
2. Add a uniquely named test account. Check one session starts and the panel displays its real QR and expiry.
3. Scan with the owner's phone; verify provider-confirmed Connected and account information.
4. Inspect health/history and account groups; run the existing sync and inspect actual progress.
5. Exercise supported reconnect and logout/disconnect; verify resulting state. Re-link without losing account history.
6. Check read-only access: no account-changing controls; API denies direct unauthorized writes.
7. Check unavailable gateway, stale QR and abandoned pairing recovery. Do not expose credentials or use a production-owned number for an isolated test.

## Deployment

Use existing Docker files and infrastructure. Web production assets are built from `apps/web`; nginx proxies `/api` and realtime traffic to the API. Keep environment secrets in the existing environment/secret store, not source or browser bundles. This design phase requires no new business migration; installations missing the earlier workspace migration must apply it before updated business APIs run.

Before a real release: save the current source/build version, run applicable gates, back up the database when a migration is involved, apply reviewed migrations once, build/deploy the web/API/worker as required, check health and smoke-test the account journey. Preserve the current audience and infrastructure. No public deployment or production data mutation is implied by local design verification.

## Rollback and monitoring

For a visual regression, restore the previous web artifact/source version; do not revert business tables as a response to a CSS issue. Database rollback requires a separate data-preservation review. Monitor existing health endpoints, connection events, failed outbound, job errors, audit and worker state. Keep production claims separate from mocked-provider coverage and document unavailable browser/device checks honestly.

## Current owner instruction: implementation without runtime tests

For the Go WhatsApp replacement, the owner explicitly defers Docker execution and functional tests. TypeScript compile checks and offline documentation/contract generation are allowed implementation checks; they do not contact a provider or start the application. Do not treat the earlier OpenWA fixture suites or QR acceptance as evidence for Go WhatsApp.

The next requested validation phase must first update native gateway fixtures and review GOWA-FEATURE-MAP.md. Exercise the five additive gateway migrations on isolated data, concurrency/idempotency/cancel/unknown outcomes, recurring timezone/end/occurrence behavior, signed native events and all receipt IDs, real protected media/file rules, role changes, disabled ownership and emergency stops, history import without decisions, integration echo/binding rules and MCP transport/authentication. Perform frontend accessibility/responsive/dark-mode and real browser flows after compile checks.

No new migrations are applied to the running owner's database now. Before an actual cutover, preserve database/storage/legacy session volumes, configure the pinned internal authenticated service, apply migrations, rebuild API/web/worker together and pair accounts only with the owner. The legacy named data volume remains rollback material; the working tree no longer vendors the old gateway. Deployment commands in README are future operator instructions, not actions executed by the agent in this phase.
