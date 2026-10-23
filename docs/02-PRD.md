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

## Customer directory expansion

| ID | Requirement | Acceptance |
|---|---|---|
| CRM-01 | Stable client codes and business context | Unique immutable auto/manual client code; optional ISO country, service name and active account owner; editable profile values can be cleared; existing customer/identity history is preserved |
| CRM-02 | Review CSV imports before writing | UTF-8 CSV template and strict parsing; at most 250 rows/512 KiB; row validation, code conflicts and shared phone/email warnings; no automatic identity linking or updates to existing customers |
| CRM-03 | Confirm and retry imports safely | Actor-bound, expiring signed preview; changed file/validation requires preview again; shared-contact warnings require acknowledgment; commit is atomic and idempotent, audited without raw CSV/contact payloads |
| CRM-04 | Export the complete selected directory | Permission-controlled streamed CSV of all matching records, consistent transaction snapshot, spreadsheet formula protection and audit; no latest-page cap |
| CRM-05 | Navigate large directories | Search code/name/contact/company/service; country/status/owner filters and real pagination; stale responses cannot replace the current selection |

Global controls: navigation, page finder, theme toggle, notifications and authenticated account menu. Page finder searches available destinations, not customer content. Current page and section are visible in the topbar. Mobile navigation uses a dismissible drawer.

The overview prioritizes active work over configuration. WhatsApp accounts uses an account list plus a dedicated pairing panel, an obvious add-account action and connection summary. Tables retain complete business values, status text and action labels; unavailable features are not represented as active actions.

## Inbox reading and organization

| ID | Requirement | Acceptance |
|---|---|---|
| INBOX-01 | Private in-app read state | Exact inbound message IDs seen in the visible thread are marked read per user; late arrivals and equal timestamps remain unread; no native-channel read receipt is sent |
| INBOX-02 | Read/unread navigation | Inbound unread counts, first-unread divider and manual unread flag; manual unread remains distinct from an actual unread message count |
| INBOX-03 | Archive independently of support lifecycle | Archive/unarchive affects only the current user's inbox view, retains all content and does not resolve/close conversations or change automation |
| INBOX-04 | Bounded bulk organization | Select at most 50 existing conversations; own archive/unarchive with read permission, shared pin/unpin with management permission; validate all targets before atomic writes |

## Go WhatsApp replacement requirements

| ID | Requirement | Acceptance |
|---|---|---|
| GOWA-01 | Replace runtime with pinned upstream release | Internal authenticated Go WhatsApp service; account IDs/history retained; legacy pairing is explicitly re-linked |
| GOWA-02 | Native account journey | Real QR/image and phone-code pairing, device status/reconnect/logout, accurate disconnect and group-discovery limits |
| GOWA-03 | Signed inbound and delivery | Per-device HMAC, session binding, signed-body deduplication, group sender attribution, text/media/poll/reply mapping and complete ACK batches |
| GOWA-04 | Feature coverage from actual contract | Source-derived release catalogue and real account-scoped controls for exposed send/message/chat/group/contact/newsletter functions; no arbitrary gateway proxy |
| GOWA-05 | Preserve human and server controls | Permission/ownership/capability checks, queues, policy/rate/emergency checks, audit, idempotent submission, explicit uncertain outcomes |
| GOWA-06 | Verify and document migration | Isolated integration tests, browser interactions, real unpaired gateway QR, backups, migration rollback evidence and explicit live-phone limitations |

| GOWA-07 | Single WhatsApp workspace | One shell navigation item; familiar responsive chat list, thread, composer, status, channels, groups, linked devices and advanced tools; old bookmarks redirect |
| GOWA-08 | CRM recurring delivery | One-off/daily/weekly/monthly schedules, timezone, weekdays/month day, end/occurrence limits, private list/search and pause/resume/cancel; live actor and server controls at dispatch |
| GOWA-09 | Rich message operations | Protected media, voice recording, emoji, reply/reaction/edit/forward/star/delete, contact/location/poll cards, observed poll votes, typing events and explicit native read/played controls |
| GOWA-10 | Managed integration access | Per-account encrypted Chatwoot setup/history bridge with queued replies and echo suppression; authenticated stateless MCP and stdio bridge; no independent provider sender |

The owner deferred GOWA-06 integration/browser/device gates for this coding phase. Compile checks and documentation generation may run without starting the runtime. No provider success is inferred from them.

## Completion policy

Implementation complete, automated verification complete, browser visual review complete and live-device acceptance complete are separate statuses. No single build/test result is used to claim all four. The final phase record in `09-IMPLEMENTATION-PLAN.md` states which gates actually ran.
