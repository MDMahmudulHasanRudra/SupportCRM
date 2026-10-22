# Product Requirements — Support CRM

Status: active contract for the design and web account-management phase. Read alongside `01-BRD.md` and the canonical specification. Requirement IDs are stable and used in review evidence.

| ID | Requirement | Acceptance / code location |
|---|---|---|
| UX-01 | One visual theme and palette across all pages | Theme tokens in `apps/web/src/theme.css`; shared presentation in `design-system.css`; no page invents another primary brand color |
| UX-02 | A readable overview with real information | Queue metrics, period-filtered trend, recent conversations, connected accounts, audit activity and useful links; loading/error/empty states distinguish unavailable data from zero |
| UX-03 | Consistent page hierarchy | Shared `PageHeader`, card headings, filters, tables, forms, dialogs, status indicators and focus styles |
| UX-04 | Complete navigation on desktop and mobile | Permission-filtered navigation; mobile drawer closes on navigation, backdrop and Escape; keyboard-accessible page finder |
| UX-05 | Accessible, responsive presentation | Reflow at 375/768/1280/1440px; tables scroll within their region; no page-wide overflow; labels and keyboard focus remain visible; reduced-motion support |
| WA-01 | Add an account inside the app | Authorized user opens WhatsApp accounts, enters a display name and requests a QR. Account creation uses the existing API and runs once per action |
| WA-02 | Show and refresh a real QR | Pairing displays server QR material, expiry/refresh status and phone instructions. The UI does not manufacture pairing codes |
| WA-03 | Reflect the completed connection | Gateway state/refetch changes the UI to Connected after the device is linked; a stale QR is never presented as success |
| WA-04 | Operate existing accounts | Re-link/show QR, reconnect, logout/disconnect, primary-account control, health/history and group sync remain accessible from account screens, as supported by existing endpoints |
| WA-05 | Handle failures clearly | Starting, stale QR, timeout, auth failure and offline errors have recoverable actions; never reveal gateway credentials |
| CORE-01 | Preserve existing working workflows | Conversations, customers, billing, teams, knowledge, automation, reports, jobs and access management keep their APIs, authorization and substantive behavior |
| DOC-01 | Ten maintained documents | The numbered BRD, PRD, TRD, architecture, flow, design, schema, API, plan and verification documents exist and cross-reference real code |
| DOC-02 | Documents inform implementation | Root `AGENTS.md` requires relevant documents before work, acceptance review and documentation updates after each phase |
| DOC-03 | Detect reference drift | `pnpm docs:check` verifies generated API/schema inventories against controller/entity/migration source |
| OPS-01 | Restore release content safely | Managers explicitly restore a snapshot belonging to the release as a draft; current content is preserved, no automatic publication or announcement |
| OPS-02 | Correct and cancel duty schedules | Edit future active shifts without overlaps; reason-required cancellation retains records; cancelled shifts do not count as coverage; before/after history identifies actors |
| QA-01 | Repeatable local browser acceptance | Playwright visits all 30 navigation destinations in both themes at 375/768/1280/1440px; checks overflow, page finder, mobile drawer and account form focus |

## Page behavior

Global controls: navigation, page finder, theme toggle, notifications and authenticated account menu. Page finder searches available destinations, not customer content. Current page and section are visible in the topbar. Mobile navigation uses a dismissible drawer.

The overview prioritizes active work over configuration. WhatsApp accounts uses an account list plus a dedicated pairing panel, an obvious add-account action and connection summary. Tables retain complete business values, status text and action labels; unavailable features are not represented as active actions.

## Completion policy

Implementation complete, automated verification complete, browser visual review complete and live-device acceptance complete are separate statuses. No single build/test result is used to claim all four. The final phase record in `09-IMPLEMENTATION-PLAN.md` states which gates actually ran.
