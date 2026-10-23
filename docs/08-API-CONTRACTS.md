# API Contracts

Base path: `/api/v1`. Authentication: existing httpOnly session cookie. Global guards enforce authentication and declared permissions. JSON mutations use validated DTOs; unknown fields are rejected by the global validation pipe. Source links in the route inventory expose the exact request DTO, serialization and service contract for each endpoint.

## Shared response and error behavior

Paginated lists generally return `{items,total}` with endpoint-specific limits; message history returns `{items,hasMore,nextCursor,nextCursorId}`. Do not infer pagination or unrestricted exports where an endpoint caps its response. Errors use HTTP status plus a safe `message` string or validation-message array. Web client `ApiError` preserves the human-readable message. Typical statuses: 400 invalid input/state, 401 no valid session, 403 insufficient permission, 404 missing resource/adapter, 409 conflicting operation/idempotency/state, 502/503/504 provider availability failures.

## Mandatory account contracts

| Operation | Contract |
|---|---|
| Account overview | `GET /channels/whatsapp/accounts/overview`; `channels.read`; safe presentation rows include connection state, status text, account name/phone, primary/ownership flags, group count and timestamps |
| Create and connect | `POST /channels/whatsapp/accounts/connect`; `channels.manage`; validated display name; returns the existing connect presentation; browser shows Starting and retrieves QR through the shared hook |
| Existing account connection | Existing `/:id/connect` and `/:id/reconnect` routes; `channels.manage`; per-account lifecycle semantics and locks remain in the channel service |
| QR | `GET /channels/whatsapp/accounts/:id/qr`; authorized access; QR material, format/expiry and current state; client renders only supported real material |
| Disconnect | `POST /channels/whatsapp/accounts/:id/disconnect`; `channels.manage`; stops the session and preserves device pairing |
| Device logout | `POST /channels/whatsapp/accounts/:id/logout`; `channels.manage`; body `{confirm:"LOGOUT"}`; explicitly unlinks, retains CRM history, needs a new scan. Incomplete gateway logout returns 502 and is not reported as successful |
| Primary account | `POST /channels/whatsapp/accounts/:id/primary`; `channels.manage`; atomically demotes the old primary and promotes the target within a locked channel transaction |
| Health/history | Existing account health/connection-events routes; presentation never includes gateway secrets |
| Ownership/primary/groups | Existing account/controller routes remain authoritative; see generated route/source inventory |

See `apps/web/src/components/use-pairing.ts` and the corresponding controller DTOs for the exact wire shape used by the live client. Polling/events may return interim states; a QR response is not a delivery/connection guarantee.

## Other important mutation contracts

- Conversation list/detail include current-user `unreadCount`, `firstUnreadMessageId`, `markedUnread`, `isArchived`. Counts include inbound non-system messages without a receipt for this user; manual flags do not fabricate counts.
- `POST /inbox/conversations/:id/read` requires `conversations.read` and `messages.read`, accepts unique `messageIds` (0..200 UUIDs), verifies all belong to the conversation before writing, records inbound non-system IDs idempotently and clears the manual flag. Empty IDs explicitly clear only that flag. Response is `{conversationId,unreadCount,firstUnreadMessageId,markedUnread,isArchived}`. No provider read receipt is sent.
- `POST /inbox/organize` requires `conversations.read`, accepts `{conversationIds,action}` with 1..50 unique UUIDs and `ARCHIVE|UNARCHIVE|MARK_UNREAD`; preferences affect only the actor. `POST /inbox/pin` additionally requires `conversations.manage`, with `PIN|UNPIN` affecting the shared pin. Invalid input is 400, any missing target is 404 and the entire batch remains unchanged. Audit contains counts/actions only. Private changes are not broadcast to other operators; shared pins emit existing conversation events.

