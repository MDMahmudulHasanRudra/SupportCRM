# Implementation Plan and Phase Record

This is the active change plan; the older `IMPLEMENTATION_PLAN.md` remains historical context. Follow the numbered documentation set and canonical specification. Existing working functionality and uncommitted changes must be preserved.

## Documentation workflow

Before a phase: inspect the affected source; read relevant numbered documents; identify requirements, dependencies and existing behavior. During implementation: follow module boundaries and tokens. At phase end: review against requirement IDs, run appropriate automated checks, update contract/schema inventories if needed, and record actual results and remaining limitations. Do not claim browser or provider verification from a compilation result.

| Phase | Deliverable | Dependencies | Acceptance |
|---|---|---|---|
| A | Audit and ten baseline documents | Existing source/spec/audit reports | DOC-01; requirements grounded in current source, generated route/schema references |
| B | Shared Indigo Workspace theme and components | A | UX-01/03/05; tokens, headings, cards, controls, tables, dialogs, semantic statuses, light/dark |
| C | Shell and navigation | B | UX-04; sections, breadcrumbs, real page finder, desktop collapse, mobile drawer, accessible dismissal |
| D | Dashboard and page presentation | B/C | UX-02/03; overview/other pages follow one visual hierarchy, no fabricated data |
| E | Web account-management journey | B/C, existing channel APIs | WA-01…05; discoverable add/QR flow and preserved lifecycle controls, tested shared hook |
| F | Review, checks and documentation update | A…E | CORE-01/DOC-02/03; frontend typecheck/lint/build/tests; docs drift check; actual browser/provider evidence recorded |

## Verification record

Implementation status: phases A–E implemented. Automated phase F and subsequent local browser acceptance passed; physical-device acceptance remains pending. The original evidence below is supplemented by the 23 October continuation record. This record does not certify a production deployment or live WhatsApp pairing.

| Requirement / phase | Implementation and review evidence |
|---|---|
| DOC-01 / A | All ten numbered documents created from the existing checkout. `PROJECT_SPEC.md` preserved; earlier audits/reports remain historical evidence |
| DOC-02 / A/F | Root `AGENTS.md` makes relevant-document review, PRD acceptance checks and phase-end documentation updates part of the project workflow |
| DOC-03 / A/F | Source-derived inventory covers 126 API routes and 59 entity tables plus workspace migration tables; `pnpm docs:check` passed |
| UX-01/03 / B/D | `theme.css` and `design-system.css` apply Indigo Workspace to shell, login, overview, cards, tables, forms, dialogs, inbox, accounts and other shared screens |
| UX-02 / D | Overview preserves real metrics/data and existing charts; clickable KPI cards open appropriate inbox/assignment/report views; connect-account shortcut added |
| UX-04 / C | Navigation consolidated by section; permission-filtered page finder supports Ctrl/Cmd+K and Enter; mobile drawer supports dismissal/navigation and adapts to viewport changes. Four interaction tests pass |
| UX-05 / B/C | Responsive styles and reduced-motion handling implemented; 20 core light/dark contrast pairs pass `pnpm design:check`. Desktop/mobile rendered layout and full WCAG acceptance are still pending |
| WA-01/02/03 / E | Visible add-account action, focused pairing form, three-step progress, real QR material/expiry and confirmed provider connection state. Two pairing-panel tests pass, alongside existing dialog tests |
| WA-04/05 / E | Deep link from account detail to its QR panel; existing reconnect/disconnect retained; explicit typed-confirmation device logout and atomic primary selection added with server validation, permissions and audit. Incomplete provider logout is a 502 failure, never a success |
| CORE-01 / F | Frontend suite: 8 files, 32 tests passed. Targeted account integration suite: 34 tests passed against isolated Postgres/Redis and the gateway contract stub |

Final gate evidence: typecheck passed; production API/web builds passed; lint passed; documentation and contrast checks passed; `git diff --check` passed. Test-specific logs are ignored local artifacts. Later source edits must rerun relevant gates.

Review corrections during this phase: corrected secondary text/button contrast; corrected collapsed-sidebar styling inside the mobile drawer; made mobile expansion state accessible; applied stored theme to sign-in; corrected API documentation prefixes; escaped union-type pipes in generated schema tables; validated new account-route UUIDs. No unrelated backend or gateway implementation was replaced.

The original interactive browser/native-tool attempts were unavailable. The continuation used local Playwright/Chromium and saved ordinary-page screenshots under ignored `data/browser-smoke/results`; eight viewport/theme tests passed. No physical-device scan, handset unlink confirmation or production deployment was performed. An owner-controlled phone is required for the remaining live-device gate in `10-TESTING-DEPLOYMENT.md`.

## Subsequent implementation tracks

The original 23-module feature audit remains the backlog. Project tenancy, message media, other channels, Google Sheets and other missing business features require dedicated requirements, schema/contracts, tests and release gates. A visual refresh does not mark these tracks complete.

## Continuation — 23 October 2026

| Requirement | Delivered and verified |
|---|---|
| OPS-01 | Release history now previews content and offers explicit restore-as-draft confirmation. The server verifies snapshot ownership, retains replaced content, handles version conflicts transactionally and sends no restoration announcement. Integration tests cover permissions, malformed IDs, cross-release attempts, draft visibility and rollback |
| OPS-02 | Future shifts can be edited without changing their person or overlapping another active shift. Reason-required cancellation retains the schedule; before/after events identify the actor. Cancelled shifts are excluded from coverage and shown on request. Past schedules are protected |
| QA-01 / UX-05 | Eight real Chromium tests passed against the local Docker web/API: 30 destinations × two themes × four widths = 240 route visits. Headings, settled loading states, document overflow, API errors, uncaught browser errors, keyboard page finder, mobile drawer navigation and add-account focus passed |
| UX-04 correction | Rendered QA found legacy mobile CSS turning the drawer sidebar into a horizontal row. The authoritative design system now explicitly sets its direction, alignment, wrapping, height and position. Repeated mobile tests passed after correction |
| Local runtime | Built API/web/gateway images; initialized newly created local Postgres/Redis volumes, applied explicit migrations and seeded the configured admin without replacing an existing account. API, worker and web pass Docker health checks at loopback port 12000 |
| Reproducible startup | `scripts/start-local.ps1` builds current source, starts missing images/services, restarts application processes and checks API health; `docker-compose.preview.yml` uses read-only compiled-source mounts and a loopback web binding |

Continuation gates: real-DB workspace integration **15/15 passed**; frontend **36/36 passed**; API/web production builds, root typecheck and lint passed; source inventories and 20 contrast pairs passed. The actual shift migration down/up passed inside a rolled-back transaction on the isolated test database. QR-specific acceptance is recorded separately after the optional real-gateway check; a generated QR alone never certifies a phone connection.

Final local acceptance: the Windows startup script completed successfully and the gateway is healthy. Two additional browser tests passed: web-form sign-in/theme persistence, and requesting/rendering a real gateway QR through the web UI. The QR credential was not saved or logged. The unpaired validation session was stopped, retaining its CRM account/history. No physical-device scan or customer send occurred. The owner requested a GitHub checkpoint and continuation next session; see [handoff](NEXT-SESSION.md).
