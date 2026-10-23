# App Flow and Action Contracts

## Schedule correction and release restore

Team roster offers edit for upcoming active shifts, reason-required cancellation for unended active shifts, a cancelled-record toggle and change history. Cancellation removes coverage without deleting the schedule. Past schedules cannot be rewritten. Changes serialize per person and cannot overlap another active shift.

Release managers open Edit history, inspect content, select Restore as draft and explicitly confirm. The server accepts only a snapshot belonging to that release, saves current content in history, and restores content as DRAFT. This hides a published release until reviewed and published again; restore sends no announcement. Version-label conflicts roll back the entire operation.

## Sign in and navigation

1. Session check finishes before protected screens render. Anonymous users see the sign-in screen.
2. A valid sign-in populates the authenticated context. Invalid credentials show the API's safe failure message.
3. The shell exposes only destinations allowed by the current permissions. Super Admin UI checks agree with the API bypass.
4. Page finder opens through its button or Ctrl/Cmd+K; it searches available pages, supports selection and closes on Escape.
5. Mobile menu opens a drawer; selecting a destination, clicking its backdrop or pressing Escape dismisses it. The desktop sidebar can be collapsed separately.
6. Theme changes persist the explicit preference. Notifications and account/sign-out controls are real destinations/actions.

## Mandatory WhatsApp journey

| Step / button | Action and visible result |
|---|---|
| Overview → WhatsApp / Connect account | Opens `/whatsapp/accounts` (legacy URL redirects) |
| Add account | Focuses the in-page new-account form; does not create a session by itself |
| Enter account name → Get QR code | Calls the existing connect endpoint once; shows Starting |
| QR arrives | Renders the real server-provided pairing material and expiry instructions |
| Code expires | Shared hook refreshes/retrieves the pairing state; stale code has a visible state |
| Phone → WhatsApp → Linked devices → Link a device | User scans the displayed QR using their own phone |
| Provider reports connected | Refetch updates the account and the pairing panel to Connected |
| Show QR / Link again | Uses the existing account, preserving its identity/history |
| Reconnect | Calls the existing reconnect action; shows pending state and resulting provider state |
| Pause CRM / Logout | Pause disables CRM ownership while retaining pairing; Logout explicitly unlinks and requires LOGOUT confirmation |
| Health & activity | Opens the account detail with recorded health and lifecycle history |
| Groups / Sync | Opens account groups and queues the existing sync job; UI reports actual job state |
| Primary account | Existing detail control updates routing preference through the API |

QR readiness is not connection success. Gateway/API unavailable, authentication failure, timeout and stale QR states remain recoverable. Read-only operators do not see management controls. A QR cannot be scanned by the agent on behalf of the user's physical phone.

## Daily support

Inbox: choose Active, Unread or Archived in your private view. Actual unread badges count inbound non-system messages that this user has not read; a manual Unread flag is shown separately when the count is zero. Opening a thread records only visible inbound message IDs while the tab is visible. Mark loaded read explicitly reads the loaded history, with bounded requests. A first-unread divider stays at the original opening position while the thread is open. Mark unread closes the selected thread so it is not immediately cleared by visibility tracking. This is CRM read state, not a WhatsApp read receipt.

Select up to 50 existing conversations, then archive/unarchive or mark unread. Managers can pin/unpin shared conversations. Failed requests retain the selection; the API validates every target before changing any. Archive retains the conversation, lifecycle and automation, and later incoming messages stay in that user's archived view. The directory currently loads the latest 100 conversations; view filters apply to that loaded directory and do not claim complete historic pagination.

Customer directory supports real pagination, code/contact/service search and status/country/owner filters. Managers create or edit country, service and account owner; code remains immutable. Empty optional values clear existing data. The account-owner chooser shows active users and preserves an already assigned inactive owner as history.

Customer import: download template -> choose UTF-8 CSV -> preview rows/errors/shared-contact warnings -> correct the file or explicitly acknowledge shared contacts -> import all rows atomically. No customer/identity is merged or overwritten. A changed/expired preview requires revalidation; a transient network retry reuses the same preview to confirm the same import. Export matching CSV downloads the complete filtered directory through an authenticated stream, independently of the visible page.

Overview/queue → choose conversation → load stored history/customer context → take over if permitted → compose or insert a saved reply → send → queued state → delivery state. Quotes preserve provider message IDs; retries reuse the request key. Drafts remain scoped to user and destination. Queue bulk assignment and resolving continue through existing endpoints.

Customer directory → Client 360° → confirmed identities, notes, conversations and permitted billing. Identity review remains explicit. Billing → invoice → partial payment → receipt; reversal requires a reason. Subscription → renew/pause/resume/cancel → retained history.

Team → memberships/roster/leave → review decision → private notification and coverage conflict updates. Knowledge/automation proposals → review → activation; proposal approval is not automatic customer delivery. Job center → inspect results → retry failed/cancel supported work.

## Empty/error/confirmation behavior

No records, no search matches, loading, permission denial and request failure must have distinct presentations. A transient failure offers retry; ordinary empty lists offer a relevant next action where authorized. Long tables scroll locally. Dangerous existing actions keep explicit labels and confirmation. Opening/cancelling a dialog does not submit a write.

## Single WhatsApp window

The shell has one WhatsApp entry. Its feature rail opens Chats, Updates, Channels, Groups, Scheduled, All features, Linked devices and Settings. Account switching scopes all tools; account-detail routes bind the header to the viewed account. Old inbox/accounts/groups/replies/broadcast bookmarks redirect into the window. Global CRM support/team/billing functions retain their own navigation.

Chats preserve private unread/archive and shared pins. The chat header opens search/quick replies, CRM actions and customer context. Plus opens upload/share/poll/location/contact/schedule forms; emoji inserts into the draft; voice recording requires an explicit microphone action, supports review/re-record and queues only after Send. Message menus offer permission-controlled reply/reaction/edit/forward/star/delete/read/played actions. Queued and confirmed states remain separate. Deleted/edited presentation preserves the business record. Native read receipts are explicit and independent of private CRM visibility reads.

History browser pages native chats and messages; Import queues a bounded page, recognizes legacy IDs, keeps source timestamps and bypasses automatic decisions/reopening. Updates show delivered status events retained for the last 24 hours and support text/photo/video publishing; availability depends on WhatsApp delivery. Channels show followed newsletters, read/older-message pagination, protected media and unfollow. No unsupported follow/create channel action is invented.

Scheduled messages list private schedules and expose pause/resume/cancel. Send tools support local first-run time, IANA timezone, once/daily/weekly/monthly repetition, weekday/month-day selection, end time and occurrence limit. The first slot is explicit; later slots use the selected calendar. Counters label queued occurrences, not delivery success.

Settings exposes QR/device management, phone-code/passkey pairing, profile/privacy tools, replies/assignments/broadcasts, activity and Chatwoot setup. Credential-equivalent pairing and callback secrets are returned only to authorized users and never audited as values. Advanced forms derive from the pinned contract; managed account/webhook operations link to their dedicated controls.
