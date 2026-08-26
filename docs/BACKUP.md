# Backup and restore

`PROJECT_SPEC.md` §128.

Four things need backing up. Three of them are useless without the fourth.

| What | Where | Why it matters |
|---|---|---|
| PostgreSQL | `support_crm_pg_data` volume | Conversations, decisions, knowledge, configuration — everything |
| Uploaded documents | `support_crm_storage` volume, mounted at `/app/storage` | Knowledge-base source files. The database holds refs, not bytes |
| WhatsApp session | `support_crm_openwa_data` volume | Losing it means re-pairing every account by scanning a code. Holds the WhatsApp auth state, the gateway's SQLite database and its media |
| `SECRET_ENCRYPTION_KEY` | your secrets manager | **Without it the encrypted columns are unreadable.** A database backup restored with a different key gives you rows you cannot decrypt |

## Taking a backup

```bash
# Database — custom format, compressed, restorable table by table.
docker compose exec -T postgres pg_dump -U support_crm -Fc support_crm > backup-$(date +%F).dump

# Uploaded documents.
docker run --rm -v support_crm_storage:/data -v "$PWD:/out" alpine \
  tar czf /out/storage-$(date +%F).tar.gz -C /data .

# The WhatsApp session, so a restore does not require re-pairing.
docker run --rm -v openwa_data:/data -v "$PWD:/out" alpine \
  tar czf /out/session-$(date +%F).tar.gz -C /data .
```

Store `SECRET_ENCRYPTION_KEY` with the backups' *metadata*, not in the same bucket as the dumps.
A backup and the key to read it in one place is one compromise away from being the same thing.

## Restoring

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U support_crm -d postgres \
  -c 'DROP DATABASE IF EXISTS support_crm' -c 'CREATE DATABASE support_crm'
docker compose exec -T postgres pg_restore -U support_crm -d support_crm --clean --if-exists < backup.dump

docker run --rm -v support_crm_storage:/data -v "$PWD:/in" alpine \
  sh -c 'cd /data && tar xzf /in/storage.tar.gz'

# Then bring the rest up, with the ORIGINAL encryption key in the environment.
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Verifying a backup

A backup nobody has restored is a hypothesis. Quarterly, on a scratch host:

1. Restore the dump into an empty database.
2. Bring up the API against it **with the original key**.
3. `GET /api/v1/health` — expect `HEALTHY`.
4. Open a knowledge article that has an attachment; confirm the file downloads.
5. Open an AI provider in the console; confirm it shows `hasApiKey: true` and that **Test**
   succeeds. This is the step that proves the encryption key survived, and it is the one people
   skip.
6. Confirm `SELECT count(*) FROM decision_logs` is non-zero and matches roughly what production had.
7. If the session volume was restored too, confirm the WhatsApp account reaches **Connected**
   without a pairing code. A restore that silently demands a new QR is a restore that did not
   include the session.

Record the date and the outcome. An unverified backup procedure is documentation, not a backup.

## What is deliberately not backed up

- **Redis.** It holds locks, rate-limit counters and in-flight queue state, all of which are
  reconstructible. The durable job rows are in Postgres.
- **Container images.** Rebuilt from the repository.
