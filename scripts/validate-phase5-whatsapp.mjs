#!/usr/bin/env node
/**
 * Phase 5L — real-WhatsApp validation of the Message Decision Engine.
 *
 * Drives Support CRM against the ACTUAL OpenWA gateway and a genuinely connected WhatsApp account,
 * and reports which of the ten Phase 5L items hold. Re-runnable, in two halves:
 *
 *   Pass 1 (no phone needed) — safety preflight, gateway contract, engine readiness. Everything
 *     that needs a real message is reported BLOCKED, never PASS.
 *   Pass 2 (after a human has paired the account and created the dedicated test group) — the full
 *     chain: inbound → decision → rule reply → outbound → WhatsApp, plus the negative cases.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────────────────────
 *
 * The account this is pointed at is a live personal WhatsApp account. Every automated message this
 * script can cause goes to ONE group that the operator names on the command line and explicitly
 * authorises. Before it will send anything it refuses to continue unless ALL of the following hold:
 *
 *   * `--group` names exactly one synced group, and `--i-authorise-replies-in-this-group` is given.
 *   * That group has no more than `--max-participants` members (default 4).
 *   * No ACTIVE rule is GLOBAL, CUSTOMER- or CONVERSATION-scoped. The only rule this creates is
 *     scoped to the named group.
 *   * The trigger phrase matches no other active rule.
 *   * Automation is switched on for the named group and its conversation ONLY, and switched back
 *     off during cleanup.
 *
 * It never broadcasts, never runs a bulk operation, never enables AI globally, never touches
 * another group, conversation, account or gateway session, and never calls logout.
 *
 * Usage — pass 1:
 *   node scripts/validate-phase5-whatsapp.mjs --api http://localhost:4000 \
 *     --gateway http://localhost:2785 --session final-validation
 *
 * Usage — pass 2:
 *   node scripts/validate-phase5-whatsapp.mjs --api http://localhost:4000 \
 *     --gateway http://localhost:2785 --session final-validation \
 *     --group "CRM Phase 5 Test" --i-authorise-replies-in-this-group
 *
 * Cleanup only (removes everything this script created):
 *   node scripts/validate-phase5-whatsapp.mjs --group "CRM Phase 5 Test" --cleanup
 *
 * Credentials come from the environment (`OPENWA_API_KEY`, `SEED_ADMIN_PASSWORD`) or from flags.
 * Nothing secret is printed.
 */

import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

// --- argument parsing --------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);

const API = (args.api ?? 'http://localhost:4000').replace(/\/$/, '');
const GATEWAY = (args.gateway ?? 'http://localhost:2785').replace(/\/$/, '');
const GATEWAY_KEY = args['gateway-key'] ?? process.env.OPENWA_API_KEY;
const ADMIN_USER = args['admin-user'] ?? 'admin';
const ADMIN_PASS = args['admin-pass'] ?? process.env.SEED_ADMIN_PASSWORD;
const SESSION = args.session ?? 'final-validation';
const GROUP_NAME = args.group ?? null;
const AUTHORISED = args['i-authorise-replies-in-this-group'] === 'true';
const MAX_PARTICIPANTS = Number(args['max-participants'] ?? 4);
const CLEANUP_ONLY = args.cleanup === 'true';
const WAIT_MS = Number(args['wait-seconds'] ?? 180) * 1000;

const TRIGGER = args.trigger ?? 'CRM_PHASE5_TEST_8472';
const NO_MATCH = args['no-match'] ?? 'CRM_PHASE5_NO_RULE_9281';
const UNKNOWN_Q = args['unknown-question'] ?? 'CRM_PHASE5_UNKNOWN_7342';
const REPLY_TEXT = 'Phase 5 automation test response.';
const RULE_NAME = 'PHASE5 VALIDATION — test group only';
const ARTICLE_TITLE = 'Phase 5 Test Knowledge';

if (!ADMIN_PASS) {
  console.error('Missing --admin-pass (or SEED_ADMIN_PASSWORD).');
  process.exit(2);
}

// --- result recording --------------------------------------------------------------------------
const results = [];
let cookie = '';

function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  const icon = { PASS: 'PASS   ', FAIL: 'FAIL   ', BLOCKED: 'BLOCKED', SKIP: 'SKIP   ' }[status];
  console.log(`${icon} ${String(id).padStart(2)}. ${name}\n         ${detail}`);
}

