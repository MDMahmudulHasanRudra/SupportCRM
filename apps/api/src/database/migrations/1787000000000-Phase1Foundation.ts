import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 foundation schema.
 *
 * Written as explicit SQL rather than generated, so every constraint and index in the initial
 * schema is a reviewed decision (`PROJECT_SPEC.md` §204). Points worth noting:
 *
 *  - `pgcrypto` supplies `gen_random_uuid()`; `pg_trgm` and `vector` are enabled here so Phase 4's
 *    knowledge search and embeddings need no privileged extension migration on a live database
 *    later. Creating an extension requires elevated rights that a production app role may not have,
 *    and discovering that mid-phase is a bad day.
 *  - `vector` is created conditionally — the plain `postgres:16` image does not ship pgvector, and
 *    Phase 1 must not hard-fail on an extension nothing uses yet. Phase 4 will require it.
 *  - Two partial unique indexes exist because the constraint is conditional and cannot be expressed
 *    in the entity decorators: one primary channel account per channel, and idempotency keys unique
 *    only when present.
 */
export class Phase1Foundation1787000000000 implements MigrationInterface {
  name = 'Phase1Foundation1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
    // Optional in Phase 1, required from Phase 4. Swallow the failure so a stock Postgres image
    // still boots; docs/DEPLOYMENT.md records that a pgvector-capable image is needed for Phase 4.
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE EXTENSION IF NOT EXISTS "vector";
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pgvector unavailable — required from Phase 4 (knowledge embeddings)';
      END
      $$;
    `);

    // --- RBAC -------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key"         varchar(100) NOT NULL,
        "label"       varchar(160) NOT NULL,
        "category"    varchar(80)  NOT NULL,
        "isDangerous" boolean      NOT NULL DEFAULT false,
        CONSTRAINT "UQ_permissions_key" UNIQUE ("key")
      )`);

    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key"          varchar(64)  NOT NULL,
        "name"         varchar(120) NOT NULL,
        "description"  text,
        "isSystem"     boolean      NOT NULL DEFAULT false,
        "isSuperAdmin" boolean      NOT NULL DEFAULT false,
        "createdAt"    timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"    timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_roles_key" UNIQUE ("key")
      )`);

    await queryRunner.query(`
      CREATE TABLE "role_permissions" (
        "role_id"       uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
        "permission_id" uuid NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
        PRIMARY KEY ("role_id", "permission_id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_role_permissions_permission" ON "role_permissions" ("permission_id")`,
    );

    // --- Users & sessions -------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "username"            varchar(64)  NOT NULL,
        "email"               varchar(255) NOT NULL,
        "name"                varchar(160) NOT NULL,
        "passwordHash"        varchar(255) NOT NULL,
        "isActive"            boolean      NOT NULL DEFAULT true,
        "lastLoginAt"         timestamptz,
        "failedLoginAttempts" integer      NOT NULL DEFAULT 0,
        "lastFailedLoginAt"   timestamptz,
        "lockedUntil"         timestamptz,
        "createdAt"           timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"           timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_username" UNIQUE ("username"),
        CONSTRAINT "UQ_users_email"    UNIQUE ("email")
      )`);

    await queryRunner.query(`
      CREATE TABLE "user_roles" (
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
        PRIMARY KEY ("user_id", "role_id")
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_user_roles_role" ON "user_roles" ("role_id")`);

    await queryRunner.query(`
      CREATE TABLE "user_sessions" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "secretHash" varchar(64)  NOT NULL,
        "expiresAt"  timestamptz  NOT NULL,
        "revokedAt"  timestamptz,
        "lastUsedAt" timestamptz,
        "ipAddress"  varchar(64),
        "userAgent"  varchar(512),
        "createdAt"  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_sessions_secretHash" UNIQUE ("secretHash")
      )`);
    // Session lookup is by secretHash (already unique-indexed); these two serve revoke-all and purge.
    await queryRunner.query(`CREATE INDEX "IDX_user_sessions_userId" ON "user_sessions" ("userId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_user_sessions_expiresAt" ON "user_sessions" ("expiresAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "security_settings" (
        "id"                           varchar(16) PRIMARY KEY DEFAULT 'singleton',
        "loginLockoutThreshold"        integer NOT NULL DEFAULT 5,
        "loginLockoutWindowMinutes"    integer NOT NULL DEFAULT 15,
        "loginLockoutDurationMinutes"  integer NOT NULL DEFAULT 15,
        "sessionLifetimeHours"         integer NOT NULL DEFAULT 12,
        "passwordMinLength"            integer NOT NULL DEFAULT 8,
        "updatedAt"                    timestamptz NOT NULL DEFAULT now()
      )`);

    // --- Audit ------------------------------------------------------------
    // No FK on actorId on purpose: an audit row must outlive the user it refers to, and must never
    // be the reason a user row cannot be removed.
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "actorId"       uuid,
        "actorUsername" varchar(64),
        "action"        varchar(100) NOT NULL,
        "resource"      varchar(64)  NOT NULL,
        "resourceId"    varchar(128),
        "before"        jsonb,
        "after"         jsonb,
        "ipAddress"     varchar(64),
        "userAgent"     varchar(512),
        "metadata"      jsonb,
        "success"       boolean      NOT NULL DEFAULT true,
        "createdAt"     timestamptz  NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_createdAt" ON "audit_logs" ("createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_action" ON "audit_logs" ("action")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_resource" ON "audit_logs" ("resource", "resourceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_actor" ON "audit_logs" ("actorId", "createdAt")`,
    );

    // --- Settings ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "settings" (
        "key"         varchar(128) PRIMARY KEY,
        "value"       text,
        "valueType"   varchar(16)  NOT NULL DEFAULT 'string',
        "category"    varchar(64)  NOT NULL DEFAULT 'general',
        "description" text,
        "isPublic"    boolean      NOT NULL DEFAULT true,
        "updatedAt"   timestamptz  NOT NULL DEFAULT now(),
        "updatedById" uuid
      )`);

    // --- Channels ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "channels" (
        "key"        varchar(32) PRIMARY KEY,
        "name"       varchar(64) NOT NULL,
        "isEnabled"  boolean     NOT NULL DEFAULT false,
        "adapterKey" varchar(64),
        "updatedAt"  timestamptz NOT NULL DEFAULT now()
      )`);

    await queryRunner.query(`
      CREATE TABLE "channel_accounts" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelKey"       varchar(32)  NOT NULL REFERENCES "channels"("key") ON DELETE RESTRICT,
        "externalId"       varchar(128) NOT NULL,
        "label"            varchar(120) NOT NULL,
        "displayIdentity"  varchar(120),
        "status"           varchar(24)  NOT NULL DEFAULT 'DISCONNECTED',
        "lastError"        text,
        "isPrimary"        boolean      NOT NULL DEFAULT false,
        "capabilities"     jsonb,
        "lastConnectedAt"  timestamptz,
        "lastHeartbeatAt"  timestamptz,
        "createdAt"        timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"        timestamptz  NOT NULL DEFAULT now()
      )`);
    // The idempotency anchor for Phase 2's inbound pipeline: one account per external session id.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_channel_accounts_channel_external" ON "channel_accounts" ("channelKey", "externalId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_accounts_status" ON "channel_accounts" ("status")`,
    );
    // Partial unique index — at most one primary per channel. Not expressible in the entity DSL.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_channel_accounts_one_primary_per_channel"
        ON "channel_accounts" ("channelKey") WHERE "isPrimary" = true`);

    // --- Jobs -------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "jobs" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type"            varchar(48)  NOT NULL,
        "status"          varchar(32)  NOT NULL DEFAULT 'QUEUED',
        "name"            varchar(160) NOT NULL,
        "idempotencyKey"  varchar(128),
        "payload"         jsonb,
        "totalItems"      integer      NOT NULL DEFAULT 0,
        "completedItems"  integer      NOT NULL DEFAULT 0,
        "failedItems"     integer      NOT NULL DEFAULT 0,
        "error"           text,
        "cancelRequested" boolean      NOT NULL DEFAULT false,
        "createdById"     uuid,
        "startedAt"       timestamptz,
        "finishedAt"      timestamptz,
        "createdAt"       timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"       timestamptz  NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_jobs_status" ON "jobs" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_jobs_status_createdAt" ON "jobs" ("status", "createdAt")`);
    // Partial: many jobs legitimately have no idempotency key, and NULLs must not collide.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_jobs_idempotencyKey"
        ON "jobs" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "job_items" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "jobId"       uuid NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
        "reference"   varchar(190) NOT NULL,
        "status"      varchar(24)  NOT NULL DEFAULT 'PENDING',
        "payload"     jsonb,
        "result"      jsonb,
        "error"       text,
        "attempts"    integer      NOT NULL DEFAULT 0,
        "processedAt" timestamptz,
        "createdAt"   timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz  NOT NULL DEFAULT now()
      )`);
    // Serves the processor's "next PENDING batch for this job" query and the failed-items UI.
    await queryRunner.query(`CREATE INDEX "IDX_job_items_job_status" ON "job_items" ("jobId", "status")`);
  }

  /**
   * Reversible (`PROJECT_SPEC.md` §204). Dropped in reverse dependency order.
   * Extensions are deliberately NOT dropped: they may be in use by another schema in the same
   * database, and dropping a shared extension to revert one migration is not a safe trade.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "job_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_accounts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channels"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "security_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_roles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "role_permissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "roles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "permissions"`);
  }
}
