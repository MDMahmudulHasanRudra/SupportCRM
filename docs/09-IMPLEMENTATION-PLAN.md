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

## Customer directory continuation — 23 October 2026

CRM-01..05 implementation adds immutable auto/custom client codes, country/service/owner context, clearing optional profile values, active-owner selection, search/filter pagination, strict UTF-8 CSV preview/template, atomic idempotent create-only import and a full filtered CSV stream. Transfer permissions are separate from ordinary read/manage, with existing grants preserved. Previews are actor-bound encrypted tokens with a 15-minute expiry; no raw CSV is persisted. Shared-contact warnings require explicit acknowledgment, and no identity is automatically linked. Source/contract/schema/flow documents were updated.

Review corrections: guarded stale directory/detail/file-read responses, retained unchanged inactive owner history, added canonical token encoding checks after a tampering regression exposed permissive base64 decoding, and preserved the same preview on transient commit failures. Manual directory writes and imports share a transaction lock so validated code/contact state remains consistent while importing.

Automated evidence: 10 CSV boundary unit tests passed; three real-DB CRM/workspace/customer suites passed 72 tests before the additional inactive-owner case, then the complete customer suite passed 9/9. Frontend suite passed 41/41 including preview/confirmation/retry and pagination/selection-race coverage. API/web builds and typecheck passed; lint and reference checks passed after review corrections. Browser acceptance and final runtime boundaries are recorded below after the focused checks complete.

Focused browser acceptance passed four tests: create/profile clear/import acknowledgment/native CSV download at 375/1440px in light/dark themes, with no document overflow or uncaught browser errors. These writes used the isolated test database and synthetic accounts through the real API; no owner/customer data was changed. The host API/web source build passed. Local database backup was saved under ignored `data/backups`; fresh Docker images were unavailable, so the full stack rebuild was stopped and browser checks used a dedicated local test API/preview instead. This phase does not certify a new full-stack Docker deployment or any provider operation.

## Inbox reading and organization continuation - 23 October 2026

INBOX-01..04 add exact-message, user-private inbound reads; real unread counts and a separate manual flag; stable first-unread divider; private archive/unarchive; and atomic bulk organization for up to 50 conversations. Shared pins require management permission. Read/archive never change lifecycle, automation, ownership or native-provider read state. The browser observes visible inbound message elements only while its tab is visible; the explicit Mark loaded read action batches loaded IDs. Mark unread waits for this tab's outstanding read requests and closes the thread. Private state is not broadcast to other users.

Review corrections include stale directory response guards, preserving selection on failed actions, keeping zero-count manual flags distinct, serializing this tab's read requests before manual unread, avoiding stale-search refreshes after a read, and releasing the export database runner even when transaction startup fails. Customer and inbox migrations both passed down/up inside a rolled-back isolated database transaction.

Verification: four real-DB suites (CRM, workspace, customer directory, inbox) passed **80/80**, including seven new inbox tests. Frontend **45/45** passed including visible/hidden-tab reads, cleanup, failed selection retention and manual-unread behavior. Four actual Chromium inbox tests passed at 375/1440px in light/dark, with read/mark-unread/pin/archive/unarchive and overflow/error checks. Combined with the earlier four client tests, eight focused business-flow browser tests have passed. API/web builds, root typecheck/lint, reference inventories, contrast and whitespace checks passed; final review corrections are rechecked below before handoff.

Limits: inbox view filters currently apply to the loaded latest 100 conversations and group/contact directories remain bounded. Personal-content ACLs, richer inbox categories, media, tenant isolation, other channel adapters, Sheets and other items in the feature audit remain separate work. The complete 23-module inventory is not certified finished. Physical-device acceptance remains deferred at the owner's request to keep coding. No real phone was linked, customer message sent, public deployment started or production migration applied.

Final rendered review found that an explicit thread intersection root could count messages below the mobile document viewport. Visibility tracking now uses the implicit browser viewport, which also clips scrolling ancestors. The focused browser regression checks that unread offscreen mobile history remains unread until explicitly marked loaded-read; the unit test locks the viewport-root choice. Export-runner cleanup was rechecked with the complete 9-test customer integration suite. Final repeated API/web builds, 45 frontend tests and typecheck passed; after the viewport correction, the web build (including types), all 45 frontend tests, lint and all four focused inbox browser tests passed again. Eight combined client/inbox browser tests also passed before that viewport-only correction. Documentation/reference, contrast and whitespace checks passed. Temporary fixture API/preview processes were stopped after acceptance; no fixture account was installed in the owner's database.

## Local administrator sign-in recovery - 23 October 2026

