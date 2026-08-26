import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 10 — the admin Copilot and the learning loop.
 *
 * `PROJECT_SPEC.md` §85–§91, §135–§138.
 *
 * The table that carries the phase's whole principle is `automation_candidates`: a *proposal*,
 * never a live rule. The pipeline is conversation → pattern → candidate → **human review** →
 * approval → production, and the schema is shaped so the middle step cannot be skipped — a
 * candidate has no way to answer a customer, and becoming a rule means writing a row in
 * `automation_rules`, which arrives as a DRAFT and needs its own approval.
 *
 * `copilot_actions` exists for the same reason in the other direction: a Copilot write is recorded
 * with what it intended, who confirmed it, and what happened — so "the assistant changed something"
 * is never a thing anyone has to reconstruct.
 *
 * Additive.
 */
export class Phase10Copilot1788000000000 implements MigrationInterface {
  name = 'Phase10Copilot1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // === automation candidates (§85–§88, §135) ==================================================

    await queryRunner.query(`
      CREATE TABLE "automation_candidates" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title"         varchar(200) NOT NULL,
        -- What was noticed, in words a reviewer can judge without reading the source rows.
        "rationale"     text,
        "source"        varchar(24) NOT NULL DEFAULT 'PATTERN',
        -- The proposed rule, in the same shape an automation rule uses. Data, never code.
        "proposedConditions" jsonb,
        "proposedActions"    jsonb,
        "scopeType"     varchar(16),
        "scopeId"       uuid,
        -- How much evidence there is. A candidate seen twice is a coincidence; forty times is a gap.
        "occurrences"   integer NOT NULL DEFAULT 1,
        "sampleMessageIds" jsonb,
        "status"        varchar(16) NOT NULL DEFAULT 'PENDING',
        -- Set when a human turns it into a rule. The link is one-way and after the fact: a
        -- candidate never becomes a rule by itself.
        "publishedRuleId" uuid REFERENCES "automation_rules"("id") ON DELETE SET NULL,
        "reviewedById"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "reviewedAt"    timestamptz,
        "reviewNote"    varchar(1000),
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_automation_candidates_status"
          CHECK ("status" IN ('PENDING','APPROVED','REJECTED','PUBLISHED')),
        CONSTRAINT "CHK_automation_candidates_source"
          CHECK ("source" IN ('PATTERN','AI_SUGGESTED','FEEDBACK','MANUAL'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_candidates_status" ON "automation_candidates" ("status", "occurrences")`,
    );

    // === copilot actions (§89–§91, §137–§138) ===================================================

    await queryRunner.query(`
      CREATE TABLE "copilot_actions" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
        -- The operator's question, and the tool the Copilot proposed to satisfy it.
        "prompt"        text NOT NULL,
        "tool"          varchar(64),
        "arguments"     jsonb,
        -- READ executes immediately where permitted; WRITE never does (§90).
        "kind"          varchar(16) NOT NULL DEFAULT 'READ',
        "status"        varchar(24) NOT NULL DEFAULT 'PROPOSED',
        -- Stated before a write is confirmed: "this affects 500 groups" is the difference between
        -- a decision and an accident.
        "blastRadius"   varchar(500),
        "confirmedById" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "confirmedAt"   timestamptz,
        "result"        varchar(2000),
        "error"         varchar(1000),
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_copilot_actions_kind" CHECK ("kind" IN ('READ','WRITE')),
        CONSTRAINT "CHK_copilot_actions_status"
          CHECK ("status" IN ('PROPOSED','EXECUTED','CONFIRMED','REJECTED','FAILED','EXPIRED'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_copilot_actions_status" ON "copilot_actions" ("status", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "copilot_actions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_candidates"`);
  }
}
