# Troubleshooting

Symptoms, in the order people actually hit them.

---

## The worker starts but nothing is processed

**Check first:** is a job sitting at `QUEUED` while `docker compose ps` shows the worker up?

Eight modules read `RUN_MODE` **at import time** to decide whether to register their queue
consumers. If it is unset when the module graph is built, the worker registers nothing, reports
itself healthy, and consumes nothing.

- In Docker this cannot happen: compose sets `RUN_MODE=worker` in the environment.
- Outside Docker, `src/run-mode-worker.ts` sets it as the *first import* of `worker.ts`. If you add
  an import above that line, you reintroduce the bug.

```bash
docker compose exec worker printenv RUN_MODE   # expect: worker
```

## Migrations fail with "password authentication failed"

The TypeORM CLI resolves `.env` from the repository root, not the working directory. If you moved
the file, or run the CLI from somewhere unexpected, it falls back to built-in defaults and fails to
authenticate. Check that `.env` is at the repository root next to `docker-compose.yml`.

## The console loads but every request fails

Almost always CORS. `CORS_ORIGINS` must contain the exact origin the browser is using, including
scheme and port. `http://localhost:3000` and `http://127.0.0.1:3000` are different origins.

## WhatsApp shows "Reconnect failed"

The stored status is stale, or the CRM genuinely cannot reach the gateway.

```bash
curl -s localhost:2785/health                     # is the gateway up?
docker compose exec api printenv OPENWA_BASE_URL  # can the API resolve that name?
```

Running the API on the host while the gateway is in Docker needs `http://127.0.0.1:2785`, not the
container name. See `DEPLOYMENT.md` §3.

## Inbound messages arrive but nothing replies

Work down the chain — each step is a deliberate gate, not a bug:

1. **Is the group monitored?** An unmonitored group's messages classify as `UNKNOWN`.
2. **Is automation on for the conversation?** `conversations.automationEnabled` defaults to
   `false`, and the engine requires conversation **and** group **and** profile to all allow it.
   *Enabling a group alone is not enough* — see `PHASE_5_REAL_WHATSAPP_VALIDATION.md` §6.
3. **Is any rule ACTIVE?** Draft and review rules are never evaluated.
4. **Is an emergency control engaged?** Check `/emergency`.
5. **Read the decision.** Open Decisions → "Why?". It states exactly which gate stopped it.

That last step usually ends the investigation in under a minute; it is what the trace exists for.

## The AI never answers

- No provider configured → the engine escalates instead of guessing. That is correct behaviour, not
  a failure. `/ai/providers` shows what is configured.
- A provider is configured but every answer escalates → check confidence thresholds under
  Automation → Profiles. Also check the AI turn log: objective signals (no knowledge retrieved, the
  model asking for a human) block a reply regardless of the confidence number.
- All providers failing → the circuit breaker rests a provider for 60 seconds after four
  consecutive failures. `lastError` on the provider says why.

## Duplicate replies to a customer

This should be impossible, and if it happens the schema has been bypassed. Check:

```sql
SELECT "messageId", count(*) FROM decision_logs GROUP BY 1 HAVING count(*) > 1;
```

`decision_logs.messageId` is uniquely indexed. A duplicate there means the index is missing —
verify migrations actually ran.

## A broadcast sent twice

Same shape of question:

```sql
SELECT "broadcastId", "externalConversationId", count(*)
FROM broadcast_recipients GROUP BY 1,2 HAVING count(*) > 1;
```

## Health says CRITICAL for storage

The volume is full or read-only. The check writes and deletes a probe file rather than merely
stating the directory, precisely so a full disk shows up here instead of at the next upload.

```bash
docker compose exec api df -h /app/storage
```

## Everything is slow

```bash
docker compose exec postgres psql -U support_crm -c \
  "SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
```

Reports over a wide date range are the usual answer. Narrow the window before adding indexes.
