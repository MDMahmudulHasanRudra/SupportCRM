# Working in Support CRM

User instructions take precedence. `PROJECT_SPEC.md` is the canonical specification; preserve it and existing unrelated/uncommitted changes.

Before implementing a phase, read the relevant numbered documents in `docs/`: `01-BRD.md`, `02-PRD.md`, `03-TRD.md`, `04-SYSTEM-ARCHITECTURE.md`, `05-APP-FLOW.md`, `06-UI-UX-DESIGN.md`, `07-DATABASE-SCHEMA.md`, `08-API-CONTRACTS.md`, `09-IMPLEMENTATION-PLAN.md`, `10-TESTING-DEPLOYMENT.md`. Audit existing behavior before changing it.

All frontend work follows the shared Indigo Workspace tokens in `apps/web/src/theme.css` and presentation rules in `design-system.css`; use shared components and real behavior, accessible names/focus and light/dark responsive states. Keep account addition, real QR display and supported lifecycle actions usable from the web application.

Only `apps/api/src/modules/channel/whatsapp` knows the gateway. Decisions do not send directly. Preserve queues, idempotency, ownership/capability checks, human control, server permissions, encryption and audit. Do not claim multi-project isolation, missing integrations, provider success or browser verification without evidence.

After each implementation phase, review against PRD IDs, run checks appropriate to the changed layer, update affected requirements/contracts/flow/schema documents and record actual results/limits in `docs/09-IMPLEMENTATION-PLAN.md`. Update generated API/schema inventories with `python scripts/sync-reference-docs.py`; verify with `pnpm docs:check`. Backend changes need appropriate backend tests; presentation-only changes need frontend checks rather than unrelated live sends.

No extra user approval is required for already-authorized reversible implementation work. Ask only when missing information or a consequential unapproved action actually requires it. Do not start a production deployment or link a real phone merely to validate styling.