- Customer create/update accept optional ISO country, service and account owner. Create may supply a unique uppercase custom code; `CL-number` codes are reserved for automatic generation. Code is not accepted on update. Null/blank optional contact/context fields clear values. Newly assigned owners must be active; an unchanged inactive owner may remain as history.
- `GET /customers/directory/owners` requires `customers.manage`; returns only active IDs/names/usernames. Lists additionally filter country, owner or `unassigned=true` and search code/service. Owner summaries contain ID/name/username/active only.
- Customer CSV template and `POST .../directory/import/preview` / `.../commit` require `customers.read`, `customers.manage` and `customers.import`. Preview takes `{csv}` (UTF-8, <=512 KiB, <=250 records). Commit takes `{csv,previewToken,acknowledgeSharedContacts}`. Tokens are encrypted/authenticated, actor-bound and expire after 15 minutes; completed retries return the original IDs without new records. Validation drift/expiry is 409, malformed or changed input is 400. CSV does not create channel identities or update existing customers.
- `GET /customers/directory/export` requires `customers.read` and `customers.export`; streams all matching directory records from a repeatable-read snapshot in bounded batches. Limit/offset do not truncate exports. CSV values are quoted and spreadsheet formulas neutralized; responses use `no-store`, and audits contain counts instead of raw contacts/CSV.

- Outbound messages take account ID, external conversation ID, body, optional quoted external ID and idempotency key; only the existing outbound pipeline may dispatch them.
- Payment recording takes invoice ID, positive integer `amountMinor`, reference and UUID idempotency key. A replay with changed details is a conflict; overpayment is rejected. Reversal requires a reason.
- Shift scheduling takes user ID, start/end ISO instants and label; overlapping shifts are rejected. Leave review accepts approved/rejected only once.
- `PUT /workspace/workforce/shifts/:id` edits future active shifts without changing their person. `POST /workspace/workforce/shifts/:id/cancel` requires `{reason}` and retains the record; `GET .../:id/history` exposes actor and before/after snapshots. All require `team.manage`.
- User creation/password/role operations enforce administrative permissions and anti-escalation restrictions; password reset revokes sessions and responses omit hashes.
- Notifications/replies/drafts derive their owner from the session, not a client-supplied user ID.
- Release publication retains edit snapshots and creates in-app announcements. Only published releases are visible through the ordinary list.
- `POST /workspace/releases/:id/restore` takes `{versionId}` and requires `settings.manage`. A snapshot must belong to the release; restore preserves current content and returns a draft with `publishedAt:null`. Missing snapshots are 404, reused version labels are 409, invalid UUIDs are 400. Restore does not notify users.

Swagger is generated by the existing API bootstrap when configured. Run `pnpm docs:check` to detect changes to the inventory.

<!-- BEGIN GENERATED API -->
Source-derived inventory: **160 routes**. Permission labels are declarations; global/controller guards and service checks remain authoritative. DTO/source links define exact validation and responses.

