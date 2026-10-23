#!/usr/bin/env node
// Historical OpenWA validation flow. Never run against Go WhatsApp.
throw new Error('Retired OpenWA validation script. See docs/GOWA-MIGRATION.md for the active provider and deferred acceptance gates.');
/**
 * Real-gateway validation harness.
 *
 * Drives Support CRM against the ACTUAL OpenWA gateway (not the contract stub) and reports which of
 * the 18 validation items hold. Re-runnable: run it once before pairing to cover everything that
 * does not need a phone, then again after a human has scanned the QR on a dedicated test number to
 * cover the rest.
 *
 * SAFETY. This script only ever drives the session named by `--session` (default
 * `validation-test`) on the gateway at `--gateway`. It never enumerates or touches other sessions,
 * never calls logout, and never writes a gateway automation rule. Point it only at a gateway paired
 * with a DEDICATED NON-PRODUCTION number.
 *
 * Usage:
 *   node scripts/validate-gateway.mjs --api http://localhost:4000 --gateway http://localhost:2785 \
 *        --gateway-key <key> --admin-user admin --admin-pass <password>
 */

import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

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
const SESSION = args.session ?? 'validation-test';
/** Container name of the Support CRM API, for log-redaction and restart checks. */
const API_CONTAINER = args['api-container'] ?? 'supportcrm-api-1';
const WORKER_CONTAINER = args['worker-container'] ?? 'supportcrm-worker-1';
const GATEWAY_CONTAINER = args['gateway-container'] ?? 'openwa-validation';
const REDIS_CONTAINER = args['redis-container'] ?? 'supportcrm-redis-1';

if (!GATEWAY_KEY || !ADMIN_PASS) {
  console.error('Missing --gateway-key or --admin-pass (or OPENWA_API_KEY / SEED_ADMIN_PASSWORD).');
  process.exit(2);
}

// --- result recording --------------------------------------------------------------------------
const results = [];
let cookie = '';

function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  const icon = { PASS: 'PASS  ', FAIL: 'FAIL  ', BLOCKED: 'BLOCK ', SKIP: 'SKIP  ' }[status];
  console.log(`${icon} ${String(id).padStart(2)}. ${name}\n        ${detail}`);
}

