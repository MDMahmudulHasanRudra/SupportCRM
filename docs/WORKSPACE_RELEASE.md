# Workspace release: installation and verification

Latest continuation: Windows source preview starts with `./scripts/start-local.ps1` at `http://localhost:12000`; it requires the additional `1788400001000-ShiftLifecycle` migration. Current verification includes 36 frontend tests, 15 workspace integration tests, eight browser layout/navigation tests and two additional browser sign-in/real-QR tests. The QR-only session was stopped without scanning a phone. See [next-session handoff](NEXT-SESSION.md) for the exact checkpoint and remaining work; older counts below are historical.

For the later shared-theme/navigation and web account-control update, use the [current documentation index](README.md) and [phase acceptance record](09-IMPLEMENTATION-PLAN.md). The results below describe the earlier workspace expansion.

This release extends the existing Support CRM checkout. Use the existing Postgres, Redis and gateway deployment; do not attach an account that is still owned by the source production automation system.

## Apply to a development/staging installation

From the repository root, with the intended environment already configured:

```powershell
pnpm db:migrate
pnpm db:seed
pnpm dev:api
# In separate terminals:
pnpm dev:worker
pnpm dev:web
```

The migration `1788400000000-WorkspaceOperations` adds billing, term history, team membership, shifts, leave, notifications, replies, drafts and release tables. It reuses `customers`, `users`, `conversations`, and `support_teams`. `synchronize` remains disabled. Apply migrations before starting the updated API/worker: assignment notifications require the new table.

The seed adds `billing.read` and `billing.manage` to the permission catalogue. It intentionally preserves existing role assignments. A Super Admin can use **Users & access → Roles & permissions** to grant these to the appropriate roles. Super Admin frontend access now agrees with the server's bypass, including newly added permissions. A role needs both `billing.read` and `billing.manage` for the complete billing UI; customer selection also needs `customers.read`.

Review migrations and take the normal backup before using them on production. The `down` migration removes the new records/tables, so reverting it after real usage requires exporting those records first.

## Screens

| Path | Purpose |
|---|---|
| `/` | Focused overview with real queue metrics, trends, recent conversations, connections, activity and shortcuts |
| `/analytics` | Original detailed operations dashboard |
| `/support-queue` | Waiting for a human, personal assignments, unassigned and resolved views; assign/resolve/export |
| `/customers/:id` | Client 360°: profile, identities, notes, linked conversations, permitted billing summary |
| `/billing` | Invoices, receipts, reversals and subscription terms/history |
| `/team` | Teams/memberships, roster, leave reviews and coverage conflicts |
| `/saved-replies` | User-private reusable replies, also insertable in the composer |
| `/jobs` | Job progress, per-item results, failed-item retry and cancellation |
| `/notifications` | User-private notification feed and read state |
| `/changelog` | Published releases; settings managers can draft/edit/publish/archive |
| `/access` | Users, roles, passwords and session administration |

The inbox accepts `?conversation=<uuid>` from profile, queue and overview links. It saves a separate draft per user and destination. Earlier history uses timestamp+ID cursors. Quotes preserve the original provider message ID; unsupported provider capabilities still reject sends through the existing outbound checks.

Billing stores positive integer minor units. UI conversion supports currency precision (for example JPY zero digits and KWD three digits). Invoice balances derive from non-reversed receipts, with a row lock preventing concurrent overpayment. A payment key is serialized globally before its invoice lock, preventing duplicate or conflicting retries. Reversals retain the original receipt. Each subscription change stores a separate event.

Shift starts/ends are stored as instants and rendered in the browser's timezone. Leave date overlap and billing date cutoffs use the configured database timezone. Membership history remains after removal, and disabled teams remain in history. Coverage counts describe scheduled availability, not attendance.

## Checks

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:infra:up
pnpm test:integration
```

The new `workspace.integration-spec.ts` exercises permissions, partial/concurrent/idempotent payments, reversal, term transitions, overlapping shifts, leave decisions, private replies/drafts/notifications, release visibility/history, user deactivation, password reset and privilege boundaries with the real API and test database. The CRM suite includes same-timestamp cursor coverage. `workspace.test.ts` covers exact currency conversion and currency-specific precision.

### Results from this implementation session

- Typecheck, lint (no errors or warnings), production API/web builds, and `git diff --check` passed.
- Backend unit tests: 29 suites, 438 tests passed.
- Frontend tests: 6 suites, 26 tests passed, including exact money conversion and safe message rendering.
- The full integration run exercised all 11 suites. Seven unaffected suites passed; two initial failures were caused by an outdated AI status expectation and cross-test Redis rate counters. Both were corrected. The affected decision-engine/WhatsApp suites plus CRM and workspace were rerun together: 4 suites, 169 tests passed. The latest workspace changes were then checked separately: 10 tests passed. There are no unresolved failures from these runs.
- The migration's `down` then `up` methods passed inside a transaction against `support_crm_test`; the entire transaction was rolled back, preserving the test database state.
- Route splitting reduced the initial JavaScript bundle from about 660 KB to 337 KB (minified, before gzip), with other screens loaded on demand.
- Browser provider unavailable in this session; no screenshot or responsive visual acceptance claim. Live WhatsApp, other external providers and production deployment were not exercised.

See `FEATURE_AUDIT_2026-10-22.md` for the complete 23-module inventory, known gaps and live-provider verification limits. This is not a migration to multi-project tenancy or a port of every optional integration.
