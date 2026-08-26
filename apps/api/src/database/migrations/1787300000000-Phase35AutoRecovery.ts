import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3.5 — automatic reconnect state.
 *
 * A WhatsApp Web session drops on its own: the real-WhatsApp validation saw one unattended drop
 * inside twenty minutes, and until an operator noticed and pressed Connect, every inbound message
 * to that number was simply lost. These four columns are what lets the worker recover it without a
 * human, and — just as importantly — what stops it from retrying forever or fighting an operator
 * who deliberately took the account down.
 *
 * Additive only. No existing column or index is touched.
 */
export class Phase35AutoRecovery1787300000000 implements MigrationInterface {
  name = 'Phase35AutoRecovery1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "channel_accounts"
        -- Consecutive failed automatic attempts. Reset to 0 the moment the account connects, so a
        -- session that flaps once a week never accumulates its way to exhaustion.
        ADD COLUMN "recoveryAttempts" integer NOT NULL DEFAULT 0,
        -- When the next automatic attempt becomes due. NULL means none is scheduled.
        ADD COLUMN "recoveryNextAttemptAt" timestamptz NULL,
        -- Set when the attempt budget is spent. The account then waits for a human, and the UI says
        -- so rather than showing a spinner that will never resolve.
        ADD COLUMN "recoveryExhaustedAt" timestamptz NULL,
        -- Set when an OPERATOR asked for the account to be down. Automatic recovery must never
        -- undo a deliberate disconnect — the whole point of that button is that the account stays
        -- off until someone says otherwise.
        ADD COLUMN "disconnectRequestedAt" timestamptz NULL
    `);

    // The sweep asks "which accounts are due for a retry?" every minute. Partial: only rows with a
    // scheduled attempt are ever candidates, which is normally none of them.
    await queryRunner.query(`
      CREATE INDEX "IDX_channel_accounts_recovery_due"
        ON "channel_accounts" ("recoveryNextAttemptAt")
        WHERE "recoveryNextAttemptAt" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_accounts_recovery_due"`);
    await queryRunner.query(`
      ALTER TABLE "channel_accounts"
        DROP COLUMN "disconnectRequestedAt",
        DROP COLUMN "recoveryExhaustedAt",
        DROP COLUMN "recoveryNextAttemptAt",
        DROP COLUMN "recoveryAttempts"
    `);
  }
}
