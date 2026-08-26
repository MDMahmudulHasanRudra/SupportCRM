import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 defect fix — separate the gateway session's NAME from its ID.
 *
 * ## The defect
 *
 * Phase 2 stored the operator-chosen session name in `channel_accounts.externalId` and used that
 * value as the `{sessionId}` path parameter on every gateway route. Real-gateway validation showed
 * that is wrong: `POST /api/sessions {name}` returns `{ id, name }` where `id` is a **UUID**, and
 * every `/api/sessions/{sessionId}/…` route validates the parameter as a UUID —
 * `GET /api/sessions/validation-test` answers `400 "Validation failed (uuid is expected)"`.
 *
 * Nothing in Phase 2's test suite caught this because the contract stub keyed its sessions by name
 * and answered to either. The stub has been corrected in the same change so it can never hide this
 * class of defect again.
 *
 * ## The fix
 *
 * `externalId` becomes the gateway's UUID — which is also what the webhook envelope's `sessionId`
 * carries, so inbound account lookup and outbound path construction finally agree on one value.
 * `externalName` holds the operator-chosen name, which is what `POST /api/sessions` is given.
 *
 * `externalId` becomes NULLABLE because an account legitimately exists before its gateway session
 * does: registration records the intent, `connect()` creates the session and learns the UUID.
 * Postgres treats NULLs as distinct in a unique index, so several unconnected accounts coexist.
 *
 * Existing rows hold a name in `externalId`; that value is moved to `externalName` and `externalId`
 * is cleared, so the next `connect()` re-establishes the real UUID rather than carrying a value
 * that would keep producing 400s.
 */
export class FixGatewaySessionIdentity1787150000000 implements MigrationInterface {
  name = 'FixGatewaySessionIdentity1787150000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "channel_accounts" ADD COLUMN "externalName" varchar(128)`);

    // Existing rows hold the NAME in externalId. Move it, then clear the misused column.
    await queryRunner.query(`UPDATE "channel_accounts" SET "externalName" = "externalId"`);
    await queryRunner.query(`ALTER TABLE "channel_accounts" ALTER COLUMN "externalName" SET NOT NULL`);

    await queryRunner.query(`ALTER TABLE "channel_accounts" ALTER COLUMN "externalId" DROP NOT NULL`);
    // Clear the stale names: they are not UUIDs, and keeping them would mean every gateway call for
    // a pre-existing account kept failing validation. connect() repopulates this correctly.
    await queryRunner.query(`UPDATE "channel_accounts" SET "externalId" = NULL`);

    // The name is what an operator types and what identifies the session to them, so it must be
    // unique per channel in its own right.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_channel_accounts_channel_name"
        ON "channel_accounts" ("channelKey", "externalName")`);

    // The existing (channelKey, externalId) unique index still applies and now covers the UUID.
    // Postgres allows multiple NULLs in a unique index, so unconnected accounts do not collide.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_channel_accounts_channel_name"`);
    // Restore the pre-fix shape: the name lived in externalId.
    await queryRunner.query(`UPDATE "channel_accounts" SET "externalId" = "externalName"`);
    await queryRunner.query(`ALTER TABLE "channel_accounts" ALTER COLUMN "externalId" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "channel_accounts" DROP COLUMN "externalName"`);
  }
}
