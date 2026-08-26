# Phase 5L — Real-WhatsApp Validation

**Status: 4 PASS, 0 FAIL, 11 BLOCKED.** No item was converted from BLOCKED to PASS.

The eleven blocked items are blocked on one physical fact: **nobody has paired a WhatsApp account,
and there is no dedicated test group with test participants to send messages from.** Everything that
could be executed without a phone was executed against the real gateway, and the environment has
been prepared so that the remaining work is a pairing scan and a handful of test messages.

Harness: [`scripts/validate-phase5-whatsapp.mjs`](../scripts/validate-phase5-whatsapp.mjs) —
re-runnable, in two passes, and it refuses to send anything until isolation is proven.

---

## 1. Results

| # | Test | Result | Evidence |
|---|---|---|---|
| S1 | No broadly-scoped rule is active | **PASS** | `GET /automation/rules?status=ACTIVE` → 0 rules. The one global rule created during UI validation was deleted before this run |
| S2 | Automation is off by default for new conversations | **PASS** | `conversations.automationEnabled` and `aiEnabled` both `DEFAULT false` in the live schema; `ConversationResolver` never overrides them; the engine ANDs conversation × group × profile. **Connecting the account cannot cause a reply to anyone** |
| S3 | Gateway reachable, authenticating, rejecting anonymous calls | **PASS** | `GET /health` → 200; `GET /api/sessions` with the key → 200; without it → 401 |
| S4 | The account is connected | **BLOCKED** | Session `final-validation` exists on the gateway with its number and display name retained, `status: disconnected`. Support CRM shows `RECOVERY_FAILED` (5 recovery attempts, stored status `UNKNOWN`). Reconnecting requires a person |
| 1 | Rule match produces exactly one reply | **BLOCKED** | Needs a real inbound message from a test participant |
| 2 | Delivery state advances on the real gateway | **BLOCKED** | Same |
| 3 | An unmatched message produces no reply | **BLOCKED** | Same |
| 4 | AI answers from published knowledge | **BLOCKED** | Same, **and** `AI_PROVIDER=none` — no provider is configured, so there is no AI path to exercise |
| 5 | Low confidence escalates instead of guessing | **BLOCKED** | Same as 4 |
| 6 | Human takeover silences automation | **BLOCKED** | Needs a real inbound message |
| 7 | A replayed webhook produces no duplicate anything | **BLOCKED** | Needs a real delivery to replay. `OPENWA_WEBHOOK_SECRET` is present, so the replay will be correctly signed when there is one |
| 8 | The reply coming back does not trigger the rule again | **BLOCKED** | Needs a real reply to echo |
| 9 | The trace explains the decision without the database | **BLOCKED** *(for a real decision)* | The trace was exercised live against seeded decisions during Phase 5J; it has not been read against a real WhatsApp decision |
| 10 | Realtime pushes the decision to the browser | **BLOCKED** | Needs a real decision to push |
| 11 | No credential appears in any real payload | **PASS** | 5 live API surfaces (accounts overview, decisions, decision status, escalations, automation rules) scanned against every secret in `.env` longer than 7 characters: none present. The web bundle was scanned separately and is clean |

---

## 2. Why this is blocked, precisely

Two separate blockers, both physical.

**The account is not paired.** The gateway retains the session record for `final-validation`
(number and display name intact) but reports `disconnected`. WhatsApp Web sessions are re-linked by
scanning a pairing code on the handset. There is no API call, and no amount of configuration, that
substitutes for a person holding the phone.

**There is no dedicated test group, and no test participant.** This is the harder one, and it is
not solved by pairing:

- The account on this gateway is a **live personal WhatsApp account** (`docs/REAL_WHATSAPP_FINAL_VALIDATION_REPORT.md`
  records that linking it previously pulled in 9 real groups and 19 real inbound direct messages,
  since purged). Its real groups and contacts are not a test environment.
- A message the CRM's *own* account sends is classified `BOT_MESSAGE` and is deliberately excluded
  from the decision pipeline — which is the anti-loop guarantee working correctly. So the account
  **cannot test itself**: a customer-side inbound message must come from a *different* number.

Therefore a genuine rule-match test needs **a second WhatsApp number the operator controls**, in a
group containing only numbers the operator controls. Neither exists today.

---

## 3. What was prepared, so the remaining work is small

| Prepared | State |
|---|---|
| Validation gateway | `openwa-validation` container running, own volume, bound to `127.0.0.1:2785` |
| Gateway ← CRM | Verified: the API reaches `http://127.0.0.1:2785` |
| Gateway → CRM | Verified: `host.docker.internal:4000` answers from inside the gateway container |
| Safety | Every active automation rule deleted; 0 active rules remain. The demo profile from the UI pass was removed |
| Harness | Written and executed (pass 1). Pass 2 is a single command |
| Stack | API, worker and web running on the host, pointed at the local gateway |

**A networking detail that will otherwise cost an hour:** `.env` sets
`OPENWA_BASE_URL=http://openwa-validation:2785` and `API_BASE_URL=http://api:4000`. Those are Docker
network names — correct when the whole stack runs under Compose, unreachable when the API runs on
the host. The host-run stack is currently started with
`OPENWA_BASE_URL=http://127.0.0.1:2785` and `API_BASE_URL=http://host.docker.internal:4000`, which is
what makes both directions work. Running everything under Compose instead is equally valid and needs
no overrides.

---

## 4. To unblock — the operator's part

Only steps 1–3 need a human; the harness does the rest.

