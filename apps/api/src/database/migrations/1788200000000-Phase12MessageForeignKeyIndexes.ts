import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 12 — indexes on the foreign keys that reference `messages`.
 *
 * ## The problem this fixes
 *
 * Five tables carry a foreign key to `messages` and none of them indexed the referencing column.
 * Postgres does not index the *referencing* side of a foreign key automatically — only the
 * referenced side, via its primary key. So every time a message row is deleted, the database has to
 * prove no row still points at it, and with no index that proof is a sequential scan of each of the
 * five tables, per deleted row.
 *
 * Measured on a 3,000-group / 201,000-message dataset: deleting 201,000 messages ran for **over
 * eleven minutes without completing** and had to be cancelled. With these indexes in place the same
 * delete finished in **12.5 seconds**.
 *
 * That matters well beyond a test cleanup. Message deletion is what a retention policy does, what
 * an erasure request does, and what any purge of an old account does. At the volume this product is
 * designed for, all three were effectively impossible.
 *
 * ## Why partial
 *
 * Every one of these columns is nullable, and most rows are null — an `ai_messages` row usually has
 * no originating message, and most messages quote nothing. A partial index skips the nulls, which
 * is the overwhelming majority of the table, so it stays small enough to be worth keeping in cache.
 * Foreign key checks only ever look for a specific non-null id, so nothing is lost.
 *
 * ## Safety
 *
 * Additive only. No column, constraint or row is altered, and an index cannot change a query's
 * result — only how quickly it is reached. `IF NOT EXISTS` because these were first created by hand
 * on the running database while diagnosing the problem; this migration makes them part of the
 * schema so a fresh deployment is not silently slower than an existing one.
 *
 * Created without `CONCURRENTLY`: TypeORM runs each migration inside a transaction, and
 * `CREATE INDEX CONCURRENTLY` cannot run in one. These tables are small enough at deploy time that
 * the brief write lock is not worth splitting the migration to avoid.
 */
export class Phase12MessageForeignKeyIndexes1788200000000 implements MigrationInterface {
  name = 'Phase12MessageForeignKeyIndexes1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_quoted_message_id"
        ON "messages" ("quotedMessageId") WHERE "quotedMessageId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbound_messages_message_id"
        ON "outbound_messages" ("messageId") WHERE "messageId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_automation_executions_message_id"
        ON "automation_executions" ("messageId") WHERE "messageId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_escalations_message_id"
        ON "escalations" ("messageId") WHERE "messageId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_messages_message_id"
        ON "ai_messages" ("messageId") WHERE "messageId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_ai_messages_message_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_escalations_message_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_automation_executions_message_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbound_messages_message_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_quoted_message_id"`);
  }
}
