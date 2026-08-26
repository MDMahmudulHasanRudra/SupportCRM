import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5 — the Message Decision Engine.
 *
 * `PROJECT_SPEC.md` §5–§26, §76–§80, §157–§161, §199.
 *
 * ```
 * automation_profiles ──< automation_profile_versions
 *         └──< automation_rules ──< automation_rule_versions
 *                     └──< automation_executions
 * decision_logs ──< ai_runs
 *       └──< escalations
 * broadcasts
 * ```
 *
 * The load-bearing constraint in this whole migration is `UNIQUE (messageId)` on `decision_logs`.
 * It is what makes "one inbound message produces at most one authoritative decision" a property of
 * the database rather than a hope about application code — a duplicate webhook, a redelivered job
 * or a second worker all collide on it and stop.
 *
 * Additive. No existing table is altered beyond three nullable profile columns.
 */
export class Phase5DecisionEngine1787500000000 implements MigrationInterface {
  name = 'Phase5DecisionEngine1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // === automation profiles (§29 of the brief, §42/§44 of the spec) =============================

    await queryRunner.query(`
      CREATE TABLE "automation_profiles" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"          varchar(120) NOT NULL,
        "description"   text,
        "status"        varchar(16)  NOT NULL DEFAULT 'DRAFT',
        "currentVersion" integer     NOT NULL DEFAULT 1,
        -- Everything a group needs configured, in one place. Assigning 2,400 groups to a profile and
        -- editing the profile once is the only way this system is operable at its stated scale.
        "aiEnabled"     boolean      NOT NULL DEFAULT false,
        "automationEnabled" boolean  NOT NULL DEFAULT true,
        "knowledgeProfileId" uuid REFERENCES "knowledge_profiles"("id") ON DELETE SET NULL,
        -- Null means "use the global setting". A profile overrides only what it states.
        "autoReplyMinConfidence"  numeric(4,3),
        "escalateBelowConfidence" numeric(4,3),
        "midConfidencePolicy"     varchar(16),
        "escalationPolicy"        jsonb,
        "businessHours"           jsonb,
        "humanTakeoverMinutes"    integer,
        "assignedTeamId"          uuid REFERENCES "support_teams"("id") ON DELETE SET NULL,
        "createdById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "updatedById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_automation_profiles_status"
          CHECK ("status" IN ('DRAFT', 'REVIEW', 'ACTIVE', 'PAUSED', 'ARCHIVED')),
        CONSTRAINT "CHK_automation_profiles_confidence"
          CHECK (("autoReplyMinConfidence" IS NULL OR ("autoReplyMinConfidence" >= 0 AND "autoReplyMinConfidence" <= 1))
             AND ("escalateBelowConfidence" IS NULL OR ("escalateBelowConfidence" >= 0 AND "escalateBelowConfidence" <= 1)))
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_automation_profiles_name" ON "automation_profiles" (lower("name"))`,
    );

    await queryRunner.query(`
      CREATE TABLE "automation_profile_versions" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "profileId"   uuid        NOT NULL REFERENCES "automation_profiles"("id") ON DELETE CASCADE,
        "version"     integer     NOT NULL,
        -- The whole profile as it stood. Immutable: what was approved must stay reconstructable.
        "snapshot"    jsonb       NOT NULL,
        "changeSummary" varchar(500),
        "createdById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"   timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_automation_profile_versions" ON "automation_profile_versions" ("profileId", "version")`,
    );

    // Bindings, mirroring Phase 4's knowledgeProfileId. Nullable: nothing changes for existing rows.
    await queryRunner.query(`
      ALTER TABLE "groups" ADD COLUMN "automationProfileId" uuid NULL
        REFERENCES "automation_profiles"("id") ON DELETE SET NULL`);
    await queryRunner.query(`
      ALTER TABLE "customers" ADD COLUMN "automationProfileId" uuid NULL
        REFERENCES "automation_profiles"("id") ON DELETE SET NULL`);
    await queryRunner.query(`
      ALTER TABLE "conversations" ADD COLUMN "automationProfileId" uuid NULL
        REFERENCES "automation_profiles"("id") ON DELETE SET NULL`);

