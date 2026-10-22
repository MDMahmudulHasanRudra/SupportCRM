# Support CRM documentation

Start with the canonical [project specification](../PROJECT_SPEC.md). The current implementation follows this documentation system:

| Document | Purpose |
|---|---|
| [01 — BRD](01-BRD.md) | Business problem, people, outcomes and rules |
| [02 — PRD](02-PRD.md) | Product requirements and measurable acceptance criteria |
| [03 — TRD](03-TRD.md) | Technology, infrastructure, security and technical constraints |
| [04 — System architecture](04-SYSTEM-ARCHITECTURE.md) | Boundaries, workers, queues and integration/data paths |
| [05 — App flow](05-APP-FLOW.md) | Navigation, account pairing and real button/workflow behavior |
| [06 — UI/UX design](06-UI-UX-DESIGN.md) | Shared palette, typography, components and responsive rules |
| [07 — Database schema](07-DATABASE-SCHEMA.md) | Relationships, ownership, invariants and generated schema references |
| [08 — API contracts](08-API-CONTRACTS.md) | Authentication, validation, errors and generated endpoint inventory |
| [09 — Implementation plan](09-IMPLEMENTATION-PLAN.md) | Phases, acceptance review and actual verification results |
| [10 — Testing/deployment](10-TESTING-DEPLOYMENT.md) | Automated, browser, device and release/rollback gates |

Before a phase, read its relevant requirements and source. After implementation, review acceptance criteria, run checks and update affected documents and phase evidence. Root [AGENTS.md](../AGENTS.md) records this workflow.

Run `python scripts/sync-reference-docs.py` after API/schema changes, then `pnpm docs:check`. Run `pnpm design:check` after palette changes. Neither automated check replaces manual design/product review.

The [feature audit](FEATURE_AUDIT_2026-10-22.md) tracks the remaining wider feature backlog. [Workspace setup](WORKSPACE_RELEASE.md) covers the existing migration/startup commands. Older phase reports document historical checks; their statuses should not override the current acceptance record.
