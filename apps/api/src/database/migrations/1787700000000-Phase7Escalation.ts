import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 7 — escalation routing, notification and the kill switch.
 *
 * `PROJECT_SPEC.md` §28–§41, §186, §190–§193.
 *
 * The table that matters most here is `escalation_events`, and specifically its unique index.
 * Notifying an internal group that a customer is waiting is exactly the kind of side effect that
 * gets sent twice: a retried job, a redelivered webhook, two workers racing on one conversation.
 * `UNIQUE (escalationId, kind, target)` makes a duplicate notification impossible at the database
 * rather than unlikely in application code — the same claim-first shape `decision_logs` uses.
 *
 * Additive. Two nullable jsonb columns are added to existing tables; nothing is altered or dropped.
 */
export class Phase7Escalation1787700000000 implements MigrationInterface {
  name = 'Phase7Escalation1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // === notification attempts (§29, §33, §34) ==================================================

    await queryRunner.query(`
      CREATE TABLE "escalation_events" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "escalationId"  uuid NOT NULL REFERENCES "escalations"("id") ON DELETE CASCADE,
        "kind"          varchar(32) NOT NULL,
        -- Who or what was notified: a group id, a user id, or the literal 'dashboard'. Part of the
        -- uniqueness, so notifying two executives is two rows and notifying one twice is one.
        "target"        varchar(190) NOT NULL,
        "status"        varchar(16) NOT NULL DEFAULT 'PENDING',
        "detail"        varchar(1000),
        "sentAt"        timestamptz,
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_escalation_events_kind" CHECK ("kind" IN ('NOTIFY_INTERNAL_GROUP','NOTIFY_EXECUTIVE','NOTIFY_CUSTOMER','DASHBOARD')),
        CONSTRAINT "CHK_escalation_events_status" CHECK ("status" IN ('PENDING','SENT','FAILED','SKIPPED'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_escalation_events_once"
        ON "escalation_events" ("escalationId", "kind", "target")
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_escalation_events_status" ON "escalation_events" ("status", "createdAt")`,
    );

    // === escalation configuration (§30, §33–§34) ================================================
    //
    // `automation_profiles` already carries an `escalationPolicy` jsonb from Phase 5. Groups gain
    // the same shape so the Global → Profile → Group → Conversation hierarchy has a place to store
    // every level, and a settings row supplies the global floor.
    await queryRunner.query(`ALTER TABLE "groups" ADD COLUMN "escalationPolicy" jsonb`);

    // Priority and the score that produced it, so "why was this urgent?" is answerable later.
    await queryRunner.query(`ALTER TABLE "escalations" ADD COLUMN "priority" varchar(16) NOT NULL DEFAULT 'NORMAL'`);
    await queryRunner.query(`ALTER TABLE "escalations" ADD COLUMN "score" integer`);
    await queryRunner.query(`ALTER TABLE "escalations" ADD COLUMN "notifiedAt" timestamptz`);
    await queryRunner.query(`
      ALTER TABLE "escalations"
        ADD CONSTRAINT "CHK_escalations_priority" CHECK ("priority" IN ('LOW','NORMAL','HIGH','URGENT'))
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_escalations_priority" ON "escalations" ("priority", "status", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_escalations_priority"`);
    await queryRunner.query(`ALTER TABLE "escalations" DROP CONSTRAINT IF EXISTS "CHK_escalations_priority"`);
    await queryRunner.query(`ALTER TABLE "escalations" DROP COLUMN IF EXISTS "notifiedAt"`);
    await queryRunner.query(`ALTER TABLE "escalations" DROP COLUMN IF EXISTS "score"`);
    await queryRunner.query(`ALTER TABLE "escalations" DROP COLUMN IF EXISTS "priority"`);
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN IF EXISTS "escalationPolicy"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "escalation_events"`);
  }
}