    // === rules ===================================================================================

    await queryRunner.query(`
      CREATE TABLE "automation_rules" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "profileId"   uuid REFERENCES "automation_profiles"("id") ON DELETE CASCADE,
        "name"        varchar(160) NOT NULL,
        "description" text,
        -- DRAFT -> REVIEW -> ACTIVE -> PAUSED -> ARCHIVED. Only ACTIVE executes (§199).
        "status"      varchar(16)  NOT NULL DEFAULT 'DRAFT',
        "currentVersion" integer   NOT NULL DEFAULT 1,
        "priority"    integer      NOT NULL DEFAULT 0,
        -- Scope specificity is the FIRST ordering key, ahead of priority: a rule written for one
        -- conversation should beat a global catch-all however high the catch-all's priority.
        "scopeType"   varchar(16)  NOT NULL DEFAULT 'GLOBAL',
        "scopeId"     uuid,
        -- { match: 'ALL' | 'ANY', conditions: [...] } — DATA, never code. Nothing is ever eval'd.
        "conditions"  jsonb        NOT NULL DEFAULT '{"match":"ALL","conditions":[]}'::jsonb,
        "actions"     jsonb        NOT NULL DEFAULT '[]'::jsonb,
        "cooldownSeconds"  integer NOT NULL DEFAULT 0,
        "maxExecutions"    integer,
        "executionCount"   integer NOT NULL DEFAULT 0,
        "lastMatchedAt"    timestamptz,
        "effectiveFrom"    timestamptz,
        "effectiveUntil"   timestamptz,
        -- Who or what wrote this. AI-suggested rules are never ACTIVE without a human approving.
        "origin"      varchar(16)  NOT NULL DEFAULT 'HUMAN',
        "createdById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "updatedById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "approvedById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "approvedAt"  timestamptz,
        "createdAt"   timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_automation_rules_status"
          CHECK ("status" IN ('DRAFT', 'REVIEW', 'ACTIVE', 'PAUSED', 'ARCHIVED')),
        CONSTRAINT "CHK_automation_rules_scope"
          CHECK ("scopeType" IN ('GLOBAL', 'GROUP', 'CUSTOMER', 'CONVERSATION')),
        CONSTRAINT "CHK_automation_rules_scope_id"
          CHECK (("scopeType" = 'GLOBAL' AND "scopeId" IS NULL)
              OR ("scopeType" <> 'GLOBAL' AND "scopeId" IS NOT NULL)),
        CONSTRAINT "CHK_automation_rules_origin"
          CHECK ("origin" IN ('HUMAN', 'AI_SUGGESTED', 'IMPORTED'))
      )`);
    // The engine's hot path: active rules for this scope, most specific first.
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_rules_lookup" ON "automation_rules" ("status", "scopeType", "scopeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_rules_profile" ON "automation_rules" ("profileId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "automation_rule_versions" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ruleId"      uuid        NOT NULL REFERENCES "automation_rules"("id") ON DELETE CASCADE,
        "version"     integer     NOT NULL,
        "snapshot"    jsonb       NOT NULL,
        "status"      varchar(16) NOT NULL,
        "changeSummary" varchar(500),
        "createdById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"   timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_automation_rule_versions" ON "automation_rule_versions" ("ruleId", "version")`,
    );

    // === decision logs — the explanation of every runtime decision (§12 of the brief) =============

    await queryRunner.query(`
      CREATE TABLE "decision_logs" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- THE constraint of this migration. One message, one authoritative decision.
        "messageId"       uuid        NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
        "conversationId"  uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
        "channelAccountId" uuid       NOT NULL,
        "groupId"         uuid REFERENCES "groups"("id") ON DELETE SET NULL,
        "customerId"      uuid REFERENCES "customers"("id") ON DELETE SET NULL,
        "status"          varchar(16) NOT NULL DEFAULT 'IN_PROGRESS',
        "outcome"         varchar(24),
        -- Why, in one machine-readable token plus one human sentence.
        "reasonCode"      varchar(48),
        "reason"          varchar(1000),
        "ruleId"          uuid REFERENCES "automation_rules"("id") ON DELETE SET NULL,
        "ruleVersion"     integer,
        "profileId"       uuid REFERENCES "automation_profiles"("id") ON DELETE SET NULL,
        -- Which other rules matched but lost, so "why THAT rule" is answerable.
        "candidateRuleIds" jsonb,
        "aiProvider"      varchar(48),
        "aiModel"         varchar(120),
        "confidence"      numeric(4,3),
        /*
         * Whether the stored confidence is a measured probability. It is not: a language model's
         * self-report reads like one and is not calibrated. Recorded explicitly so nobody later
         * mistakes the number for something it is not.
         */
        "confidenceCalibrated" boolean NOT NULL DEFAULT false,
        "knowledgeUsed"   boolean     NOT NULL DEFAULT false,
        "knowledgeArticleIds" jsonb,
        "knowledgeChunkIds"   jsonb,
        "escalationReason" varchar(120),
        "humanRequired"   boolean     NOT NULL DEFAULT false,
        "responseMessageId" uuid REFERENCES "outbound_messages"("id") ON DELETE SET NULL,
        "processingTimeMs" integer,
        "error"           varchar(1000),
        "createdAt"       timestamptz NOT NULL DEFAULT now(),
        "completedAt"     timestamptz,
        CONSTRAINT "CHK_decision_logs_status"
          CHECK ("status" IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
        CONSTRAINT "CHK_decision_logs_confidence"
          CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1))
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_decision_logs_message" ON "decision_logs" ("messageId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_decision_logs_conversation" ON "decision_logs" ("conversationId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_decision_logs_outcome" ON "decision_logs" ("outcome", "createdAt")`,
    );

    // === rule executions — automation health (§23 of the brief) ==================================

    await queryRunner.query(`
      CREATE TABLE "automation_executions" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ruleId"      uuid        NOT NULL REFERENCES "automation_rules"("id") ON DELETE CASCADE,
        "ruleVersion" integer     NOT NULL,
        "decisionId"  uuid REFERENCES "decision_logs"("id") ON DELETE CASCADE,
        "conversationId" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
        "messageId"   uuid REFERENCES "messages"("id") ON DELETE SET NULL,
        -- MATCHED_WON / MATCHED_LOST / SKIPPED_COOLDOWN / SKIPPED_LIMIT / ERROR: enough to answer
        -- "which rules never fire" and "which rules conflict" without speculative analytics.
        "outcome"     varchar(24) NOT NULL,
        "detail"      varchar(500),
        "createdAt"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_automation_executions_outcome"
          CHECK ("outcome" IN ('MATCHED_WON', 'MATCHED_LOST', 'SKIPPED_COOLDOWN', 'SKIPPED_LIMIT', 'ACTION_FAILED'))
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_executions_rule" ON "automation_executions" ("ruleId", "createdAt")`,
    );

    // === AI runs — one row per provider call ======================================================

    await queryRunner.query(`
      CREATE TABLE "ai_runs" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "decisionId"    uuid REFERENCES "decision_logs"("id") ON DELETE CASCADE,
        "conversationId" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
        "purpose"       varchar(24) NOT NULL DEFAULT 'DECISION',
        "provider"      varchar(48) NOT NULL,
        "model"         varchar(120) NOT NULL,
        "status"        varchar(16) NOT NULL,
        "promptTokens"  integer,
        "completionTokens" integer,
        "latencyMs"     integer,
        "confidence"    numeric(4,3),
        -- The provider's failure, in the operator's terms. Never the request body: it contains
        -- customer content, and never the credential.
        "error"         varchar(1000),
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_ai_runs_status" CHECK ("status" IN ('SUCCESS', 'FAILED', 'TIMEOUT', 'RATE_LIMITED', 'UNAVAILABLE'))
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_runs_created" ON "ai_runs" ("createdAt")`);

    // === escalations ==============================================================================

    await queryRunner.query(`
      CREATE TABLE "escalations" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "conversationId" uuid        NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
        "messageId"      uuid REFERENCES "messages"("id") ON DELETE SET NULL,
        "decisionId"     uuid REFERENCES "decision_logs"("id") ON DELETE SET NULL,
        "reason"         varchar(48) NOT NULL,
        "detail"         varchar(1000),
        "confidence"     numeric(4,3),
        "status"         varchar(16) NOT NULL DEFAULT 'OPEN',
        "assignedToUserId" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "assignedToTeamId" uuid REFERENCES "support_teams"("id") ON DELETE SET NULL,
        "resolvedById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "resolvedAt"     timestamptz,
        "resolutionNote" varchar(1000),
        "createdAt"      timestamptz NOT NULL DEFAULT now(),
        "updatedAt"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_escalations_status" CHECK ("status" IN ('OPEN', 'ASSIGNED', 'RESOLVED', 'DISMISSED'))
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_escalations_status" ON "escalations" ("status", "createdAt")`,
    );
    // One open escalation per conversation: a conversation that escalates on three consecutive
    // messages is one problem, not three items in somebody's queue.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_escalations_open_conversation"
        ON "escalations" ("conversationId") WHERE "status" IN ('OPEN', 'ASSIGNED')`);

    // === broadcasts (§27 of the brief) ============================================================

    await queryRunner.query(`
      CREATE TABLE "broadcasts" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"          varchar(160) NOT NULL,
        "body"          text         NOT NULL,
        "channelAccountId" uuid      NOT NULL,
        -- What was targeted, as data: { groupIds: [...] } etc. Resolved to items when it starts.
        "target"        jsonb        NOT NULL,
        "status"        varchar(16)  NOT NULL DEFAULT 'DRAFT',
        "jobId"         uuid REFERENCES "jobs"("id") ON DELETE SET NULL,
        "scheduledAt"   timestamptz,
        "startedAt"     timestamptz,
        "completedAt"   timestamptz,
        "totalCount"    integer      NOT NULL DEFAULT 0,
        "successCount"  integer      NOT NULL DEFAULT 0,
        "failureCount"  integer      NOT NULL DEFAULT 0,
        "cancelledCount" integer     NOT NULL DEFAULT 0,
        "createdById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_broadcasts_status"
          CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED'))
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_broadcasts_status" ON "broadcasts" ("status", "createdAt")`);

    // === outbound provenance ======================================================================

    // Which decision caused this send. Without it, an automatic message in the outbound table is
    // unattributable, and "why did the system send this?" has no answer.
    await queryRunner.query(`
      ALTER TABLE "outbound_messages" ADD COLUMN "decisionId" uuid NULL
        REFERENCES "decision_logs"("id") ON DELETE SET NULL`);
    await queryRunner.query(`
      ALTER TABLE "outbound_messages" ADD COLUMN "broadcastId" uuid NULL
        REFERENCES "broadcasts"("id") ON DELETE SET NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "outbound_messages" DROP COLUMN IF EXISTS "broadcastId"`);
    await queryRunner.query(`ALTER TABLE "outbound_messages" DROP COLUMN IF EXISTS "decisionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "broadcasts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "escalations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_executions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "decision_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_rule_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_rules"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "automationProfileId"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "automationProfileId"`);
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN IF EXISTS "automationProfileId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_profile_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_profiles"`);
  }
}
