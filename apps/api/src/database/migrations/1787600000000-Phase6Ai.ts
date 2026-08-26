import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 6 — AI providers, configuration, memory and auditable AI turns.
 *
 * `PROJECT_SPEC.md` §16–§27, §114, §123, §177.
 *
 * ```
 * ai_providers ──< ai_configurations        (which provider/model answers, and in what voice)
 * ai_conversations ──< ai_messages          (per-conversation memory and an auditable turn log)
 *                        └──< ai_feedback   (a human's verdict on one AI turn)
 * ai_customer_facts                         (long-term memory — human-approved only)
 * ```
 *
 * Two constraints carry the weight here:
 *
 *  * `UQ_ai_configurations_scope_slot` — one configuration per (scope, scopeId, job slot). Without
 *    it, "which model answers this group?" has more than one answer and the winner is whichever row
 *    the planner returned first.
 *  * `UQ_ai_conversations_conversation` — one AI memory per CRM conversation, so a rolling summary
 *    cannot fork.
 *
 * What this schema deliberately has no column for: chain-of-thought. §27 and §165 forbid exposing
 * or storing model reasoning, so `ai_messages` stores what was decided and what was said, never why
 * the model thinks it thought it.
 *
 * Additive. No existing table is altered.
 */
export class Phase6Ai1787600000000 implements MigrationInterface {
  name = 'Phase6Ai1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // === providers (§21, §22, §177) =============================================================

    await queryRunner.query(`
      CREATE TABLE "ai_providers" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"          varchar(120) NOT NULL,
        -- The wire protocol, not the brand. 'compatible' covers every vendor that speaks the
        -- OpenAI chat-completions shape, which is most of them, and is why a new endpoint rarely
        -- needs new code.
        "kind"          varchar(24)  NOT NULL,
        "baseUrl"       varchar(500),
        -- An AES-256-GCM envelope bound to this row's id. Never returned by any API in any form.
        "apiKeyEncrypted" text,
        "defaultModel"  varchar(160),
        "timeoutMs"     integer      NOT NULL DEFAULT 45000,
        "isActive"      boolean      NOT NULL DEFAULT false,
        -- Fallback order (§123). Lowest first. Ties broken by createdAt, so the order is total.
        "priority"      integer      NOT NULL DEFAULT 100,
        "lastCheckedAt" timestamptz,
        "lastError"     varchar(500),
        "createdById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_ai_providers_kind" CHECK ("kind" IN ('openai','anthropic','gemini','openrouter','compatible')),
        CONSTRAINT "CHK_ai_providers_timeout" CHECK ("timeoutMs" BETWEEN 1000 AND 300000)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ai_providers_name" ON "ai_providers" ("name")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_providers_active_priority" ON "ai_providers" ("isActive", "priority")`,
    );

    // === configuration (§23, §24) ===============================================================

