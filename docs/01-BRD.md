# Business Requirements — Support CRM

Status: implementation baseline, 22 October 2026. Owner: project owner. This document separates business needs from the detailed product contract in `02-PRD.md`. The canonical `../PROJECT_SPEC.md` remains authoritative; an explicit later user instruction takes precedence.

## Problem and purpose

Support staff operate multiple WhatsApp numbers, groups and customer relationships. Switching between phones, spreadsheets and separate automation tools makes ownership, outstanding work and response quality difficult to follow. Support CRM brings the account connection, inbox, customer context, human assignment, knowledge and operational controls into one web application.

## People and outcomes

| Person | Business outcome |
|---|---|
| Owner / administrator | Connect and manage support accounts without opening the gateway dashboard; control access and automation |
| Support manager | Understand queues and coverage; assign work, review leave and investigate failures |
| Support executive | Find the right conversation, customer and verified answer, then reply or hand over |
| Knowledge reviewer | Review sources and proposals before answers become customer-facing |
| Billing operator | Track client terms, balances and receipts without mixing currencies |

## Business rules

- The web app is the operator surface. Account creation, QR display, connection progress, reconnect and logout must be available there to authorized users.
- Only real provider state can establish a connected account. Displaying or scanning a QR is not itself confirmation.
- Human takeover and the emergency stop constrain automated replies. Knowledge proposals remain subject to review.
- An observed phone number is an identity, not an automatically confirmed customer.
- Every important configuration change is permission-controlled and attributable. Passwords and provider credentials must not appear in browser responses or audit payloads.
- Payment records do not charge money. Reversed receipts remain in history; monetary totals remain separated by currency.
- Scheduled availability is not proof of attendance. Inferred mood/effectiveness is not certain evidence.
- This checkout currently has one workspace. Multiple accounts do not imply project or tenant isolation.

## Scope

Current scope: polish the complete existing console, preserve its working integrations, make the WhatsApp connection journey obvious, document actual architecture and contracts, and establish repeatable implementation/review rules. Existing billing, scheduling, client, knowledge and automation features remain available.

The wider feature inventory and its unfinished items are tracked in `FEATURE_AUDIT_2026-10-22.md`. Additional channels, message-media storage, Google Sheets and project isolation are separate implementation phases; their absence must not be hidden behind decorative controls.

## Success measures

Measure after real usage: time to connect a number, connection failure rate, time to locate and assign work, human response intervals, failed sends/jobs and knowledge review throughput. No invented baseline, growth percentage or target completion claim is shown in the UI. The current visual release is accepted against `02-PRD.md`, `06-UI-UX-DESIGN.md` and `10-TESTING-DEPLOYMENT.md`.
