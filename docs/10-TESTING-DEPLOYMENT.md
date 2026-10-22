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

The optional real-gateway check is opt-in (`CRM_E2E_PAIRING=1`, test name `real gateway QR`), localhost-only, and skips if any account already exists. It creates one unpaired local support account, requests and checks the rendered real QR, then stops its session while retaining its CRM account/history. Screenshots and traces are disabled for this credential-bearing flow. A physical scan is never automated. Ordinary browser smoke tests are read-only apart from session creation and local theme preference.

Browser results from the fresh workspace cover real empty/list/error states, not a populated production dataset, full WCAG compliance, every nested detail screen or physical-device behavior. Keep those acceptance boundaries explicit.

## Manual account acceptance

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