| Method | Route | Required permission | Body DTO | Source / handler |
|---|---|---|---|---|
| GET | `/api/v1/audit` | audit.view | `—` | [audit.controller](../apps/api/src/modules/audit/audit.controller.ts) · `query` |
| POST | `/api/v1/auth/login` | Public; signature/session rules in source | `LoginDto` | [auth.controller](../apps/api/src/modules/auth/auth.controller.ts) · `login` |
| POST | `/api/v1/auth/logout` | Session (see controller/global guard) | `—` | [auth.controller](../apps/api/src/modules/auth/auth.controller.ts) · `logout` |
| GET | `/api/v1/auth/me` | Session (see controller/global guard) | `—` | [auth.controller](../apps/api/src/modules/auth/auth.controller.ts) · `me` |
| GET | `/api/v1/channels` | channels.read | `—` | [channel.controller](../apps/api/src/modules/channel/channel.controller.ts) · `listChannels` |
| GET | `/api/v1/channels/accounts` | channels.read | `—` | [channel.controller](../apps/api/src/modules/channel/channel.controller.ts) · `listAccounts` |
| GET | `/api/v1/channels/accounts/:id/capabilities` | channels.read | `—` | [channel.controller](../apps/api/src/modules/channel/channel.controller.ts) · `capabilities` |
| GET | `/api/v1/channels/whatsapp/integrations/chatwoot/:id/setup` | channels.manage | `—` | [gowa-integration.controller](../apps/api/src/modules/channel/whatsapp/gowa-integration.controller.ts) · `setup` |
| POST | `/api/v1/channels/whatsapp/integrations/chatwoot/:id` | Public; signature/session rules in source | `Record` | [gowa-integration.controller](../apps/api/src/modules/channel/whatsapp/gowa-integration.controller.ts) · `webhook` |
| GET | `/api/v1/channels/whatsapp/mcp/:accountId` | channels.read | `—` | [gowa-mcp.controller](../apps/api/src/modules/channel/whatsapp/gowa-mcp.controller.ts) · `stream` |
| POST | `/api/v1/channels/whatsapp/mcp/:accountId` | channels.read | `McpRequestDto` | [gowa-mcp.controller](../apps/api/src/modules/channel/whatsapp/gowa-mcp.controller.ts) · `rpc` |
| GET | `/api/v1/channels/whatsapp/tools/accounts/:id/files/:fileId` | messages.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `file` |
| GET | `/api/v1/channels/whatsapp/tools/accounts/:id/messages/:messageId/media` | messages.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `messageMedia` |
| GET | `/api/v1/channels/whatsapp/tools/accounts/:id/events/:eventId/media` | messages.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `eventMedia` |
| GET | `/api/v1/channels/whatsapp/tools/accounts/:id/feed` | messages.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `feed` |
| GET | `/api/v1/channels/whatsapp/tools/accounts/:id/labels` | conversations.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `listLabels` |
| GET | `/api/v1/channels/whatsapp/tools/catalogue` | channels.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `catalogue` |
| POST | `/api/v1/channels/whatsapp/tools/accounts/:id/read/:operation` | channels.read | `ToolReadDto` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `read` |
| POST | `/api/v1/channels/whatsapp/tools/accounts/:id/actions/:operation` | channels.read | `ToolActionDto` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `action` |
| POST | `/api/v1/channels/whatsapp/tools/accounts/:id/uploads` | channels.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `upload` |
| GET | `/api/v1/channels/whatsapp/tools/accounts/:id/events` | messages.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `events` |
| GET | `/api/v1/channels/whatsapp/tools/accounts/:id/actions` | channels.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `list` |
| GET | `/api/v1/channels/whatsapp/tools/accounts/:id/actions/:actionId` | channels.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `get` |
| POST | `/api/v1/channels/whatsapp/tools/accounts/:id/actions/:actionId/cancel` | channels.read | `—` | [gowa-tools.controller](../apps/api/src/modules/channel/whatsapp/gowa-tools.controller.ts) · `cancel` |
| GET | `/api/v1/channels/whatsapp/accounts/overview` | channels.read | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `overview` |
| POST | `/api/v1/channels/whatsapp/accounts/connect` | channels.manage | `RegisterAccountDto` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `createAndConnect` |
| POST | `/api/v1/channels/whatsapp/accounts` | channels.manage | `RegisterAccountDto` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `register` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/connect` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `connect` |
| GET | `/api/v1/channels/whatsapp/accounts/:id/qr` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `qr` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/disconnect` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `disconnect` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/pairing-code` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `pairingCode` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/passkey/status` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `passkeyStatus` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/passkey/response` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `passkeyResponse` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/passkey/confirm` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `passkeyConfirm` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/remove-device` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `removeDevice` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/logout` | channels.manage | `ConfirmLogoutDto` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `logout` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/primary` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `primary` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/reconnect` | channels.manage | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `reconnect` |
| GET | `/api/v1/channels/whatsapp/accounts/:id/health` | channels.read | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `health` |
| GET | `/api/v1/channels/whatsapp/accounts/:id/connection-events` | channels.read | `—` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `connectionEvents` |
| POST | `/api/v1/channels/whatsapp/accounts/:id/ownership` | channels.manage | `SetOwnershipDto` | [whatsapp.controller](../apps/api/src/modules/channel/whatsapp/whatsapp.controller.ts) · `setOwnership` |
| GET | `/api/v1/conversations` | conversations.read | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `list` |
| GET | `/api/v1/conversations/:id` | conversations.read | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `findOne` |
| GET | `/api/v1/conversations/:id/messages` | messages.read | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `messages` |
| GET | `/api/v1/conversations/:id/participants` | conversations.read | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `participants` |
| GET | `/api/v1/conversations/:id/state-history` | conversations.read | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `stateHistory` |
| GET | `/api/v1/conversations/:id/assignment-history` | conversations.read | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `assignmentHistory` |
| POST | `/api/v1/conversations/:id/status` | conversations.manage | `SetStatusDto` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `setStatus` |
| POST | `/api/v1/conversations/:id/control-state` | conversations.takeover | `SetControlStateDto` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `setControlState` |
| POST | `/api/v1/conversations/:id/takeover` | conversations.takeover | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `takeover` |
| POST | `/api/v1/conversations/:id/release` | conversations.takeover | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `release` |
| POST | `/api/v1/conversations/:id/assign` | conversations.manage | `AssignDto` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `assign` |
| POST | `/api/v1/conversations/:id/unassign` | conversations.manage | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `unassign` |
| PATCH | `/api/v1/conversations/:id/flags` | conversations.manage | `SetFlagsDto` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `setFlags` |
| POST | `/api/v1/conversations/:id/tags` | conversations.manage | `—` | [conversations.controller](../apps/api/src/modules/crm/conversations.controller.ts) · `addTag` |
| GET | `/api/v1/customers/directory/owners` | customers.manage | `—` | [customer-directory.controller](../apps/api/src/modules/crm/customer-directory.controller.ts) · `owners` |
| GET | `/api/v1/customers/directory/template` | customers.read, customers.import, customers.manage | `—` | [customer-directory.controller](../apps/api/src/modules/crm/customer-directory.controller.ts) · `template` |
| POST | `/api/v1/customers/directory/import/preview` | customers.read, customers.import, customers.manage | `CustomerCsvDto` | [customer-directory.controller](../apps/api/src/modules/crm/customer-directory.controller.ts) · `preview` |
| POST | `/api/v1/customers/directory/import/commit` | customers.read, customers.import, customers.manage | `CustomerImportCommitDto` | [customer-directory.controller](../apps/api/src/modules/crm/customer-directory.controller.ts) · `commit` |
| GET | `/api/v1/customers/directory/export` | customers.read, customers.export | `—` | [customer-directory.controller](../apps/api/src/modules/crm/customer-directory.controller.ts) · `export` |
| GET | `/api/v1/customers` | customers.read | `—` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `list` |
| GET | `/api/v1/customers/:id` | customers.read | `—` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `findOne` |
| POST | `/api/v1/customers` | customers.manage | `CreateCustomerDto` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `create` |
| PATCH | `/api/v1/customers/:id` | customers.manage | `UpdateCustomerDto` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `update` |
| GET | `/api/v1/customers/identities/list` | customers.read | `—` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `listIdentities` |
| POST | `/api/v1/customers/identities` | customers.manage | `CreateIdentityDto` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `createIdentity` |
| POST | `/api/v1/customers/identities/:id/propose-match` | customers.manage | `—` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `proposeMatch` |
| POST | `/api/v1/customers/identities/:id/confirm` | customers.manage | `—` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `confirmIdentity` |
| POST | `/api/v1/customers/identities/:id/reject` | customers.manage | `—` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `rejectIdentity` |
| GET | `/api/v1/customers/:id/notes` | customers.read | `—` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `listNotes` |
| POST | `/api/v1/customers/:id/notes` | customers.manage | `AddNoteDto` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `addNote` |
| POST | `/api/v1/customers/:id/tags` | customers.manage | `TagDto` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `addTag` |
| POST | `/api/v1/customers/:id/tags/remove` | customers.manage | `TagDto` | [customers.controller](../apps/api/src/modules/crm/customers.controller.ts) · `removeTag` |
| POST | `/api/v1/inbox/conversations/:id/read` | conversations.read, messages.read | `—` | [inbox.controller](../apps/api/src/modules/crm/inbox.controller.ts) · `read` |
| POST | `/api/v1/inbox/organize` | conversations.read | `—` | [inbox.controller](../apps/api/src/modules/crm/inbox.controller.ts) · `organize` |
| POST | `/api/v1/inbox/pin` | conversations.read, conversations.manage | `—` | [inbox.controller](../apps/api/src/modules/crm/inbox.controller.ts) · `pin` |
| GET | `/api/v1/groups` | groups.read | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `list` |
| GET | `/api/v1/groups/operations/list` | groups.read | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `operationsList` |
| GET | `/api/v1/groups/operations/summary` | groups.read | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `operationsSummary` |
| GET | `/api/v1/groups/operations/matching-ids` | groups.read | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `matchingIds` |
| GET | `/api/v1/groups/:id` | groups.read | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `findOne` |
| GET | `/api/v1/groups/:id/ai-status` | groups.read | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `aiStatus` |
| GET | `/api/v1/groups/:id/stats` | groups.read | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `stats` |
| GET | `/api/v1/groups/:id/participants` | groups.read | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `listParticipants` |
| POST | `/api/v1/groups/sync` | groups.update | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `syncGroups` |
| POST | `/api/v1/groups/sync-participants` | groups.update | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `syncParticipants` |
| POST | `/api/v1/groups/:groupId/sync-participants` | groups.update | `—` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `syncGroupParticipants` |
| PATCH | `/api/v1/groups/:id/config` | groups.update | `UpdateGroupConfigDto` | [groups.controller](../apps/api/src/modules/groups/groups.controller.ts) · `updateConfig` |
| GET | `/api/v1/health/live` | Public; signature/session rules in source | `—` | [health.controller](../apps/api/src/modules/health/health.controller.ts) · `live` |
| GET | `/api/v1/health/ready` | Public; signature/session rules in source | `—` | [health.controller](../apps/api/src/modules/health/health.controller.ts) · `ready` |
| GET | `/api/v1/health` | Session (see controller/global guard) | `—` | [health.controller](../apps/api/src/modules/health/health.controller.ts) · `detailed` |
| POST | `/api/v1/channels/whatsapp/webhook/:channelAccountId` | Public; signature/session rules in source | `—` | [webhook.controller](../apps/api/src/modules/ingestion/webhook.controller.ts) · `receive` |
| GET | `/api/v1/jobs` | jobs.read | `—` | [jobs.controller](../apps/api/src/modules/jobs/jobs.controller.ts) · `list` |
| GET | `/api/v1/jobs/:id` | jobs.read | `—` | [jobs.controller](../apps/api/src/modules/jobs/jobs.controller.ts) · `findOne` |
| GET | `/api/v1/jobs/:id/items` | jobs.read | `—` | [jobs.controller](../apps/api/src/modules/jobs/jobs.controller.ts) · `items` |
| POST | `/api/v1/jobs/echo` | jobs.manage | `—` | [jobs.controller](../apps/api/src/modules/jobs/jobs.controller.ts) · `createEcho` |
| POST | `/api/v1/jobs/:id/cancel` | jobs.manage | `—` | [jobs.controller](../apps/api/src/modules/jobs/jobs.controller.ts) · `cancel` |
| POST | `/api/v1/jobs/:id/retry` | jobs.manage | `—` | [jobs.controller](../apps/api/src/modules/jobs/jobs.controller.ts) · `retry` |
| GET | `/api/v1/messages` | messages.read | `—` | [messages.controller](../apps/api/src/modules/messaging/messages.controller.ts) · `list` |
| GET | `/api/v1/messages/:id` | messages.read | `—` | [messages.controller](../apps/api/src/modules/messaging/messages.controller.ts) · `findOne` |
| POST | `/api/v1/messages` | messages.send | `SendMessageDto` | [messages.controller](../apps/api/src/modules/messaging/messages.controller.ts) · `send` |
| GET | `/api/v1/messages/outbound/list` | messages.read | `—` | [messages.controller](../apps/api/src/modules/messaging/messages.controller.ts) · `listOutbound` |
| GET | `/api/v1/messages/outbound/:id` | messages.read | `—` | [messages.controller](../apps/api/src/modules/messaging/messages.controller.ts) · `outboundStatus` |
| POST | `/api/v1/messages/outbound/:id/cancel` | messages.send | `—` | [messages.controller](../apps/api/src/modules/messaging/messages.controller.ts) · `cancel` |
| GET | `/api/v1/rbac/permissions` | roles.read | `—` | [rbac.controller](../apps/api/src/modules/rbac/rbac.controller.ts) · `listPermissions` |
| GET | `/api/v1/rbac/roles` | roles.read | `—` | [rbac.controller](../apps/api/src/modules/rbac/rbac.controller.ts) · `listRoles` |
| PUT | `/api/v1/rbac/roles/:id/permissions` | roles.manage | `UpdateRolePermissionsDto` | [rbac.controller](../apps/api/src/modules/rbac/rbac.controller.ts) · `updateRolePermissions` |
| GET | `/api/v1/settings` | settings.read | `—` | [settings.controller](../apps/api/src/modules/settings/settings.controller.ts) · `list` |
| GET | `/api/v1/settings/feature-flags` | settings.read | `—` | [settings.controller](../apps/api/src/modules/settings/settings.controller.ts) · `featureFlags` |
| PUT | `/api/v1/settings/:key` | settings.manage | `UpsertSettingDto` | [settings.controller](../apps/api/src/modules/settings/settings.controller.ts) · `upsert` |
| GET | `/api/v1/support/members` | team.manage | `—` | [support-analytics.controller](../apps/api/src/modules/team/support-analytics.controller.ts) · `members` |
| GET | `/api/v1/support/members/:id/daily` | team.manage | `—` | [support-analytics.controller](../apps/api/src/modules/team/support-analytics.controller.ts) · `memberDaily` |
| GET | `/api/v1/support/members/:id/groups` | team.manage | `—` | [support-analytics.controller](../apps/api/src/modules/team/support-analytics.controller.ts) · `memberGroups` |
| GET | `/api/v1/support/members/:id/activity` | team.manage | `—` | [support-analytics.controller](../apps/api/src/modules/team/support-analytics.controller.ts) · `memberActivity` |
| GET | `/api/v1/support/activity` | team.manage | `—` | [support-analytics.controller](../apps/api/src/modules/team/support-analytics.controller.ts) · `activity` |
| GET | `/api/v1/support/activity/:day` | team.manage | `—` | [support-analytics.controller](../apps/api/src/modules/team/support-analytics.controller.ts) · `activityDay` |
| GET | `/api/v1/team/identities` | team.manage | `—` | [team.controller](../apps/api/src/modules/team/team.controller.ts) · `list` |
| POST | `/api/v1/team/identities` | team.manage | `CreateIdentityDto` | [team.controller](../apps/api/src/modules/team/team.controller.ts) · `create` |
| PATCH | `/api/v1/team/identities/:id` | team.manage | `UpdateIdentityDto` | [team.controller](../apps/api/src/modules/team/team.controller.ts) · `update` |
| POST | `/api/v1/team/identities/:id/deactivate` | team.manage | `—` | [team.controller](../apps/api/src/modules/team/team.controller.ts) · `deactivate` |
| GET | `/api/v1/users` | users.read | `—` | [users.controller](../apps/api/src/modules/workspace/users.controller.ts) · `list` |
| POST | `/api/v1/users` | users.manage, roles.manage | `CreateUserDto` | [users.controller](../apps/api/src/modules/workspace/users.controller.ts) · `create` |
| PATCH | `/api/v1/users/:id` | users.manage, roles.manage | `UpdateUserDto` | [users.controller](../apps/api/src/modules/workspace/users.controller.ts) · `update` |
| POST | `/api/v1/users/:id/password` | users.manage | `PasswordDto` | [users.controller](../apps/api/src/modules/workspace/users.controller.ts) · `password` |
| GET | `/api/v1/users/:id/sessions` | users.read | `—` | [users.controller](../apps/api/src/modules/workspace/users.controller.ts) · `sessions` |
| POST | `/api/v1/users/:id/revoke-sessions` | users.manage | `—` | [users.controller](../apps/api/src/modules/workspace/users.controller.ts) · `revoke` |
| GET | `/api/v1/workspace/overview` | conversations.read | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `overview` |
| GET | `/api/v1/workspace/billing` | billing.read | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `billingOverview` |
| POST | `/api/v1/workspace/billing/invoices` | billing.manage | `InvoiceDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `invoice` |
| POST | `/api/v1/workspace/billing/payments` | billing.manage | `PaymentDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `pay` |
| POST | `/api/v1/workspace/billing/payments/:id/reverse` | billing.manage | `ReasonDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `reverse` |
| POST | `/api/v1/workspace/billing/subscriptions` | billing.manage | `SubscriptionDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `subscribe` |
| POST | `/api/v1/workspace/billing/subscriptions/:id/action` | billing.manage | `SubscriptionActionDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `subscriptionAction` |
| GET | `/api/v1/workspace/billing/subscriptions/:id/history` | billing.read | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `subscriptionHistory` |
| GET | `/api/v1/workspace/workforce` | team.manage | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `workforceOverview` |
| GET | `/api/v1/workspace/assignees` | conversations.manage | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `people` |
| POST | `/api/v1/workspace/workforce/teams` | team.manage | `TeamDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `team` |
| POST | `/api/v1/workspace/workforce/teams/:id/disable` | team.manage | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `disableTeam` |
| POST | `/api/v1/workspace/workforce/teams/:id/members` | team.manage | `MemberDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `member` |
| POST | `/api/v1/workspace/workforce/teams/:id/members/remove` | team.manage | `MemberDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `removeMember` |
| POST | `/api/v1/workspace/workforce/shifts` | team.manage | `ShiftDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `shift` |
| PUT | `/api/v1/workspace/workforce/shifts/:id` | team.manage | `ShiftDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `updateShift` |
| POST | `/api/v1/workspace/workforce/shifts/:id/cancel` | team.manage | `ReasonDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `cancelShift` |
| GET | `/api/v1/workspace/workforce/shifts/:id/history` | team.manage | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `shiftHistory` |
| POST | `/api/v1/workspace/workforce/leave` | team.manage | `LeaveDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `leave` |
| POST | `/api/v1/workspace/workforce/leave/:id/review` | team.manage | `LeaveReviewDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `reviewLeave` |
| GET | `/api/v1/workspace/notifications` | Session (see controller/global guard) | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `notifications` |
| POST | `/api/v1/workspace/notifications/read-all` | Session (see controller/global guard) | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `readAll` |
| POST | `/api/v1/workspace/notifications/:id/read` | Session (see controller/global guard) | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `read` |
| GET | `/api/v1/workspace/saved-replies` | messages.read | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `replies` |
| POST | `/api/v1/workspace/saved-replies` | messages.send | `SavedReplyDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `reply` |
| DELETE | `/api/v1/workspace/saved-replies/:id` | messages.send | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `deleteReply` |
| GET | `/api/v1/workspace/drafts` | messages.send | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `drafts` |
| PUT | `/api/v1/workspace/drafts` | messages.send | `DraftDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `draft` |
| GET | `/api/v1/workspace/releases` | Session (see controller/global guard) | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `releases` |
| GET | `/api/v1/workspace/releases/manage` | settings.manage | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `manageReleases` |
| POST | `/api/v1/workspace/releases` | settings.manage | `ReleaseDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `release` |
| PUT | `/api/v1/workspace/releases/:id` | settings.manage | `ReleaseUpdateDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `updateRelease` |
| GET | `/api/v1/workspace/releases/:id/history` | settings.manage | `—` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `releaseHistory` |
| POST | `/api/v1/workspace/releases/:id/restore` | settings.manage | `ReleaseRestoreDto` | [workspace.controller](../apps/api/src/modules/workspace/workspace.controller.ts) · `restoreRelease` |
<!-- END GENERATED API -->

## Go WhatsApp workspace contract

`GET /channels/whatsapp/tools/catalogue` returns the 97 pinned native operation definitions plus the CRM history-import workflow. It includes typed fields, effective permissions and managed-control explanations; it is not an arbitrary URL/method proxy. `POST .../accounts/:id/read/:operation` handles bounded reads. `POST .../accounts/:id/actions/:operation` requires `{parameters, body, requestKey: UUID, confirmed: true, files?, scheduledFor?}` and returns an operation or managed-schedule record. Files map only declared binary fields to actor/account-bound upload UUIDs. A reused request key with different content returns 409.

Uploads use multipart `file`, maximum 25 MiB. Media/files/events/history endpoints require authenticated message read permission. Native file paths/credentials are not browser transport locations; download tools retain files and return protected CRM URLs. Recent action records are creator-bound (super administrators can inspect a specific action). Cancellation succeeds only before dispatch. UNKNOWN means the provider may already have acted, not an invitation to retry.

Account additions retain existing connect/QR APIs; phone code, passkey status/response/confirm and explicit REMOVE device controls are added. The compatibility disconnect route now pauses CRM ownership, because the selected provider has no disconnect-without-logout endpoint. QR polling records the confirmed connected state; QR/code/assertion values are never persisted or audited.

Native schedule IDs in these tools are CRM UUIDs. List/get/pause/resume/cancel operate on CRM schedules; native schedule fields are removed before remote dispatch. Chatwoot config/status/sync operations use the managed bridge. Its per-account public callback requires X-Chatwoot-Webhook-Secret plus matching remote account/inbox and a verified chat binding; echoes/private messages are ignored. Replies enter MessageService, including same-origin Active Storage media. Setup-secret responses require channels.manage and no-store.

`POST /channels/whatsapp/mcp/:accountId` supports basic stateless JSON Streamable HTTP initialize/ping/tools/list/tools/call, session authentication, Origin checks, declared permissions, queued writes and action status/cancel tools. GET returns 405. The optional stdio bridge signs in using process environment credentials and keeps its session in memory. It is not an OAuth server or evidence of an externally connected MCP client. See GOWA-MIGRATION.md.