**1. Create a dedicated test group on WhatsApp.** Name it something unmistakable, e.g.
`CRM Phase 5 Test`. It must contain **only numbers you control** — the test account plus at least one
second number you can send from. Do not use an existing group.

**2. Pair the account.** With the gateway running:

```bash
docker compose -f docker-compose.yml -f docker-compose.validation.yml up -d openwa-validation
```

Open the console at `http://localhost:3000`, go to WhatsApp Accounts, press **Connect** on
`final-validation`, and scan the pairing code with the test handset.

**3. Run pass 2.** It prompts you for each message and verifies the result before asking for the
next:

```bash
node scripts/validate-phase5-whatsapp.mjs --api http://localhost:4000 --gateway http://127.0.0.1:2785 --session final-validation --group "CRM Phase 5 Test" --i-authorise-replies-in-this-group
```

The harness will refuse to proceed unless the named group matches exactly one synced group, has no
more than four participants, and you passed the authorisation flag. It creates one rule scoped to
that group only, enables automation for that group and that conversation only, walks the ten tests,
and switches everything back off afterwards.

To undo everything without running tests:

```bash
node scripts/validate-phase5-whatsapp.mjs --group "CRM Phase 5 Test" --cleanup
```

---

## 5. Safety properties, verified rather than assumed

These are the reasons connecting the account is safe even before the test group exists.

| Property | Verified how |
|---|---|
| No rule can fire against any conversation | 0 ACTIVE rules; the global demo rule was deleted (`automation_rules` is empty) |
| A new conversation cannot be answered automatically | `automationEnabled` defaults `false` at the database level, is never set at creation, and the engine requires it |
| A group's real contacts cannot be replied to | Both of the above, plus the harness's refusal to act on any group but the one named and authorised |
| The system cannot answer itself | `fromMe` → `BOT_MESSAGE`, excluded from the pipeline before any rule is consulted |
| The gateway's own automation engine is off | `MCP_ENABLED: 'false'` in `docker-compose.validation.yml` |
| The validation gateway is isolated | Own named volume, published on `127.0.0.1` only, no production session on it |

---

## 6. Finding: a group-level automation switch does not enable anything on its own

Found while writing the runbook, not during a test run. It is a design gap, it is not a crash, and
it has **not** been changed — altering when the system talks to customers is not a change to make
unilaterally during a safety validation.

The engine computes:

```ts
const automationEnabled =
  conversation.automationEnabled &&
  (group ? group.automationEnabled : true) &&
  (profile ? profile.automationEnabled : true);
```

`conversations.automationEnabled` defaults to `false` and `ConversationResolver` never sets it from
the group. So the group-level switch is a **veto, not an enabler**: turning automation on for a group
— including the bulk operation that does it across thousands of groups — changes nothing observable
until somebody also opts in each conversation individually. An operator who bulk-enables automation
for 3,000 groups gets zero automated replies and no indication why.

**Recommended fix** (one line, plus a regression test): have a new conversation inherit the group's
switches at creation.

```ts
automationEnabled: group?.automationEnabled ?? false,
aiEnabled: group?.aiEnabled ?? false,
```

A direct conversation has no group and stays `false`, so "off by default" is preserved for one-to-one
chats. An explicit later change to a conversation still wins, so "most specific wins" is preserved
too. This is deliberately left for a decision rather than applied, because it makes automation
*easier* to trigger, which is the wrong direction to move without the account owner's agreement.

Until it is changed, the runbook above enables the conversation explicitly, and the harness does the
same — which is also why step 3 asks for a throwaway `hello` before the trigger: the conversation has
to exist before it can be opted in.

---

## 7. Defects found and fixed during this pass

None in the decision engine. Two environment defects were found and fixed while preparing the run,
both of which would have blocked the operator:

1. **The CRM could not reach the gateway from the host** — Docker network names in `.env`. Resolved
   by launching the host stack with loopback addresses; documented in §3 so it is not rediscovered.
2. Nothing else. No behaviour of the engine was changed during Phase 5L.

The five defects found earlier in Phase 5 are recorded in `docs/PHASE_5_REPORT.md` §12.

---

## 8. Database state after this pass

Removed:

- The `Office hours reply` rule (GLOBAL, ACTIVE) created during UI validation, and its versions.
- The `ISP Standard` automation profile created during UI validation.
- The six `UI demo group` rows, their bulk job and its job items.
- The `Scheduled maintenance notice` broadcast draft.

Remaining, untouched:

- Three channel accounts (`validation-test`, `ux-smoke-test`, `final-validation`) — pre-existing.
- One conversation and one message — pre-existing, from an earlier phase.
- Zero groups, zero automation rules, zero automation profiles, zero decision logs, zero escalations,
  zero broadcasts.

Nothing was created by this pass that still exists.

---

## 9. Conclusion

The decision engine is **not** validated against real WhatsApp, and this document does not claim it
is. What is established:

- Every automated gate passes (214 unit, 348 integration, 5 web — see `docs/PHASE_5_REPORT.md`).
- The behaviour each blocked item would confirm is covered by integration tests against real
  PostgreSQL, Redis and BullMQ — which is evidence, not proof, that it holds against real WhatsApp.
- The environment, the safety preconditions and the harness are ready; the remaining work is a
  pairing scan, a test group, and roughly six messages.

**Phase 6 should not be started until items 1–3 and 6–10 have actually been observed.** Items 4 and 5
additionally require an AI provider to be configured, and remain blocked on that regardless of
pairing.
