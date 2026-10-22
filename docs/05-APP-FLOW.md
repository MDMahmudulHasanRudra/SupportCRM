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
| Overview → WhatsApp / Connect account | Opens `/channels/whatsapp` |
| Add account | Focuses the in-page new-account form; does not create a session by itself |
| Enter account name → Get QR code | Calls the existing connect endpoint once; shows Starting |
| QR arrives | Renders the real server-provided pairing material and expiry instructions |
| Code expires | Shared hook refreshes/retrieves the pairing state; stale code has a visible state |
| Phone → WhatsApp → Linked devices → Link a device | User scans the displayed QR using their own phone |
| Provider reports connected | Refetch updates the account and the pairing panel to Connected |
| Show QR / Link again | Uses the existing account, preserving its identity/history |
| Reconnect | Calls the existing reconnect action; shows pending state and resulting provider state |
| Logout / disconnect | Uses existing disconnect semantics; destructive or consequential confirmation follows the existing action flow |
| Health & activity | Opens the account detail with recorded health and lifecycle history |
| Groups / Sync | Opens account groups and queues the existing sync job; UI reports actual job state |
| Primary account | Existing detail control updates routing preference through the API |

QR readiness is not connection success. Gateway/API unavailable, authentication failure, timeout and stale QR states remain recoverable. Read-only operators do not see management controls. A QR cannot be scanned by the agent on behalf of the user's physical phone.

## Daily support

Overview/queue → choose conversation → load stored history/customer context → take over if permitted → compose or insert a saved reply → send → queued state → delivery state. Quotes preserve provider message IDs; retries reuse the request key. Drafts remain scoped to user and destination. Queue bulk assignment and resolving continue through existing endpoints.

Customer directory → Client 360° → confirmed identities, notes, conversations and permitted billing. Identity review remains explicit. Billing → invoice → partial payment → receipt; reversal requires a reason. Subscription → renew/pause/resume/cancel → retained history.

Team → memberships/roster/leave → review decision → private notification and coverage conflict updates. Knowledge/automation proposals → review → activation; proposal approval is not automatic customer delivery. Job center → inspect results → retry failed/cancel supported work.

## Empty/error/confirmation behavior

No records, no search matches, loading, permission denial and request failure must have distinct presentations. A transient failure offers retry; ordinary empty lists offer a relevant next action where authorized. Long tables scroll locally. Dangerous existing actions keep explicit labels and confirmation. Opening/cancelling a dialog does not submit a write.
