import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 11 — per-group pattern analysis, and the indexes the group operations screen needs.
 *
 * ## Why `patternAnalysisEnabled` is a column and not a setting
 *
 * The candidate detector mines every stored message for repeated questions that reached a human.
 * That is useful for a support group and wrong for an internal or social one, where the "repeated
 * question" it surfaces is chatter. Which groups feed it is a per-group decision, and there was no
 * way to express it.
 *
 * **Defaults to true, deliberately.** Every group already contributes today; defaulting to false
 * would silently switch off working behaviour on deploy, which is a worse outcome than a flag that
 * starts permissive and can be narrowed.
 *
 * ## Indexes
 *
 * The group operations screen sorts and filters ~3,000 groups server-side, and its per-group
 * counters aggregate over `messages`. Postgres will happily sequential-scan a million-row message
 * table once per request without these.
 *
 * Additive only: no column is dropped, no data rewritten, nothing about existing rows changes
 * beyond gaining a default.
 */
export class Phase11GroupMonitoring1788100000000 implements MigrationInterface {
  name = 'Phase11GroupMonitoring1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "groups"
        ADD COLUMN IF NOT EXISTS "patternAnalysisEnabled" boolean NOT NULL DEFAULT true
    `);

    // The group list filters and sorts on these, and an operator with 3,000 groups changes the
    // filter constantly.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_groups_account_active_lastmsg"
        ON "groups" ("channelAccountId", "isActive", "lastMessageAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_groups_ai_enabled" ON "groups" ("aiEnabled")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_groups_monitoring_state" ON "groups" ("monitoringState")
    `);

    /*
     * Per-group message counters.
     *
     * `(groupId, sentAt)` already exists from Phase 2 for the timeline. What the operations screen
     * additionally needs is a count per group split by direction and classification — "how many AI
     * replies, how many human support messages" — so the classification joins the key.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_group_classification"
        ON "messages" ("groupId", "classification", "sentAt" DESC)
        WHERE "groupId" IS NOT NULL
    `);

    // Support analytics counts distinct groups per sender per day. Without this the query walks
    // every message the account has ever seen.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_sender_sentat"
        ON "messages" ("senderExternalId", "sentAt" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_sender_sentat"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_group_classification"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_groups_monitoring_state"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_groups_ai_enabled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_groups_account_active_lastmsg"`);
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN IF EXISTS "patternAnalysisEnabled"`);
  }
}
