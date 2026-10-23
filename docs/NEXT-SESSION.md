# Next session handoff

## Current continuation - 23 October

The owner resumed coding and deferred physical-phone acceptance. The previous GitHub checkpoint is `a9f6326` on `ui/design-refresh`; the following directory/inbox work is a later local continuation.

- Client directory: immutable auto/custom codes, country/service/account owner, optional-field clearing, filter/search pagination, UTF-8 template/preview, acknowledgment of shared contacts, atomic idempotent create-only CSV import and complete filtered CSV export. Separate import/export permissions are enforced server-side.
- Inbox: private exact-message reads/counts, first-unread divider and manual unread flag; private archive/unarchive; up to 50 selected conversations; shared pin/unpin restricted to managers. These actions preserve lifecycle/automation and send no provider read receipt.
- Current automated evidence: 80 real-DB CRM/workspace/client/inbox tests, 45 frontend tests, four focused client and four focused inbox browser tests passed. Both new migrations passed down/up in a rolled-back isolated transaction. See the latest phase record for final review checks.
- Apply additive migrations `1788400002000` and `1788400003000` before running updated API/worker, then seed the permission catalogue; existing grants are preserved. Non-super roles need explicit `customers.import` / `customers.export` grants for transfer actions.
- Runtime changed since the previous checkpoint: missing local Docker app images were not fully rebuilt. Main database/Redis infrastructure was started and a local backup saved, but this continuation's browser QA used a dedicated host API/preview with synthetic data in the isolated test database. A new full-stack Docker startup is not certified. Use `./scripts/start-local.ps1` when ready; the initial missing-image build can take time. Never point write-capable fixture tests at the owner's database.
- Known limits remain in the feature audit: inbox filters currently cover the loaded latest 100 conversations; client photos/configurable required fields, message media, tenancy, other adapters, Sheets and other listed modules remain unfinished. Do not mark the complete 23-module inventory done.

Temporary browser-fixture API/preview processes were stopped after acceptance. Test infrastructure and synthetic data remain isolated; they are not the owner's web application. The final viewport correction and repeated gates are recorded in the phase plan.

## Previous checkpoint (historical)

Checkpoint: 23 October 2026, Asia/Dhaka. Work stopped at the owner's request for a GitHub checkpoint and continuation next session. Resume from this checkout and its existing `ui/design-refresh` branch; do not rebuild the project from scratch.

## Ready now

- Shared Indigo Workspace theme, responsive dashboard/navigation and updated application pages.
- In-app WhatsApp account addition, real QR rendering, reconnect/disconnect, confirmed logout and primary selection.
- Ten numbered project documents and source-reference/contrast checks.
- Workspace billing/subscriptions, team scheduling/leave, private drafts/replies/notifications, user access administration and release management.
- Future-shift editing, reason-required cancellation and change history; confirmed release restore as a draft.
- Windows local startup: `./scripts/start-local.ps1`; application at `http://localhost:12000`. Use the administrator credentials already configured in `.env`. The preview uses compiled-source mounts; production deployment remains separate.

## Verification completed

- API/web builds, root typecheck/lint, documentation drift and contrast checks passed.
- Frontend: 36 tests passed. Real-DB workspace integration: 15 tests passed.
- Browser layout/navigation: eight Chromium tests passed, covering 240 route visits across 30 destinations, two themes and 375/768/1280/1440px widths.
- Additional browser acceptance: web-form sign-in/theme persistence and real-gateway QR creation/rendering both passed. The QR was never saved or logged. No phone was scanned.
- The unpaired `Support WhatsApp` validation account remains in CRM; its gateway session was stopped after validation. Use its reconnect/QR action to link an owner-controlled phone. Do not create another smoke-test account unnecessarily.
- Actual shift-migration down/up passed inside a rolled-back isolated database transaction. Test containers were stopped; local application services remain available.

## Resume here

1. Read `AGENTS.md`, the relevant numbered documents and `FEATURE_AUDIT_2026-10-22.md` before changing a module.
2. Complete owner-assisted physical-device acceptance: scan a fresh QR, verify provider-confirmed connection, then check supported group sync and lifecycle behavior. No customer sends are authorized merely by this verification note.
3. Work through the wider audited backlog with dedicated requirements/schema/contracts/tests. Major incomplete tracks include project tenancy, protected message-media storage, additional channel adapters, Google Sheets integration and the remaining report/client/learning/notification features listed in the audit. The complete 23-module inventory is not finished.
4. Update phase evidence and documentation after each module. Preserve current data, secrets, gateway boundaries, queues, permissions and all existing working flows.

Local logs/screenshots are ignored under `data/`; sessions, QR material and Docker volumes are not part of the GitHub checkpoint. The previously tracked `.env` was removed from the Git index while keeping the local file, and environment files are now ignored. Earlier Git history still contains the old environment file: assess and rotate those credentials next session; no history rewrite or credential rotation was performed. No public/production deployment or phone connection is claimed.

## Latest checkpoint: Go WhatsApp source implementation

Continue from the current replacement, not the deleted OpenWA runtime. Read GOWA-MIGRATION.md, GOWA-FEATURE-MAP.md and the latest phase in 09-IMPLEMENTATION-PLAN.md. Single WhatsApp window and its feature flows are implemented in source. The owner explicitly said no Docker or functional testing for this coding phase. No new runtime cutover/migration or real phone pairing was performed. Old provider fixtures/validation scripts do not certify the new implementation; historical validation scripts are guarded against accidental execution.

When the owner asks to test, first port those provider fixtures and apply migrations 4000/5000/6000/7000/8000 only to isolated data. Validate queues, schedules, native event/media and bridge behavior, then browser/account acceptance. The owner's running localhost stack may still be the previous gateway until a requested rebuild/migration. Preserve customer/inbox changes and historical data; do not delete named legacy volumes. Follow the current numbered-document and token rules.

Static checkpoint: final API/frontend TypeScript checks and offline `pnpm docs:check` passed. Current branch is `ui/design-refresh`; GitHub checkpoint status is reported in the final handoff. Functional/provider/browser acceptance stays pending.
