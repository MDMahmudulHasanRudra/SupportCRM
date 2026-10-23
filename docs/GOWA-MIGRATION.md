# Go WhatsApp replacement

Owner request: replace the OpenWA runtime with https://github.com/aldinokemal/go-whatsapp-web-multidevice and expose its supported features inside Support CRM.

Pinned upstream: **v9.6.0**, commit `62e319d55cc13d800a9859bfc83eb90bbddf4ef0`. Image index: `ghcr.io/aldinokemal/go-whatsapp-web-multidevice@sha256:6a213a3434f1d94f98b4ee90ee2c71fa391f715ff31bf00734a6240859fe10ba`. Source-derived contract snapshot and MIT attribution are in `gateway/` beside this document. Main-branch features not present in this release are not advertised as working integrations.

## Migration contract

- Keep CRM account IDs, conversations, customers, billing, assignments, message history and audit. Legacy gateway sessions/volumes are preserved as rollback material; they are not Go WhatsApp sessions. Each account needs an owner-controlled new pairing. Never automate a phone scan.
- The new gateway is internal, authenticated with an environment-only Basic credential. Browser requests stay behind CRM auth and permissions. Device-scoped calls always carry the CRM-bound device ID; never use the gateway's single-device fallback.
- Provision a distinct encrypted webhook secret per device. Verify `X-Hub-Signature-256` against exact raw bytes and bind the signed session/device to the account. Upstream has no signed delivery timestamp; deduplicate signed body fingerprints rather than pretending old message timestamps are delivery timestamps.
- Preserve queues, ownership, human control, capabilities, rate policies and emergency stops. Provider sends lacking idempotency must not be blindly retried after ambiguous network outcomes. Credential-bearing pairing material stays out of logs, audits and retained screenshots.
- Autonomous provider replies, public provider UI/MCP, and independent Chatwoot reply delivery are disabled in the managed deployment. Feature exposure must use permission-bound CRM workflows. Optional external-service integrations cannot be declared connected without actual configuration and acceptance.

## Verified upstream limits

- No REST endpoint disconnects while retaining pairing. Offer CRM ownership pause and explicit logout; do not implement disconnect as a disguised logout.
- Joined-group discovery is a single WhatsApp participating query with an upstream-documented approximately 500-group ceiling. Local paging of that result is not complete discovery of thousands of groups. Preserve existing CRM groups and allow explicit known-group detail refresh.
- Device lifecycle is REST/polling; no invented session/QR webhook events. QR images are fetched only from the configured gateway origin and rendered through the CRM response.
- This release exposes newsletter reads/unfollow, not an invented newsletter creation/follow API. Labels mentioned on later main-branch documentation are not inferred REST features.

## Implementation status

Source implementation now selects Go WhatsApp exclusively. The legacy vendored gateway and OpenWA HTTP client are removed. Compatibility-named normalization/contracts/signature helpers preserve old records and fixture imports; they do not activate a second transport. The 97-operation [feature map](GOWA-FEATURE-MAP.md) identifies direct tools and managed equivalents. The single `/whatsapp` window includes chats, rich media/composition/actions, status, channels, history browsing/import, labels, groups, schedules, devices and settings.

Private operations and files, encrypted recurring schedules, native mutations/presence/poll observations, optional Chatwoot configuration/history/mirror/replies and the authenticated MCP/stdio bridge are implemented. Chatwoot requires a public HTTPS service; reply media uses that service's same-origin Active Storage URLs. Link sharing defaults to text; native previews require exact trusted hosts in GOWA_LINK_PREVIEW_HOSTS. No unsupported provider REST label editing, newsletter creation/follow, native poll voting or disconnect API is invented.

**Runtime cutover, functional tests and browser/provider acceptance are deferred at the owner's request.** The new migrations have not been applied to the owner's running stack. Earlier legacy-provider/customer/inbox checks do not certify these changes. Static compile and offline generation results, actual limits and later acceptance gates are recorded in 09-IMPLEMENTATION-PLAN.md.

## Migrations and future cutover

Apply the existing customer/inbox migrations if pending, then 1788400004000-GoWhatsApp, 1788400005000-WhatsAppTools, 1788400006000-WhatsAppSchedules, 1788400007000-WhatsAppIntegrations and 1788400008000-ChannelLabels together with the matching API/web/worker. Preserve database/files/legacy session volumes before an actual cutover. New pairing uses the account's existing CRM ID. The migration clears legacy session/webhook identifiers; it does not transplant a Chromium/Baileys session into whatsmeow. No database reset or volume deletion is required.

## Optional MCP client

The native public MCP endpoint remains disabled. CRM provides basic authenticated stateless JSON Streamable HTTP at `/api/v1/channels/whatsapp/mcp/<CRM account UUID>`, plus `scripts/whatsapp-mcp-stdio.cjs` for clients that launch a stdio process. Configure its environment with CRM_URL (HTTPS, or localhost), CRM_WHATSAPP_ACCOUNT, CRM_USERNAME and CRM_PASSWORD. No password belongs in a committed client configuration. The process obtains a normal CRM session, keeps the cookie only in memory and signs out when stdin closes.

Tools/list filters by the actor's server permissions. Writes need a stable UUID requestKey and explicit confirmed=true, then enter the CRM queues. crm_action_status and crm_action_cancel inspect/control the returned action. Upload file IDs must come from the authenticated web upload flow. This does not implement OAuth, arbitrary native session access or server-push SSE. Protocol references: [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

Cutover review: the transport migration cancels saved legacy QUEUED sends and marks legacy SENDING outcomes uncertain, retaining their requests/history for review. It never replays them automatically through the new phone binding. The future local-start script stops API/worker writers and the project-owned retired gateway before migration; it retains the legacy volume. These script/database actions have not been executed in this phase.

Chatwoot configuration is saved disabled unless Enabled is explicitly selected. Set CRM_PUBLIC_URL to the browser-facing callback origin for a remote integration; API_BASE_URL remains the internal gateway callback origin. No external configuration has been activated here. The next local preview requires `scripts/start-local.ps1 -RebuildImages` because API dependencies changed.