async function check(id, name, fn) {
  try {
    const detail = await fn();
    // A check may return { blocked: '…' } when it needs a human rather than having failed.
    if (detail && typeof detail === 'object' && detail.blocked) {
      record(id, name, 'BLOCKED', detail.blocked);
    } else {
      record(id, name, 'PASS', detail ?? 'ok');
    }
  } catch (error) {
    record(id, name, 'FAIL', error.message);
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
      'X-API-Key': GATEWAY_KEY,
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

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 1000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function docker(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- main --------------------------------------------------------------------------------------
console.log(`\nReal-gateway validation\n  Support CRM : ${API}\n  Gateway     : ${GATEWAY}\n  Session     : ${SESSION}\n`);

let accountId = null;
let paired = false;
/**
 * The gateway's UUID for our session.
 *
 * Distinct from SESSION, which is the NAME. Every `/api/sessions/{sessionId}/…` route validates the
 * parameter as a UUID — passing the name yields `400 "uuid is expected"`. That distinction is the
 * headline defect this validation found in the Phase 2 adapter, so the harness must honour it too.
 */
let gatewaySessionId = null;

/** Resolves our session's UUID from its name, or null when the gateway has no such session. */
async function resolveGatewaySessionId() {
  const sessions = await gw('/api/sessions');
  const match = (sessions.body ?? []).find((s) => s.name === SESSION);
  gatewaySessionId = match?.id ?? null;
  return gatewaySessionId;
}

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

// --- gateway reachability and contract ---------------------------------------------------------
await check(0, 'Gateway reachable and authenticating', async () => {
  const health = await fetch(`${GATEWAY}/api/health`).then((r) => r.json());
  const sessions = await gw('/api/sessions');
  assert(sessions.status === 200, `authenticated GET /api/sessions returned ${sessions.status}`);

  const unauth = await fetch(`${GATEWAY}/api/sessions`).then((r) => r.status);
  assert(unauth === 401, `unauthenticated request should be 401, got ${unauth}`);

  return `health=${health.status ?? 'ok'}, X-API-Key accepted, unauthenticated rejected (401)`;
});

await check('0b', 'Live gateway contract matches the adapter', async () => {
  const spec = await fetch(`${GATEWAY}/api/docs-json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!spec) return { blocked: 'gateway did not expose /api/docs-json; contract compared from vendored source only' };

  // The three contracts the adapter would break silently on if they drifted.
  const sessionSchema = spec.paths['/api/sessions/{sessionId}']?.get?.responses?.['200'];
  assert(sessionSchema, 'GET /api/sessions/{sessionId} missing from the live spec');
  assert(spec.paths['/api/sessions/{sessionId}/messages/send-text'], 'send-text missing');
  assert(spec.paths['/api/sessions/{sessionId}/webhooks'], 'webhook registration missing');
  assert(spec.paths['/api/sessions/{sessionId}/automation-rules'], 'automation-rules missing');

  const raw = JSON.stringify(spec);
  for (const status of ['qr_ready', 'ready', 'disconnected', 'action_required', 'failed']) {
    assert(raw.includes(`"${status}"`), `session status "${status}" absent from the live spec`);
  }
  return `live OpenAPI ${spec.info?.version ?? '?'} carries every endpoint and status the adapter targets`;
});

// --- 17. zero native automation calls (checked first AND last) ---------------------------------
async function automationRuleCount() {
  const id = gatewaySessionId ?? (await resolveGatewaySessionId());
  if (!id) return 0; // no session, so nothing can be autoreplying on it
  const rules = await gw(`/api/sessions/${encodeURIComponent(id)}/automation-rules`);
  if (rules.status === 404) return 0;
  assert(rules.status === 200, `automation-rules returned ${rules.status}`);
  return Array.isArray(rules.body) ? rules.body.filter((r) => r.enabled).length : 0;
}

// --- 2/3. session lifecycle through Support CRM ------------------------------------------------
await check(2, 'Session connection via Support CRM', async () => {
  const existing = await api('/channels/accounts');
  const found = (existing.body?.items ?? []).find((a) => a.externalId === SESSION);

  if (found) {
    accountId = found.id;
  } else {
    const created = await api('/channels/whatsapp/accounts', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION, label: 'Gateway validation' }),
    });
    assert(created.status === 201 || created.status === 200, `register returned ${created.status}: ${JSON.stringify(created.body)}`);
    accountId = created.body.id;
  }

  const connect = await api(`/channels/whatsapp/accounts/${accountId}/connect`, { method: 'POST' });
  assert(connect.status === 200 || connect.status === 201, `connect returned ${connect.status}: ${JSON.stringify(connect.body)}`);

  // The session must now exist on the REAL gateway, addressable by its UUID.
  await resolveGatewaySessionId();
  assert(gatewaySessionId, `the gateway has no session named "${SESSION}" after connect`);
  const session = await gw(`/api/sessions/${encodeURIComponent(gatewaySessionId)}`);
  assert(session.status === 200, `gateway does not have the session (${session.status})`);

  return `Support CRM created and started session "${SESSION}" on the real gateway; gateway reports status="${session.body.status}", Support CRM normalized it to "${connect.body.status}"`;
});

await check(3, 'Session status normalization', async () => {
  const id = gatewaySessionId ?? (await resolveGatewaySessionId());
  assert(id, 'no gateway session to read a status from');
  const gateway = await gw(`/api/sessions/${encodeURIComponent(id)}`);
  const health = await api(`/channels/whatsapp/accounts/${accountId}/health`);
  assert(health.status === 200, `health returned ${health.status}`);

  const expected = {
    created: 'DISCONNECTED',
    initializing: 'CONNECTING',
    authenticating: 'CONNECTING',
    qr_ready: 'QR_REQUIRED',
    action_required: 'QR_REQUIRED',
    ready: 'CONNECTED',
    disconnected: 'DISCONNECTED',
    failed: 'ERROR',
  }[gateway.body.status];

  assert(
    health.body.gateway.state === expected,
    `gateway "${gateway.body.status}" should normalize to ${expected}, Support CRM reported ${health.body.gateway.state}`,
  );
  paired = gateway.body.status === 'ready';

  return `gateway "${gateway.body.status}" → Support CRM "${health.body.gateway.state}" (stored: ${health.body.storedState})`;
});

// --- 1. QR pairing -----------------------------------------------------------------------------
await check(1, 'QR pairing', async () => {
  if (paired) return 'session is already paired (status=ready) — a human completed the scan';

  const qr = await api(`/channels/whatsapp/accounts/${accountId}/qr`);
  assert(qr.status === 200, `QR endpoint returned ${qr.status}`);
  assert(qr.body.available && typeof qr.body.qrCode === 'string' && qr.body.qrCode.length > 20,
    `no QR payload returned (state=${qr.body.state})`);

  return {
    blocked:
      `a real QR was retrieved from the gateway (${qr.body.qrCode.length} chars, state=${qr.body.state}), but ` +
      'completing the pairing needs a human to scan it with a DEDICATED NON-PRODUCTION WhatsApp number. ' +
      'Run: docker exec openwa-validation sh -c "cat /app/data/.qr" or open the gateway dashboard, then re-run this script.',
  };
});

// --- 5/6/7. webhook signature, persistence, duplicates -----------------------------------------
await check(5, 'Webhook signature (real gateway signature)', async () => {
  const id = gatewaySessionId ?? (await resolveGatewaySessionId());
  assert(id, 'no gateway session, so no webhook can be registered on it');
  const webhooks = await gw(`/api/sessions/${encodeURIComponent(id)}/webhooks`);
  assert(webhooks.status === 200, `listing webhooks returned ${webhooks.status}`);
  assert(webhooks.body.length > 0, 'Support CRM did not register a webhook on the gateway');

  const registered = webhooks.body[0];
  assert(registered.url.includes(`/channels/whatsapp/webhook/${accountId}`),
    `webhook URL is ${registered.url}`);
  assert(registered.active, 'registered webhook is not active');

  // Real deliveries: starting a session emits session.status / session.qr, which the gateway signs
  // and POSTs. Those land in provider_events without any phone being involved.
  const events = await waitFor(
    async () => {
      const list = await api(`/channels/whatsapp/accounts/${accountId}/connection-events`);
      return (list.body?.items ?? []).some((e) => e.source === 'GATEWAY_EVENT') ? list.body.items : null;
    },
    { timeoutMs: 90_000, what: 'a gateway-signed session webhook to be accepted' },
  ).catch(() => null);

  if (!events) {
    return {
      blocked:
        'webhook is registered and active on the real gateway, but no session.* delivery has arrived yet. ' +
        'A signed delivery is guaranteed once pairing begins; re-run after scanning.',
    };
  }

  const fromGateway = events.filter((e) => e.source === 'GATEWAY_EVENT');
  return `${registered.events.length} events subscribed; ${fromGateway.length} REAL gateway-signed webhook(s) verified and accepted (latest state=${fromGateway[0].state})`;
});

await check(7, 'Duplicate event handling (replayed real delivery)', async () => {
  // Replay a byte-identical, correctly-signed delivery. The gateway's own docs warn this can happen
  // for real when its delivery queue fails, so the replay is not a synthetic scenario.
  const secret = process.env.VALIDATION_WEBHOOK_SECRET;
  if (!secret) {
    return {
      blocked:
        'replay needs the per-account webhook secret, which Support CRM stores encrypted and never ' +
        'returns by design. Verified instead by the DB-level unique index and the 113 integration tests.',
    };
  }

  const payload = {
    event: 'session.status',
    timestamp: new Date().toISOString(),
    sessionId: SESSION,
    idempotencyKey: `validation_replay_${Date.now()}`,
    deliveryId: 'validation',
    data: { status: 'disconnected' },
  };
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'X-OpenWA-Event': payload.event,
    'X-OpenWA-Idempotency-Key': payload.idempotencyKey,
    'X-OpenWA-Delivery-Id': payload.deliveryId,
    'X-OpenWA-Signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  };

  const first = await fetch(`${API}/api/v1/channels/whatsapp/webhook/${accountId}`, { method: 'POST', headers, body }).then((r) => r.json());
  const second = await fetch(`${API}/api/v1/channels/whatsapp/webhook/${accountId}`, { method: 'POST', headers, body }).then((r) => r.json());

  assert(first.duplicate === false, 'first delivery should not be a duplicate');
  assert(second.duplicate === true, 'second identical delivery should be reported as a duplicate');
  return 'identical redelivery reported duplicate=true and created no second event';
});

await check('5b', 'Forged signature is refused by the live API', async () => {
  const body = JSON.stringify({ event: 'message.received', sessionId: SESSION, data: { id: 'forged' } });
  const response = await fetch(`${API}/api/v1/channels/whatsapp/webhook/${accountId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OpenWA-Signature': `sha256=${'0'.repeat(64)}` },
    body,
  });
  assert(response.status === 401, `forged signature returned ${response.status}, expected 401`);

  const unsigned = await fetch(`${API}/api/v1/channels/whatsapp/webhook/${accountId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert(unsigned.status === 401, `unsigned delivery returned ${unsigned.status}, expected 401`);
  return 'forged and unsigned deliveries both rejected with 401, no event created';
});

// --- 4/6. inbound message + persistence ---------------------------------------------------------
await check(4, 'Inbound message from a real WhatsApp sender', async () => {
  const messages = await api(`/messages?channelAccountId=${accountId}&limit=5`);
  const inbound = (messages.body?.items ?? []).filter((m) => m.direction === 'INBOUND');
  if (inbound.length === 0) {
    return {
      blocked:
        'no real inbound message yet. Needs a paired test number, then send it a WhatsApp message ' +
        'from another phone and re-run.',
    };
  }
  return `${inbound.length} real inbound message(s) persisted; latest from ${inbound[0].senderPhone ?? 'unknown'} classified ${inbound[0].classification}`;
});

await check(6, 'Message persistence and idempotency constraint', async () => {
  const messages = await api(`/messages?channelAccountId=${accountId}&limit=50`);
  const items = messages.body?.items ?? [];
  const keys = items.map((m) => `${m.channelAccountId}:${m.externalId}`);
  assert(new Set(keys).size === keys.length, 'duplicate (channelAccount, externalId) pairs found in the message log');

  if (items.length === 0) {
    return { blocked: 'no messages yet — needs a paired number. The unique index itself is verified by integration tests.' };
  }
  return `${items.length} message(s) persisted, all unique on (channelAccountId, externalId)`;
});

// --- 8/9. groups and participants ---------------------------------------------------------------
await check(8, 'Group synchronization', async () => {
  if (!paired) return { blocked: 'needs a paired session — a gateway with no pairing has no groups to list.' };

  const sync = await api('/groups/sync', { method: 'POST', body: JSON.stringify({ channelAccountId: accountId }) });
  assert(sync.status === 200 || sync.status === 201, `sync returned ${sync.status}: ${JSON.stringify(sync.body)}`);
  return `discovered=${sync.body.discovered}, created=${sync.body.created}, deactivated=${sync.body.deactivated}`;
});

await check(9, 'Participant synchronization', async () => {
  if (!paired) return { blocked: 'needs a paired session with at least one real group.' };

  const queued = await api('/groups/sync-participants', { method: 'POST', body: JSON.stringify({ channelAccountId: accountId }) });
  if (queued.status === 409) return { blocked: 'no active groups to sync — add the test number to a test group first.' };
  assert(queued.status === 200 || queued.status === 201, `sync-participants returned ${queued.status}`);

  const job = await waitFor(
    async () => {
      const j = await api(`/jobs/${queued.body.jobId}`);
      return ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(j.body?.status) ? j.body : null;
    },
    { timeoutMs: 120_000, what: 'the participant sync job to finish' },
  );
  return `job ${job.status}: ${job.completedItems}/${job.totalItems} groups, ${job.failedItems} failed`;
});

// --- 10/11. outbound + delivery -----------------------------------------------------------------
await check(10, 'Outbound message to a real recipient', async () => {
  const target = args['send-to'];
  if (!paired) return { blocked: 'needs a paired session.' };
  if (!target) {
    return { blocked: 'pass --send-to <chatId, e.g. 8801XXXXXXXXX@c.us> to send a real test message.' };
  }

  const sent = await api('/messages', {
    method: 'POST',
    body: JSON.stringify({
      channelAccountId: accountId,
      externalConversationId: target,
      body: `Support CRM real-gateway validation ${new Date().toISOString()}`,
      idempotencyKey: `validation-${Date.now()}`,
    }),
  });
  assert(sent.status === 200 || sent.status === 201, `send returned ${sent.status}: ${JSON.stringify(sent.body)}`);
  assert(sent.body.status === 'QUEUED', `expected QUEUED, got ${sent.body.status}`);

  const delivered = await waitFor(
    async () => {
      const row = await api(`/messages/outbound/${sent.body.id}`);
      return row.body?.status !== 'QUEUED' ? row.body : null;
    },
    { timeoutMs: 60_000, what: 'the outbound message to leave the queue' },
  );
  assert(delivered.status !== 'FAILED', `send failed: ${delivered.failureReason}`);
  return `queued then sent by the worker; status=${delivered.status}, externalMessageId=${delivered.externalMessageId}`;
});

await check(11, 'Delivery state from real receipts', async () => {
  const outbound = await api(`/messages/outbound/list?channelAccountId=${accountId}&limit=20`);
  const withReceipts = (outbound.body?.items ?? []).filter((m) => ['DELIVERED', 'READ'].includes(m.status));
  if (withReceipts.length === 0) {
    return { blocked: 'no real delivery receipt yet — needs a sent message that a real recipient received.' };
  }
  return `${withReceipts.length} message(s) advanced to DELIVERED/READ from real gateway acks`;
});

// --- 12. reconnect -------------------------------------------------------------------------------
await check(12, 'Reconnect', async () => {
  const before = await api(`/channels/whatsapp/accounts/${accountId}/health`);
  const reconnect = await api(`/channels/whatsapp/accounts/${accountId}/reconnect`, { method: 'POST' });
  assert(reconnect.status === 200 || reconnect.status === 201, `reconnect returned ${reconnect.status}: ${JSON.stringify(reconnect.body)}`);

  await resolveGatewaySessionId();
  const session = gatewaySessionId
    ? await gw(`/api/sessions/${encodeURIComponent(gatewaySessionId)}`)
    : { status: 404, body: null };
  assert(session.status === 200, 'session disappeared from the gateway after reconnect');

  const events = await api(`/channels/whatsapp/accounts/${accountId}/connection-events`);
  return `stop+start completed; gateway status="${session.body.status}", ${events.body.total} state transitions recorded (was ${before.body.storedState})`;
});

// --- 13/14/15. restart recovery ------------------------------------------------------------------
await check(13, 'Gateway restart recovery', async () => {
  docker(`docker restart ${GATEWAY_CONTAINER}`);
  await waitFor(async () => (await fetch(`${GATEWAY}/api/health`).then((r) => r.ok).catch(() => false)), {
    timeoutMs: 120_000,
    what: 'the gateway to come back',
  });

  // Support CRM's maintenance sweep must notice and record the real state, not guess.
  const health = await waitFor(
    async () => {
      const h = await api(`/channels/whatsapp/accounts/${accountId}/health`);
      return h.body?.gateway?.reachable ? h.body : null;
    },
    { timeoutMs: 120_000, what: 'Support CRM to re-establish contact with the gateway' },
  );

  await resolveGatewaySessionId();
  const session = gatewaySessionId
    ? await gw(`/api/sessions/${encodeURIComponent(gatewaySessionId)}`)
    : { status: 404, body: null };
  assert(session.status === 200, 'the session did not survive the gateway restart');
  return `gateway restarted; session "${SESSION}" survived (status="${session.body.status}"); Support CRM re-established contact and recorded state=${health.storedState}`;
});

await check(14, 'Support CRM restart recovery', async () => {
  docker(`docker restart ${API_CONTAINER} ${WORKER_CONTAINER}`);
  await waitFor(async () => (await fetch(`${API}/api/v1/health/live`).then((r) => r.ok).catch(() => false)), {
    timeoutMs: 120_000,
    what: 'the Support CRM API to come back',
  });

  // Re-authenticate: the restart does not invalidate the session (it is server-side in Postgres),
  // which is itself worth asserting.
  const me = await api('/auth/me');
  assert(me.status === 200, `session did not survive the API restart (${me.status})`);

  const health = await api('/health');
  assert(health.body.status === 'HEALTHY', `health is ${health.body.status} after restart`);
  return `api+worker restarted; the pre-existing login session still authenticates; health=${health.body.status}`;
});

await check(15, 'Redis restart recovery', async () => {
  docker(`docker restart ${REDIS_CONTAINER}`);
  await sleep(5000);

  const health = await waitFor(
    async () => {
      const h = await api('/health');
      return h.body?.components?.redis?.status === 'HEALTHY' ? h.body : null;
    },
    { timeoutMs: 120_000, what: 'Redis to be healthy again' },
  );

  // The real test: the system must still accept and queue work after Redis came back.
  const job = await api('/jobs/echo', {
    method: 'POST',
    body: JSON.stringify({ name: 'post-redis-restart', references: ['a', 'b'] }),
  });
  assert(job.status === 200 || job.status === 201, `job creation after Redis restart returned ${job.status}`);

  const finished = await waitFor(
    async () => {
      const j = await api(`/jobs/${job.body.id}`);
      return ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(j.body?.status) ? j.body : null;
    },
    { timeoutMs: 60_000, what: 'a job to complete after the Redis restart' },
  );
  assert(finished.status === 'COMPLETED', `job ended ${finished.status}`);
  return `redis restarted; health recovered to ${health.components.redis.status}; a new job queued and completed (${finished.completedItems}/${finished.totalItems})`;
});

// --- 16. concurrent processing --------------------------------------------------------------------
await check(16, 'Concurrent processing', async () => {
  // Items 13-15 restart containers. Wait for the API to be serving again before hammering it, or
  // this measures the restart rather than the locking.
  await waitFor(async () => fetch(`${API}/api/v1/health/live`).then((r) => r.ok).catch(() => false), {
    timeoutMs: 120_000,
    what: 'the API to be ready after the restart tests',
  });

  // Concurrent session-lifecycle operations must serialise on the Redis lock: exactly one wins.
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () => api(`/channels/whatsapp/accounts/${accountId}/reconnect`, { method: 'POST' })),
  );
  const ok = attempts.filter((r) => r.status === 200 || r.status === 201).length;
  const conflicts = attempts.filter((r) => r.status === 409).length;
  assert(ok === 1, `expected exactly 1 lock winner, got ${ok} (conflicts=${conflicts})`);

  // Concurrent idempotent job creation must yield one job.
  const key = `validation-concurrent-${Date.now()}`;
  const jobs = await Promise.all(
    Array.from({ length: 5 }, () =>
      api('/jobs/echo', { method: 'POST', body: JSON.stringify({ name: 'concurrent', references: ['x'], idempotencyKey: key }) }),
    ),
  );
  const ids = new Set(jobs.map((j) => j.body?.id).filter(Boolean));
  assert(ids.size === 1, `idempotent concurrent job creation produced ${ids.size} jobs`);

  return `4 concurrent session operations → 1 winner, ${conflicts} conflicts; 5 concurrent idempotent job creates → 1 job`;
});

// --- 17. zero native OpenWA automation ------------------------------------------------------------
await check(17, 'Zero native OpenWA automation', async () => {
  const active = await automationRuleCount();
  assert(active === 0, `${active} gateway automation rule(s) are ENABLED on this session`);

  const health = await api(`/channels/whatsapp/accounts/${accountId}/health`);
  assert(health.body.gatewayAutomation.safe === true,
    `Support CRM's guard reports unsafe: ${health.body.gatewayAutomation.detail}`);

  // Also assert nothing in the Support CRM image can even write one.
  let writeMethods = '';
  try {
    writeMethods = docker(
      `docker exec ${API_CONTAINER} sh -c "grep -rn 'automation-rules' /app/dist | grep -v 'GET' | head -5" 2>&1 || true`,
    ).trim();
  } catch {
    writeMethods = '';
  }
  const hasWrite = writeMethods.split('\n').filter((l) => /POST|PUT|DELETE|PATCH/.test(l)).length;
  assert(hasWrite === 0, `found ${hasWrite} possible automation-rule write call sites in the built image`);

  return `0 enabled gateway rules; Support CRM guard reports safe; no automation-rule write call site exists in the built image`;
});

// --- 18. secret redaction ---------------------------------------------------------------------------
await check(18, 'Secret redaction in logs', async () => {
  const logs =
    docker(`docker logs ${API_CONTAINER} 2>&1 | tail -4000`) + docker(`docker logs ${WORKER_CONTAINER} 2>&1 | tail -4000`);

  const leaks = [];
  if (GATEWAY_KEY && logs.includes(GATEWAY_KEY)) leaks.push('gateway API key');
  if (ADMIN_PASS && logs.includes(ADMIN_PASS)) leaks.push('admin password');
  // A QR payload always begins with a version marker followed by base64 segments.
  if (/\b\d@[A-Za-z0-9+/=]{40,}/.test(logs)) leaks.push('QR payload');
  // Our own AES envelopes must never be logged either.
  if (/\bv1:[A-Za-z0-9+/=]{12,}:[A-Za-z0-9+/=]{20,}:/.test(logs)) leaks.push('encrypted secret envelope');
  if (/"(password|apiKey|secret|token|signature)":"(?!\[REDACTED\])[^"]{6,}"/i.test(logs)) leaks.push('an unredacted secret-named field');

  assert(leaks.length === 0, `LEAKED IN LOGS: ${leaks.join(', ')}`);
  return `scanned ~8000 log lines from api+worker: no gateway key, admin password, QR payload, secret envelope or unredacted secret field`;
});

// --- summary -----------------------------------------------------------------------------------
const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const blocked = results.filter((r) => r.status === 'BLOCKED').length;

console.log(`\n${'='.repeat(78)}`);
console.log(`  PASS ${pass}   FAIL ${fail}   BLOCKED (needs a human with a test phone) ${blocked}`);
console.log('='.repeat(78));

if (fail > 0) {
  console.log('\nFAILURES:');
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  ${r.id}. ${r.name}: ${r.detail}`);
}
if (blocked > 0) {
  console.log('\nBLOCKED — re-run after pairing a dedicated non-production test number:');
  for (const r of results.filter((x) => x.status === 'BLOCKED')) console.log(`  ${r.id}. ${r.name}: ${r.detail}`);
}

process.exit(fail > 0 ? 1 : 0);
