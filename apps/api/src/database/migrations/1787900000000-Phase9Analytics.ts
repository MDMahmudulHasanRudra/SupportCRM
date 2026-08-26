import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 9 — reporting indexes.
 *
 * `PROJECT_SPEC.md` §100–§106, §119.
 *
 * **No aggregate tables.** Every figure the dashboard shows is computed from the raw event tables
 * at query time. That is a deliberate choice with a real cost — the queries are heavier — and a
 * real payoff: a counting rule that changes reinterprets history retroactively, instead of leaving
 * a pre-aggregated table that disagrees with the rows it was built from and no way to tell which
 * is right.
 *
 * What is added is the indexes those queries need. Materialised aggregates come later if, and only
 * if, measurement shows they are needed (§119) — not on the suspicion that they might be.
 */
export class Phase9Analytics1787900000000 implements MigrationInterface {
  name = 'Phase9Analytics1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Every report is "in this window, grouped by something". These are the windows.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conversations_created" ON "conversations" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conversations_status_created" ON "conversations" ("status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_direction_sent" ON "messages" ("direction", "sentAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_decision_logs_outcome_created" ON "decision_logs" ("outcome", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_escalations_created" ON "escalations" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_outbound_status_created" ON "outbound_messages" ("status", "createdAt")`,
    );

    // Team performance is per-agent and per-window (§69), and without this it is a sequential scan
    // of every conversation the company has ever had.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conversations_assigned_created" ON "conversations" ("assignedToUserId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_assigned_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_outbound_status_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_escalations_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_decision_logs_outcome_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_direction_sent"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_status_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_created"`);
  }
}