The owner reported a locked administrator on the localhost login page. The configured password matched the stored password hash; five failed attempts had triggered the existing lockout. Cleared only this active administrator's lockout counters/timestamps in a transaction and recorded `auth.local_unlock` with before/after lock state and no credentials. Password, roles, other sessions and lockout policy were retained. Verified through the actual local web proxy: login HTTP 200, authenticated session HTTP 200, then verification-session logout HTTP 204. No application code or production authentication policy changed; this is API verification, not an interactive browser sign-in claim. Local Docker services were observed healthy during recovery, superseding the earlier stopped-runtime observation for this later point in time.

## Go WhatsApp replacement and single window - 23 October 2026

Owner direction: remove the old gateway, make Go WhatsApp the main provider, integrate exposed features under one WhatsApp window, and do not run Docker or functional tests now. Existing customer/inbox changes and PROJECT_SPEC.md are preserved.

Implementation review against GOWA-01..10:

| Requirements | Source implementation |
|---|---|
| GOWA-01 | Pinned v9.6.0 image/source contract, active GoWaClient/adapter/Compose config, removed legacy vendored runtime and wire client, guarded additive account migration |
| GOWA-02 | CRM account controls for real QR, phone code, passkey response/confirm, reconnect/logout/remove/primary/ownership; no invented disconnect or complete group discovery |
| GOWA-03 | Exact-byte native HMAC/session binding/dedup, canonical addresses, legacy message aliases, preserved timestamps/newlines, batched receipts, message mutations/polls/presence |
| GOWA-04 | 97-operation source catalogue, validated forms, uploads, reads and queued actions; explicit managed equivalents for lifecycle/webhooks/schedules/Chatwoot |
| GOWA-05 | Outbound atomic claim/cancel, queue repair on idempotent submission, live creator/schedule/ownership/rate/emergency checks, encrypted action input, unknown-outcome handling |
| GOWA-07 | One WhatsApp shell destination with familiar responsive frame, inbox, status, channels, history browser/import, groups, accounts and tools; old routes redirect |
| GOWA-08 | Encrypted once/daily/weekly/monthly schedules, timezone/calendar controls, limits/end time, private search/paging, pause/resume/cancel and due-run maintenance |
| GOWA-09 | Chat actions, private media streams, emoji/voice/upload sharing, quick replies/search, structured cards, observed poll votes and typing events |
| GOWA-10 | Encrypted optional Chatwoot config/history/mirror/reply bridge with queued text/media, bindings/echo suppression, integration Job Center work, authenticated MCP/stdio |

Review corrections include preserving stored groups absent from limited discovery; avoiding automatic decisions and support reopening on history import; non-regressing conversation activity timestamps; realtime conversation invalidation; optional boolean fields remaining absent until chosen; account-scoped forms/state; safe inline media types; and no automatic resend after ambiguous dispatch.

GOWA-06 verification status: static TypeScript compilation and source-generated inventories are recorded below. **No functional unit/integration/browser tests, new Docker startup/build/pull, runtime migration, real pairing, customer send, Chatwoot connection or production deployment was performed after this instruction.** A prior attempted image pull before this instruction timed out; it did not establish a Go WhatsApp cutover. The owner's previously running stack is not changed by these source edits. Earlier test counts in this document belong to the earlier customer/inbox/legacy-provider phases and do not certify this replacement.

Deferred acceptance: port legacy provider integration fixtures to native v9.6.0 contracts; exercise migrations and rollback on isolated data; queue races, scheduled cancellation/calendar boundaries, private media/voice/poll events, integration error paths; browser review in both themes and narrow/wide layouts; real unpaired QR acceptance; owner-controlled phone scan and supported provider actions. The pinned provider's approximate 500-group ceiling, read/unfollow-only newsletter REST support, view-on-phone view-once behavior, trusted-host link previews, same-origin Chatwoot Active Storage policy and unverified external integrations remain explicit limits. No multi-project isolation, exact visual clone, provider success or production readiness is claimed.

Label-event coverage uses the additive 1788400008000 migration and a read-only labels view. Labels are changed on the linked phone because the pinned REST contract has no label editing endpoint.

Cutover review: the transport migration cancels saved legacy QUEUED sends and marks legacy SENDING outcomes uncertain, retaining their requests/history for review. It never replays them automatically through the new phone binding. The future local-start script stops API/worker writers and the project-owned retired gateway before migration; it retains the legacy volume. These script/database actions have not been executed in this phase.

Final source review uses a no-key-update schedule claim so the separate outbound connection can insert its schedule foreign key without blocking on the claim transaction. Message mutation invalidations publish after commit. Stale integration delivery claims become UNKNOWN instead of silently resending.

Final implementation checks: `pnpm --filter @support-crm/api typecheck` passed after the final backend review; `pnpm --filter @support-crm/web typecheck` passed for the completed frontend; `pnpm docs:check` passed. Pinned contract/feature-map generation and API/schema inventory synchronization completed. These are static/offline checks only. No functional test, browser launch, Docker execution, migration application or provider send was used to validate this phase.