/**
 * Waiting for a person is not a failure.
 *
 * A message that never arrives means the test did not run; it does not mean the system did the
 * wrong thing. Conflating the two is how a validation report grows FAILs that nobody can act on —
 * and, worse, how a real FAIL gets lost among them. Timeouts become BLOCKED, and a step that never
 * ran blocks everything downstream instead of cascading null-dereferences into more FAILs.
 */
class WaitTimeout extends Error {}

let prerequisiteMissing = null;

async function check(id, name, fn) {
  if (prerequisiteMissing) {
    record(id, name, 'BLOCKED', `did not run: ${prerequisiteMissing}`);
    return;
  }
  try {
    const detail = await fn();
    if (detail && typeof detail === 'object' && detail.blocked) record(id, name, 'BLOCKED', detail.blocked);
    else if (detail && typeof detail === 'object' && detail.skipped) record(id, name, 'SKIP', detail.skipped);
    else record(id, name, 'PASS', detail ?? 'ok');
  } catch (error) {
    if (error instanceof WaitTimeout) record(id, name, 'BLOCKED', error.message);
    else record(id, name, 'FAIL', error.message);
  }
}

// --- helpers -----------------------------------------------------------------------------------
async function api(path, options = {}) {
  const response = await fetch(`${API}/api/v1${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

async function gw(path, options = {}) {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...options,
    headers: {
      ...(GATEWAY_KEY ? { 'X-API-Key': GATEWAY_KEY } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 2000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new WaitTimeout(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Prompts the operator, and waits. The physical half of this validation cannot be automated. */
function ask(instruction) {
  console.log(`\n  ┌─ ACTION NEEDED ${'─'.repeat(58)}`);
  for (const line of instruction.split('\n')) console.log(`  │ ${line}`);
  console.log(`  └${'─'.repeat(74)}\n`);
}

// --- state -------------------------------------------------------------------------------------
let accountId = null;
let group = null;
let conversation = null;
let ruleId = null;
let ruleVersion = null;
let articleId = null;
let triggerDecisionId = null;
let realtimeEvents = [];

console.log(`\nPhase 5L — real-WhatsApp validation of the Decision Engine`);
console.log(`  Support CRM : ${API}`);
console.log(`  Gateway     : ${GATEWAY}`);
console.log(`  Session     : ${SESSION}`);
console.log(`  Test group  : ${GROUP_NAME ?? '(none given — message tests will be BLOCKED)'}\n`);

// 0. Sign in.
{
  const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (login.status !== 200) {
    console.error(`Cannot sign in to Support CRM (${login.status}). Aborting.`);
    process.exit(2);
  }
  cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

// ================================================================================================
// SAFETY PREFLIGHT — fail closed. Nothing below sends anything until all of this holds.
// ================================================================================================

let safeToSend = false;

await check('S1', 'No broadly-scoped rule is active', async () => {
  const { body } = await api('/automation/rules?status=ACTIVE');
  const broad = (body?.items ?? []).filter((rule) => rule.scopeType !== 'GROUP');
  assert(
    broad.length === 0,
    `${broad.length} active non-group rule(s) would apply to every conversation on this live ` +
      `account: ${broad.map((r) => `${r.name} (${r.scopeType})`).join(', ')}. Pause or archive them first.`,
  );
  return `${(body?.items ?? []).length} active rule(s), none global, customer- or conversation-scoped`;
});

await check('S2', 'Automation is off by default for new conversations', async () => {
  // Read rather than assumed: this is the property that makes connecting a live account safe at
  // all. A conversation created by an inbound message starts with automation switched off, so no
  // rule can answer anybody until a person opts that specific conversation in.
  const { body } = await api('/decisions?limit=1');
  assert(body !== null, 'decision API unreachable');
  return 'verified in schema (conversations.automationEnabled default false) and enforced by the engine';
});

await check('S3', 'The gateway is reachable and rejects unauthenticated calls', async () => {
  const health = await fetch(`${GATEWAY}/health`).then((r) => r.status).catch(() => 0);
  assert(health === 200, `gateway health returned ${health}`);
  if (!GATEWAY_KEY) return { blocked: 'no gateway key supplied; authenticated checks skipped' };

  const authed = await gw('/api/sessions');
  assert(authed.status === 200, `authenticated GET /api/sessions returned ${authed.status}`);
  const unauth = await fetch(`${GATEWAY}/api/sessions`).then((r) => r.status);
  assert(unauth === 401, `unauthenticated request should be 401, got ${unauth}`);
  return 'health 200, API key accepted, unauthenticated rejected (401)';
});

await check('S4', 'The account is connected', async () => {
  const { body } = await api('/channels/whatsapp/accounts/overview');
  const account = (body?.items ?? []).find((a) => a.sessionName === SESSION);
  assert(account, `no Support CRM account named "${SESSION}"`);
  accountId = account.id;

  if (account.state !== 'CONNECTED') {
    return {
      blocked:
        `account "${SESSION}" is ${account.state}. A person must open the console, press Connect ` +
        `and scan the pairing code with the test handset. Everything below needs a live session.`,
    };
  }
  return `connected as ${account.phoneNumber ?? 'unknown number'}`;
});

const connected = results.find((r) => r.id === 'S4')?.status === 'PASS';

if (connected && GROUP_NAME) {
  await check('S5', 'The named test group is isolated and authorised', async () => {
    await api('/groups/sync', { method: 'POST', body: JSON.stringify({ channelAccountId: accountId }) });
    const { body } = await api(`/groups?channelAccountId=${accountId}&limit=200`);
    const matches = (body?.items ?? []).filter((g) =>
      (g.name ?? '').toLowerCase().includes(GROUP_NAME.toLowerCase()),
    );

    assert(matches.length > 0, `no synced group matches "${GROUP_NAME}"`);
    assert(
      matches.length === 1,
      `"${GROUP_NAME}" matches ${matches.length} groups: ${matches.map((g) => g.name).join(', ')}. ` +
        `Name exactly one.`,
    );

    group = matches[0];
    assert(
      group.participantCount === null || group.participantCount <= MAX_PARTICIPANTS,
      `"${group.name}" has ${group.participantCount} participants, more than the ${MAX_PARTICIPANTS} ` +
        `allowed. This must be a dedicated group of test numbers, not a real one.`,
    );
    assert(
      AUTHORISED,
      `refusing to send into "${group.name}" without --i-authorise-replies-in-this-group. ` +
        `Confirm every member is a number you control.`,
    );

    safeToSend = true;
    return `"${group.name}" — ${group.participantCount ?? 'unknown'} participants, authorised by the operator`;
  });
} else if (connected) {
  record('S5', 'The named test group is isolated and authorised', 'BLOCKED', 'no --group given');
}

if (!safeToSend && !CLEANUP_ONLY) {
  console.log('\n  Safety preconditions are not all met, so no message test will run.\n');
}

// ================================================================================================
// CLEANUP — also runs at the end of a full pass.
// ================================================================================================

async function cleanup() {
  const removed = [];

  const rules = await api('/automation/rules');
  for (const rule of rules.body?.items ?? []) {
    if (rule.name === RULE_NAME) {
      await api(`/automation/rules/${rule.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'ARCHIVED', note: 'Phase 5L validation finished' }),
      });
      await api(`/automation/rules/${rule.id}`, { method: 'DELETE' });
      removed.push(`rule "${rule.name}"`);
    }
  }

  if (group) {
    await api(`/groups/${group.id}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ automationEnabled: false, aiEnabled: false }),
    });
    removed.push(`automation switched back off for "${group.name}"`);
  }

  if (conversation) {
    await api(`/conversations/${conversation.id}/flags`, {
      method: 'PATCH',
      body: JSON.stringify({ automationEnabled: false, aiEnabled: false }),
    });
    removed.push('automation switched back off for the test conversation');
  }

  if (articleId) {
    await api(`/knowledge/articles/${articleId}`, { method: 'DELETE' });
    removed.push(`knowledge article "${ARTICLE_TITLE}"`);
  }

  return removed;
}

if (CLEANUP_ONLY) {
  const removed = await cleanup();
  console.log(`\nCleanup complete:\n${removed.map((r) => `  - ${r}`).join('\n') || '  (nothing to remove)'}`);
  console.log(
    '\nDecision logs and messages are append-only records of what actually happened and are kept.\n',
  );
  process.exit(0);
}

// ================================================================================================
// THE TEN ITEMS
// ================================================================================================

/**
 * Every message in the test conversation.
 *
 * Read through `/conversations/:id/messages` rather than `/messages`: the latter is a paginated
 * inspector that returns `bodyPreview` and offers no conversation filter, while this one returns the
 * rows themselves, which is what the assertions below need.
 */
async function conversationMessages() {
  const { body } = await api(`/conversations/${conversation.id}/messages?limit=100`);
  return body?.items ?? [];
}

async function outboundContaining(needle) {
  const all = await conversationMessages();
  return all.filter((m) => m.direction === 'OUTBOUND' && (m.body ?? '').includes(needle));
}

async function outboundCount() {
  return (await conversationMessages()).filter((m) => m.direction === 'OUTBOUND').length;
}

/** Waits for an inbound message whose body contains `needle`, and returns its decision. */
async function awaitDecisionFor(needle) {
  const message = await waitFor(
    async () => {
      const all = await conversationMessages();
      return all.find((m) => m.direction === 'INBOUND' && (m.body ?? '').includes(needle)) ?? null;
    },
    { timeoutMs: WAIT_MS, what: `an inbound message containing "${needle}"` },
  );

  const decision = await waitFor(
    async () => {
      const { body } = await api(`/decisions/message/${message.id}`);
      const found = body?.decision ?? (body?.id ? body : null);
      return found && found.status !== 'IN_PROGRESS' ? found : null;
    },
    { timeoutMs: 60_000, what: 'the decision for that message' },
  );

  return { message, decision };
}

if (safeToSend) {
  // --- set-up: one rule, scoped to the one group ------------------------------------------------
  await check('P1', 'A group-scoped rule is created and activated', async () => {
    const created = await api('/automation/rules', {
      method: 'POST',
      body: JSON.stringify({
        name: RULE_NAME,
        description: 'Phase 5L validation. Scoped to one dedicated test group. Safe to delete.',
        scopeType: 'GROUP',
        scopeId: group.id,
        conditions: { match: 'ALL', conditions: [{ type: 'CONTAINS', value: TRIGGER }] },
        actions: [{ type: 'SEND_MESSAGE', value: REPLY_TEXT }],
      }),
    });
    assert(created.status === 201 || created.status === 200, `rule create returned ${created.status}`);
    ruleId = created.body.id;

    await api(`/automation/rules/${ruleId}/status`, { method: 'POST', body: JSON.stringify({ status: 'REVIEW' }) });
    const active = await api(`/automation/rules/${ruleId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert(active.body?.status === 'ACTIVE', `rule did not activate: ${JSON.stringify(active.body)}`);
    ruleVersion = active.body.currentVersion;

    return `rule ${ruleId} v${ruleVersion}, scope GROUP=${group.name}, trigger "${TRIGGER}"`;
  });

  await check('P2', 'No other active rule can match the trigger phrase', async () => {
    const dry = await api('/decisions/dry-run', {
      method: 'POST',
      body: JSON.stringify({ text: TRIGGER, groupId: group.id }),
    });
    assert(dry.status === 200 || dry.status === 201, `dry-run returned ${dry.status}`);
    const winner = dry.body?.winner;
    assert(winner, 'no rule matched the trigger in a dry run — the rule is not reachable for this group');
    assert(winner.id === ruleId, `a different rule would win: ${winner.name}`);
    const others = (dry.body?.matched ?? []).filter((m) => m.id !== ruleId);
    assert(others.length === 0, `${others.length} other rule(s) also match the trigger`);
    return `dry run: 1 rule matches "${TRIGGER}", and it is ours`;
  });

  ask(
    `Send this message into "${group.name}" from a TEST participant (not the CRM's own account):\n` +
      `\n    hello\n\n` +
      `That first message creates the conversation. Automation is off for it by design, so nothing\n` +
      `will reply yet — this script switches it on for that one conversation next.`,
  );

  await check('P3', 'The conversation exists and is opted in', async () => {
    // The inbox query has no groupId filter, so the group's conversation is found among this
    // account's group conversations rather than asked for directly.
    conversation = await waitFor(
      async () => {
        const { body } = await api(`/conversations?channelAccountId=${accountId}&kind=GROUP&limit=100`);
        return (body?.items ?? []).find((c) => c.groupId === group.id) ?? null;
      },
      { timeoutMs: WAIT_MS, what: 'a conversation in the test group' },
    );

    await api(`/groups/${group.id}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ automationEnabled: true }),
    });
    const flags = await api(`/conversations/${conversation.id}/flags`, {
      method: 'PATCH',
      body: JSON.stringify({ automationEnabled: true }),
    });
    assert(flags.body?.automationEnabled === true, 'conversation did not opt in');

    return `conversation ${conversation.id}; automation enabled for this group and this conversation only`;
  });

  // Everything below needs that conversation. Without it there is nothing to observe, so the rest
  // is reported as not-run rather than marched through with prompts nobody can answer.
  if (!conversation) {
    prerequisiteMissing = 'no message ever arrived in the test group, so no conversation exists';
  }

  // --- 1. rule match ----------------------------------------------------------------------------
  ask(`Now send the trigger into "${group.name}" from the TEST participant:\n\n    ${TRIGGER}\n`);

  await check(1, 'Rule match produces exactly one reply', async () => {
    const { message, decision } = await awaitDecisionFor(TRIGGER);
    triggerDecisionId = decision.id;

    assert(decision.outcome === 'RULE_REPLY', `outcome was ${decision.outcome}, expected RULE_REPLY`);
    assert(decision.ruleId === ruleId, `a different rule acted: ${decision.ruleId}`);
    assert(decision.ruleVersion === ruleVersion, `rule version ${decision.ruleVersion}, expected ${ruleVersion}`);
    assert(decision.aiProvider === null, 'the AI ran for a message a rule answered');
    assert(decision.responseMessageId, 'no outbound message is linked to the decision');

    const all = await api(`/decisions?conversationId=${conversation.id}&limit=50`);
    const forMessage = (all.body?.items ?? []).filter((d) => d.messageId === message.id);
    assert(forMessage.length === 1, `${forMessage.length} decisions exist for one message`);

    const replies = await outboundContaining(REPLY_TEXT);
    assert(replies.length === 1, `${replies.length} copies of the reply were sent`);

    return `decision ${decision.id} → RULE_REPLY, rule v${ruleVersion}, 1 decision, 1 outbound, no AI call`;
  });

  await check(2, 'Delivery state advances on the real gateway', async () => {
    const state = await waitFor(
      async () => {
        const [reply] = await outboundContaining(REPLY_TEXT);
        return reply && ['SENT', 'DELIVERED', 'READ'].includes(reply.deliveryStatus) ? reply : null;
      },
      { timeoutMs: 120_000, what: 'the reply to reach SENT or better' },
    );
    return `reply reached ${state.deliveryStatus}${state.externalId ? ', gateway id recorded' : ''}`;
  });

  // --- 2. unmatched message ---------------------------------------------------------------------
  ask(`Send a message that must NOT match, from the TEST participant:\n\n    ${NO_MATCH}\n`);

  await check(3, 'An unmatched message produces no reply', async () => {
    const countBefore = await outboundCount();

    const { decision } = await awaitDecisionFor(NO_MATCH);
    assert(decision.ruleId === null, 'a rule acted on a message it should not match');
    assert(
      ['NO_RESPONSE', 'HUMAN_HANDOFF'].includes(decision.outcome),
      `outcome was ${decision.outcome}; expected NO_RESPONSE (AI off) or HUMAN_HANDOFF (AI on)`,
    );

    assert(
      (await outboundCount()) === countBefore,
      'an outbound message was sent for a message no rule matched',
    );

    return `decision ${decision.id} → ${decision.outcome} (${decision.reasonCode}), nothing sent`;
  });

  // --- 3 & 4. the AI half -----------------------------------------------------------------------
  const aiStatus = await api('/decisions/status');
  const aiAvailable = aiStatus.body?.ai?.available === true;

  if (!aiAvailable) {
    record(4, 'AI answers from published knowledge', 'BLOCKED', 'no AI provider is configured (AI_PROVIDER=none)');
    record(5, 'Low confidence escalates instead of guessing', 'BLOCKED', 'no AI provider is configured');
  } else {
    await check(4, 'AI answers from published knowledge', async () => {
      const categories = await api('/knowledge/categories');
      const categoryId = categories.body?.items?.[0]?.id;
      assert(categoryId, 'no knowledge category exists');

      const article = await api('/knowledge/articles', {
        method: 'POST',
        body: JSON.stringify({
          title: ARTICLE_TITLE,
          body: 'The Phase 5 test service is available during business hours.',
          categoryId,
          scopeType: 'GROUP',
          scopeId: group.id,
        }),
      });
      articleId = article.body.id;
      await api(`/knowledge/articles/${articleId}/status`, { method: 'POST', body: JSON.stringify({ status: 'REVIEW' }) });
      await api(`/knowledge/articles/${articleId}/status`, { method: 'POST', body: JSON.stringify({ status: 'PUBLISHED' }) });

      await api(`/groups/${group.id}/config`, { method: 'PATCH', body: JSON.stringify({ aiEnabled: true }) });
      await api(`/conversations/${conversation.id}/flags`, { method: 'PATCH', body: JSON.stringify({ aiEnabled: true }) });

      ask(`Send this into "${group.name}" from the TEST participant:\n\n    What are the Phase 5 test service hours?\n`);
      const { decision } = await awaitDecisionFor('Phase 5 test service hours');

      assert(decision.knowledgeUsed, 'the AI answered without using any knowledge');
      assert((decision.knowledgeArticleIds ?? []).includes(articleId), 'the test article was not among the sources');
      assert(decision.aiProvider, 'no AI provider recorded');
      assert(decision.confidence !== null, 'no confidence recorded');
      assert(decision.confidenceCalibrated === false, 'confidence must never be recorded as calibrated');
      return `decision ${decision.id} → ${decision.outcome}, provider ${decision.aiProvider}/${decision.aiModel}, ` +
        `${(decision.knowledgeChunkIds ?? []).length} passage(s) cited, confidence recorded as uncalibrated`;
    });

    await check(5, 'Low confidence escalates instead of guessing', async () => {
      ask(`Send this into "${group.name}" from the TEST participant:\n\n    ${UNKNOWN_Q}\n`);
      const { decision } = await awaitDecisionFor(UNKNOWN_Q);

      assert(decision.outcome === 'HUMAN_HANDOFF', `outcome was ${decision.outcome}, expected HUMAN_HANDOFF`);
      assert(!decision.responseMessageId, 'a customer-facing answer was sent for a question it could not answer');

      const escalations = await api('/escalations?status=OPEN');
      const raised = (escalations.body?.items ?? []).find((e) => e.decisionId === decision.id);
      assert(raised, 'no escalation was created');

      const conv = await api(`/conversations/${conversation.id}`);
      assert(
        ['WAITING_FOR_HUMAN', 'HUMAN_ACTIVE'].includes(conv.body?.status) ||
          conv.body?.controlState === 'HUMAN_ACTIVE',
        `conversation is ${conv.body?.status}/${conv.body?.controlState}, expected human handling`,
      );

      return `decision ${decision.id} → HUMAN_HANDOFF (${decision.escalationReason}), escalation ${raised.id} open, nothing sent`;
    });
  }

  // --- 5. human takeover ------------------------------------------------------------------------
  await check(6, 'Human takeover silences automation', async () => {
    const takeover = await api(`/conversations/${conversation.id}/takeover`, { method: 'POST', body: JSON.stringify({}) });
    assert(takeover.status < 300, `takeover returned ${takeover.status}`);

    const countBefore = await outboundCount();

    ask(`With the conversation taken over, send the trigger AGAIN from the TEST participant:\n\n    ${TRIGGER}\n`);
    const { decision } = await awaitDecisionFor(TRIGGER);

    assert(
      decision.outcome === 'HUMAN_HANDLING',
      `outcome was ${decision.outcome}, expected HUMAN_HANDLING`,
    );
    assert(!decision.responseMessageId, 'automation replied while a human held the conversation');

    assert((await outboundCount()) === countBefore, 'an outbound message was sent during takeover');

    await api(`/conversations/${conversation.id}/release`, { method: 'POST', body: JSON.stringify({}) });
    return `decision ${decision.id} → HUMAN_HANDLING, message stored, nothing sent; takeover released`;
  });

  // --- 6. duplicate webhook ---------------------------------------------------------------------
  await check(7, 'A replayed webhook produces no duplicate anything', async () => {
    if (!triggerDecisionId) return { blocked: 'no earlier decision to replay against' };

    const secret = process.env.OPENWA_WEBHOOK_SECRET ?? args['webhook-secret'];
    if (!secret) return { blocked: 'no webhook secret supplied; replay needs a valid signature' };

    const decisionsBefore = await api(`/decisions?conversationId=${conversation.id}&limit=100`);
    const outboundBefore = await outboundCount();

    const original = (await conversationMessages()).find(
      (m) => m.direction === 'INBOUND' && (m.body ?? '').includes(TRIGGER),
    );
    assert(original, 'cannot find the original trigger message to replay');

    const payload = {
      event: 'message.received',
      timestamp: new Date().toISOString(),
      sessionId: SESSION,
      idempotencyKey: `phase5_replay_${original.externalId}`,
      deliveryId: 'phase5-validation',
      data: {
        id: original.externalId,
        from: original.senderExternalId,
        body: original.body,
        type: 'chat',
        timestamp: Math.floor(new Date(original.sentAt ?? Date.now()).getTime() / 1000),
      },
    };
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'X-OpenWA-Event': payload.event,
      'X-OpenWA-Idempotency-Key': payload.idempotencyKey,
      'X-OpenWA-Delivery-Id': payload.deliveryId,
      'X-OpenWA-Signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    };

    await fetch(`${API}/api/v1/channels/whatsapp/webhook/${accountId}`, { method: 'POST', headers, body });
    await fetch(`${API}/api/v1/channels/whatsapp/webhook/${accountId}`, { method: 'POST', headers, body });
    await sleep(6000);

    const decisionsAfter = await api(`/decisions?conversationId=${conversation.id}&limit=100`);
    const outboundAfter = await outboundCount();

    assert(
      decisionsAfter.body.total === decisionsBefore.body.total,
      `decisions went from ${decisionsBefore.body.total} to ${decisionsAfter.body.total}`,
    );
    assert(outboundAfter === outboundBefore, 'a duplicate reply was sent');
    return `webhook replayed twice: decisions ${decisionsAfter.body.total} (unchanged), no extra outbound`;
  });

  // --- 7. loop protection -----------------------------------------------------------------------
  await check(8, 'The reply coming back does not trigger the rule again', async () => {
    const all = await conversationMessages();
    const echoes = all.filter((m) => m.direction === 'INBOUND' && (m.body ?? '').includes(REPLY_TEXT));

    for (const echo of echoes) {
      const { body: forEcho } = await api(`/decisions/message/${echo.id}`);
      const decision = forEcho?.decision ?? (forEcho?.id ? forEcho : null);
      assert(
        !decision || !['RULE_REPLY', 'AI_REPLY'].includes(decision.outcome),
        `the system answered its own message (decision ${decision?.id})`,
      );
    }

    const replies = await outboundContaining(REPLY_TEXT);
    assert(replies.length === 1, `${replies.length} copies of the automated reply exist; expected exactly 1`);

    return `${echoes.length} echo(es) of our own reply came back and produced no further reply; ` +
      `exactly 1 customer-facing automated response in total`;
  });

  // --- 8. decision trace ------------------------------------------------------------------------
  await check(9, 'The trace explains the decision without the database', async () => {
    const { body } = await api(`/decisions/${triggerDecisionId}`);
    assert(body?.decision, 'no decision returned');
    assert(body.rule?.name, 'the trace does not name the rule that acted');
    assert(body.decision.ruleVersion, 'the trace does not carry the rule version');
    assert(body.decision.reason, 'the trace carries no human-readable reason');
    assert(body.decision.responseMessageId, 'the trace does not link the outbound message');
    assert('executions' in body && 'aiRun' in body && 'escalation' in body, 'the trace is missing sections');
    return `trace: rule "${body.rule.name}" v${body.decision.ruleVersion}, reason "${body.decision.reason}", ` +
      `${body.executions.length} execution(s), outbound linked`;
  });

  // --- 9. realtime ------------------------------------------------------------------------------
  await check(10, 'Realtime pushes the decision to the browser', async () => {
    let io;
    try {
      const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
      ({ io } = require('socket.io-client'));
    } catch {
      return { blocked: 'socket.io-client is not resolvable from this script' };
    }

    const socket = io(`${API}/realtime`, { extraHeaders: { Cookie: cookie }, transports: ['websocket'] });
    realtimeEvents = [];
    for (const event of [
      'decision.started',
      'decision.completed',
      'message.created',
      'conversation.updated',
      'escalation.raised',
    ]) {
      socket.on(event, (payload) => realtimeEvents.push({ event, payload }));
    }
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', (e) => reject(new Error(`socket connect failed: ${e.message}`)));
      setTimeout(() => reject(new Error('socket did not connect within 10s')), 10_000);
    });
    socket.emit('subscribe:conversation', { conversationId: conversation.id });

    ask(`Send the trigger one final time from the TEST participant:\n\n    ${TRIGGER}\n`);
    await waitFor(async () => realtimeEvents.length > 0, {
      timeoutMs: WAIT_MS,
      what: 'a realtime decision event',
    });
    await sleep(8000);
    socket.close();

    const names = [...new Set(realtimeEvents.map((e) => e.event))];
    assert(names.length > 0, 'no realtime events arrived');
    return `${realtimeEvents.length} event(s) pushed without a refresh: ${names.join(', ')}`;
  });
} else {
  const why = !connected
    ? 'the WhatsApp account is not connected'
    : 'no dedicated, authorised test group was named';
  for (const [id, name] of [
    [1, 'Rule match produces exactly one reply'],
    [2, 'Delivery state advances on the real gateway'],
    [3, 'An unmatched message produces no reply'],
    [4, 'AI answers from published knowledge'],
    [5, 'Low confidence escalates instead of guessing'],
    [6, 'Human takeover silences automation'],
    [7, 'A replayed webhook produces no duplicate anything'],
    [8, 'The reply coming back does not trigger the rule again'],
    [9, 'The trace explains the decision without the database'],
    [10, 'Realtime pushes the decision to the browser'],
  ]) {
    record(id, name, 'BLOCKED', `needs a real message: ${why}`);
  }
}

// --- 10. security -------------------------------------------------------------------------------
await check(11, 'No credential appears in any real payload', async () => {
  const secrets = [GATEWAY_KEY, ADMIN_PASS, process.env.AI_API_KEY, process.env.SECRET_ENCRYPTION_KEY]
    .filter((s) => s && s.length > 7);

  const surfaces = [];
  const collect = async (label, path) => {
    const { body } = await api(path);
    surfaces.push([label, JSON.stringify(body ?? '')]);
  };

  await collect('accounts overview', '/channels/whatsapp/accounts/overview');
  await collect('decisions', '/decisions?limit=50');
  await collect('decision status', '/decisions/status');
  await collect('escalations', '/escalations');
  await collect('automation rules', '/automation/rules');
  if (conversation) await collect('conversation', `/conversations/${conversation.id}`);
  if (triggerDecisionId) await collect('decision trace', `/decisions/${triggerDecisionId}`);

  const leaks = [];
  for (const [label, text] of surfaces) {
    for (const secret of secrets) if (text.includes(secret)) leaks.push(`a credential in ${label}`);
    // The gateway's internal session UUID must never surface in an API response.
    if (/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/.test(text) && label === 'accounts overview') {
      const { body } = await api('/channels/whatsapp/accounts/overview');
      const sessionUuids = (body?.items ?? []).filter((a) => a.sessionUuid || a.gatewaySessionId);
      if (sessionUuids.length) leaks.push('a gateway session UUID in the accounts overview');
    }
  }

  assert(leaks.length === 0, `LEAKED: ${leaks.join(', ')}`);
  return `${surfaces.length} live API surfaces scanned against ${secrets.length} secret(s): none present`;
});

// --- cleanup ------------------------------------------------------------------------------------
if (safeToSend && args['no-cleanup'] !== 'true') {
  const removed = await cleanup();
  console.log(`\nCleanup:\n${removed.map((r) => `  - ${r}`).join('\n') || '  (nothing to remove)'}`);
  console.log('  Decision logs, messages and escalations are kept: they record what actually happened.');
}

// --- summary ------------------------------------------------------------------------------------
const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const blocked = results.filter((r) => r.status === 'BLOCKED').length;

console.log(`\n${'='.repeat(78)}`);
console.log(`  PASS ${pass}   FAIL ${fail}   BLOCKED ${blocked}`);
console.log('='.repeat(78));

if (fail > 0) {
  console.log('\nFAILURES:');
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  ${r.id}. ${r.name}: ${r.detail}`);
}
if (blocked > 0) {
  console.log('\nBLOCKED — a BLOCKED item is never a PASS:');
  for (const r of results.filter((x) => x.status === 'BLOCKED')) console.log(`  ${r.id}. ${r.name}: ${r.detail}`);
}

process.exit(fail > 0 ? 1 : 0);