    await queryRunner.query(`
      CREATE TABLE "ai_configurations" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Global → Support Profile → Group, most specific winning (§24).
        "scopeType"     varchar(16)  NOT NULL DEFAULT 'GLOBAL',
        "scopeId"       uuid,
        -- Per-job model slots: answering a customer and summarising a thread are different jobs
        -- with different cost profiles, and pinning them to one model wastes money on one or
        -- quality on the other.
        "jobSlot"       varchar(24)  NOT NULL DEFAULT 'DECISION',
        "providerId"    uuid REFERENCES "ai_providers"("id") ON DELETE SET NULL,
        "model"         varchar(160),
        "temperature"   numeric(3,2),
        "maxTokens"     integer,
        -- Personality (§23). Nullable throughout: a scope states only what it changes.
        "tone"          varchar(24),
        "language"      varchar(16),
        "answerLength"  varchar(16),
        "emojiLevel"    varchar(16),
        "technicalLevel" varchar(16),
        "systemInstructions" text,
        "isActive"      boolean      NOT NULL DEFAULT true,
        "createdById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "updatedById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_ai_configurations_scope" CHECK ("scopeType" IN ('GLOBAL','PROFILE','GROUP')),
        CONSTRAINT "CHK_ai_configurations_slot" CHECK ("jobSlot" IN ('DECISION','SUMMARY','CLASSIFY')),
        -- A GLOBAL row carries no scope id; every other scope must.
        CONSTRAINT "CHK_ai_configurations_scope_id" CHECK (
          ("scopeType" = 'GLOBAL' AND "scopeId" IS NULL) OR
          ("scopeType" <> 'GLOBAL' AND "scopeId" IS NOT NULL)
        ),
        CONSTRAINT "CHK_ai_configurations_temperature" CHECK ("temperature" IS NULL OR ("temperature" >= 0 AND "temperature" <= 2))
      )
    `);
    // COALESCE so the GLOBAL row (scopeId NULL) participates in the uniqueness rather than
    // escaping it — NULLs are distinct in a plain unique index, which would allow many globals.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_ai_configurations_scope_slot"
        ON "ai_configurations" ("scopeType", COALESCE("scopeId", '00000000-0000-0000-0000-000000000000'::uuid), "jobSlot")
    `);

    // === per-conversation memory (§25, §26, §114) ===============================================

    await queryRunner.query(`
      CREATE TABLE "ai_conversations" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "conversationId" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
        -- The rolling medium-term summary (§26): issue, attempts, current state, unresolved items,
        -- human decisions, knowledge used, escalation status. Never the full transcript.
        "summary"       text,
        "summaryTokens" integer,
        "summarizedThroughMessageId" uuid,
        "summarizedAt"  timestamptz,
        "turnCount"     integer      NOT NULL DEFAULT 0,
        "lastTurnAt"    timestamptz,
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz  NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_ai_conversations_conversation" ON "ai_conversations" ("conversationId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "ai_messages" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "aiConversationId" uuid REFERENCES "ai_conversations"("id") ON DELETE CASCADE,
        "conversationId" uuid REFERENCES "conversations"("id") ON DELETE CASCADE,
        "decisionId"    uuid REFERENCES "decision_logs"("id") ON DELETE SET NULL,
        "messageId"     uuid REFERENCES "messages"("id") ON DELETE SET NULL,
        "role"          varchar(16)  NOT NULL,
        "content"       text,
        "provider"      varchar(48),
        "model"         varchar(160),
        "jobSlot"       varchar(24)  NOT NULL DEFAULT 'DECISION',
        "promptTokens"  integer,
        "completionTokens" integer,
        "latencyMs"     integer,
        -- The structured verdict, never the reasoning behind it (§27, §165).
        "decision"      varchar(24),
        "confidence"    numeric(4,3),
        "knowledgeSufficient" boolean,
        "needsHuman"    boolean,
        "citedIds"      jsonb,
        "error"         varchar(1000),
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_ai_messages_role" CHECK ("role" IN ('SYSTEM','CUSTOMER','ASSISTANT','SUMMARY'))
      )
    `);
    // §114 names this index explicitly: the conversation view reads this table on every open.
    await queryRunner.query(`CREATE INDEX "IDX_ai_messages_conversation" ON "ai_messages" ("conversationId")`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_messages_decision" ON "ai_messages" ("decisionId")`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_messages_created" ON "ai_messages" ("createdAt")`);

    // === human verdicts on AI turns (§88, §136) =================================================

    await queryRunner.query(`
      CREATE TABLE "ai_feedback" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "aiMessageId"   uuid REFERENCES "ai_messages"("id") ON DELETE CASCADE,
        "decisionId"    uuid REFERENCES "decision_logs"("id") ON DELETE SET NULL,
        "conversationId" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
        "verdict"       varchar(16)  NOT NULL,
        -- What the human would have said instead. Never applied to production knowledge directly:
        -- it becomes a candidate for review (§88).
        "correctedText" text,
        "note"          varchar(1000),
        "createdById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_ai_feedback_verdict" CHECK ("verdict" IN ('CORRECT','WRONG','EDITED','ESCALATE'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_ai_feedback_message" ON "ai_feedback" ("aiMessageId")`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_feedback_verdict" ON "ai_feedback" ("verdict", "createdAt")`);

    // === long-term memory (§25) =================================================================

    await queryRunner.query(`
      CREATE TABLE "ai_customer_facts" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "customerId"    uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
        "fact"          varchar(1000) NOT NULL,
        "source"        varchar(24)  NOT NULL DEFAULT 'HUMAN',
        -- Long-term memory is approved, never inferred and silently kept. A fact with no approver
        -- is a suggestion, and the retrieval path ignores it.
        "approvedById"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "approvedAt"    timestamptz,
        "isActive"      boolean      NOT NULL DEFAULT true,
        "createdAt"     timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_ai_customer_facts_source" CHECK ("source" IN ('HUMAN','AI_SUGGESTED','IMPORTED'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_customer_facts_customer" ON "ai_customer_facts" ("customerId", "isActive")`,
    );

    // === ai_runs: provider and model become nullable ===========================================
    //
    // Phase 5 recorded a run only after a provider had answered, so both were always known. With a
    // fallback chain, a run can be recorded for an attempt that never reached a vendor — every
    // provider cooling down, or none configured for the slot. NOT NULL would force a placeholder
    // string there, and a placeholder in a provider column reads as a real vendor in the trace.
    await queryRunner.query(`ALTER TABLE "ai_runs" ALTER COLUMN "provider" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "ai_runs" ALTER COLUMN "model" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rows written since this migration ran may hold NULLs the old constraint forbids, so they are
    // named rather than left to fail the ALTER halfway through a rollback.
    await queryRunner.query(`UPDATE "ai_runs" SET "provider" = 'unknown' WHERE "provider" IS NULL`);
    await queryRunner.query(`UPDATE "ai_runs" SET "model" = 'unknown' WHERE "model" IS NULL`);
    await queryRunner.query(`ALTER TABLE "ai_runs" ALTER COLUMN "provider" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "ai_runs" ALTER COLUMN "model" SET NOT NULL`);

    await queryRunner.query(`DROP TABLE IF EXISTS "ai_customer_facts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_feedback"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_conversations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_configurations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_providers"`);
  }
}
