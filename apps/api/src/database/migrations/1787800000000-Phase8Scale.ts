import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 8 — scale: broadcast recipients, onboarding rules and per-scope rate limits.
 *
 * `PROJECT_SPEC.md` §47–§51, §57, §94–§99, §134, §175, §195–§197.
 *
 * The load-bearing constraint is `UNIQUE (broadcastId, externalConversationId)` on
 * `broadcast_recipients`. A broadcast is a fan-out over thousands of rows with retries on top;
 * without that index a retried batch sends a second copy to people who already received one, and
 * "we messaged 2,000 customers twice" is not a recoverable mistake.
 *
 * Recipients are also *materialised* at start rather than recomputed per batch, so a group that
 * gains a member mid-send does not receive a message nobody approved for them (§196).
 *
 * Additive.
 */
export class Phase8Scale1787800000000 implements MigrationInterface {
  name = 'Phase8Scale1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // === broadcast recipients (§94–§97, §195–§197) ==============================================

    await queryRunner.query(`
      CREATE TABLE "broadcast_recipients" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "broadcastId"   uuid NOT NULL REFERENCES "broadcasts"("id") ON DELETE CASCADE,
        "groupId"       uuid REFERENCES "groups"("id") ON DELETE SET NULL,
        "conversationId" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
        -- The address actually written to. Resolved once, at start.
        "externalConversationId" varchar(190) NOT NULL,
        "displayName"   varchar(190),
        -- Only statuses that describe something that really happened (§195). No 'delivered' unless
        -- the channel reported one.
        "status"        varchar(16) NOT NULL DEFAULT 'PENDING',
        "outboundMessageId" uuid REFERENCES "outbound_messages"("id") ON DELETE SET NULL,
        "failureReason" varchar(500),
        "skippedReason" varchar(200),
        "sentAt"        timestamptz,
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_broadcast_recipients_status"
          CHECK ("status" IN ('PENDING','QUEUED','SENT','DELIVERED','FAILED','SKIPPED','CANCELLED'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_broadcast_recipients_once"
        ON "broadcast_recipients" ("broadcastId", "externalConversationId")
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_broadcast_recipients_status" ON "broadcast_recipients" ("broadcastId", "status")`,
    );

    // Broadcasts gain the fields a real campaign needs: what it is sending, and what it skipped.
    await queryRunner.query(`ALTER TABLE "broadcasts" ADD COLUMN "mediaType" varchar(24)`);
    await queryRunner.query(`ALTER TABLE "broadcasts" ADD COLUMN "mediaRef" varchar(500)`);
    await queryRunner.query(`ALTER TABLE "broadcasts" ADD COLUMN "skippedCount" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "broadcasts" ADD COLUMN "testSentAt" timestamptz`);

    // === group onboarding rules (§98, §99, §134) ================================================

    await queryRunner.query(`
      CREATE TABLE "group_onboarding_rules" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"          varchar(160) NOT NULL,
        -- Matched against a newly discovered group's name. Substring, case-insensitive: the spec's
        -- own example is 'name contains "VIP"', and a regular expression here would be a foot-gun
        -- for the operators who write these.
        "nameContains"  varchar(190),
        "channelAccountId" uuid REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
        "priority"      integer NOT NULL DEFAULT 100,
        "isActive"      boolean NOT NULL DEFAULT true,
        -- What to apply when it matches. All nullable: a rule states only what it sets.
        "automationProfileId" uuid REFERENCES "automation_profiles"("id") ON DELETE SET NULL,
        "knowledgeProfileId"  uuid,
        "monitoringState" varchar(16),
        "automationEnabled" boolean,
        "aiEnabled"     boolean,
        "escalationPolicy" jsonb,
        "notifyGroupId" uuid REFERENCES "groups"("id") ON DELETE SET NULL,
        "matchCount"    integer NOT NULL DEFAULT 0,
        "lastMatchedAt" timestamptz,
        "createdById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_group_onboarding_monitoring"
          CHECK ("monitoringState" IS NULL OR "monitoringState" IN ('MONITORED','IGNORED','PENDING'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_group_onboarding_active" ON "group_onboarding_rules" ("isActive", "priority")`,
    );

    // Records that a group has been through onboarding, so a resync does not re-apply rules over an
    // operator's later manual changes.
    await queryRunner.query(`ALTER TABLE "groups" ADD COLUMN "onboardedAt" timestamptz`);
    await queryRunner.query(`ALTER TABLE "groups" ADD COLUMN "onboardingRuleId" uuid`);

    // === rate limits (§57, §175) ================================================================

    await queryRunner.query(`
      CREATE TABLE "rate_limit_policies" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- What is being limited: session, group, destination, broadcast, automation, ai, api.
        "scope"         varchar(24) NOT NULL,
        -- Null means "the default for this scope". A row with a scopeId narrows it to one subject.
        "scopeId"       uuid,
        "limit"         integer NOT NULL,
        "windowSeconds" integer NOT NULL,
        "isActive"      boolean NOT NULL DEFAULT true,
        "note"          varchar(500),
        "updatedById"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        "updatedAt"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_rate_limit_scope"
          CHECK ("scope" IN ('SESSION','GROUP','DESTINATION','BROADCAST','AUTOMATION','AI','API')),
        CONSTRAINT "CHK_rate_limit_values" CHECK ("limit" > 0 AND "windowSeconds" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rate_limit_scope"
        ON "rate_limit_policies" ("scope", COALESCE("scopeId", '00000000-0000-0000-0000-000000000000'::uuid))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "rate_limit_policies"`);
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN IF EXISTS "onboardingRuleId"`);
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN IF EXISTS "onboardedAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "group_onboarding_rules"`);
    await queryRunner.query(`ALTER TABLE "broadcasts" DROP COLUMN IF EXISTS "testSentAt"`);
    await queryRunner.query(`ALTER TABLE "broadcasts" DROP COLUMN IF EXISTS "skippedCount"`);
    await queryRunner.query(`ALTER TABLE "broadcasts" DROP COLUMN IF EXISTS "mediaRef"`);
    await queryRunner.query(`ALTER TABLE "broadcasts" DROP COLUMN IF EXISTS "mediaType"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "broadcast_recipients"`);
  }
}
