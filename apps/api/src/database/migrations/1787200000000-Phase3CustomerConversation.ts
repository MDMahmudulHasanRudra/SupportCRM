import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 — the customer and conversation domain.
 *
 * Explicit SQL, as in Phases 1 and 2, so every constraint is a reviewed decision
 * (`PROJECT_SPEC.md` §204).
 *
 * Three constraints carry the design intent and are worth reading before the rest:
 *
 *  1. `CK_customer_identities_unresolved_has_no_customer` — an `UNRESOLVED` identity may not point
 *     at a customer. The Phase 3 brief §2 forbids silently converting unknown participants into
 *     customers; this makes the database refuse it rather than trusting every future code path.
 *  2. `CK_conversation_assignments_one_target` — an assignment goes to exactly one of a user or a
 *     team, never both and never neither.
 *  3. `UQ_conversation_assignments_one_open` — a partial unique index allowing at most one OPEN
 *     assignment per conversation. Without it, two concurrent assignments both leave
 *     `unassignedAt` null and "who owns this" becomes unanswerable.
 */
export class Phase3CustomerConversation1787200000000 implements MigrationInterface {
  name = 'Phase3CustomerConversation1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- customers ---------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "customers" (
        "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "displayName"  varchar(190) NOT NULL,
        "primaryPhone" varchar(32),
        "email"        varchar(255),
        "company"      varchar(190),
        "status"       varchar(16)  NOT NULL DEFAULT 'ACTIVE',
        "source"       varchar(16)  NOT NULL DEFAULT 'MANUAL',
        "createdById"  uuid,
        "createdAt"    timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"    timestamptz  NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_customers_status" ON "customers" ("status")`);
    // Not unique: two customers can legitimately share a line (a shared office number). Enforcing
    // uniqueness on a convenience field would block a real case.
    await queryRunner.query(`CREATE INDEX "IDX_customers_phone" ON "customers" ("primaryPhone")`);
    // Trigram search over the name — ILIKE '%term%' cannot use a btree index (PROJECT_SPEC.md §115).
    await queryRunner.query(
      `CREATE INDEX "IDX_customers_name_trgm" ON "customers" USING gin ("displayName" gin_trgm_ops)`,
    );

    // --- customer identities -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "customer_identities" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "customerId"       uuid REFERENCES "customers"("id") ON DELETE SET NULL,
        "channelKey"       varchar(32)  NOT NULL REFERENCES "channels"("key") ON DELETE RESTRICT,
        "channelAccountId" uuid REFERENCES "channel_accounts"("id") ON DELETE SET NULL,
        "externalId"       varchar(190) NOT NULL,
        "phone"            varchar(32),
        "displayName"      varchar(190),
        "matchState"       varchar(16)  NOT NULL DEFAULT 'UNRESOLVED',
        "matchSource"      varchar(16)  NOT NULL DEFAULT 'MANUAL',
        "resolvedById"     uuid,
        "resolvedAt"       timestamptz,
        "resolutionNote"   text,
        "lastSeenAt"       timestamptz,
        "createdAt"        timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"        timestamptz  NOT NULL DEFAULT now(),

        -- The safety rule of Phase 3, enforced by the database rather than by convention:
        -- an unresolved identity belongs to nobody. See the class comment.
        CONSTRAINT "CK_customer_identities_unresolved_has_no_customer"
          CHECK ("matchState" <> 'UNRESOLVED' OR "customerId" IS NULL),

        -- Conversely, anything past UNRESOLVED must name the customer it refers to — including
        -- REJECTED, which is the record of which customer this identity is NOT.
        CONSTRAINT "CK_customer_identities_resolved_has_customer"
          CHECK ("matchState" = 'UNRESOLVED' OR "customerId" IS NOT NULL)
      )`);
    // One channel identity is one row. This is what makes duplicate-identity prevention a database
    // guarantee rather than an application check two replicas can race.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_customer_identities_channel_external" ON "customer_identities" ("channelKey", "externalId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_identities_customer_state" ON "customer_identities" ("customerId", "matchState")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_customer_identities_phone" ON "customer_identities" ("phone")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_identities_state" ON "customer_identities" ("matchState")`,
    );

    // --- support teams -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "support_teams" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key"         varchar(64)  NOT NULL,
        "name"        varchar(120) NOT NULL,
        "description" text,
        "isActive"    boolean      NOT NULL DEFAULT true,
        "createdAt"   timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_support_teams_key" UNIQUE ("key")
      )`);

    // --- conversations -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelKey"             varchar(32)  NOT NULL REFERENCES "channels"("key") ON DELETE RESTRICT,
        "channelAccountId"       uuid         NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
        "externalConversationId" varchar(190) NOT NULL,
        "kind"                   varchar(16)  NOT NULL,
        "groupId"                uuid REFERENCES "groups"("id") ON DELETE SET NULL,
        "customerId"             uuid REFERENCES "customers"("id") ON DELETE SET NULL,
        "subject"                varchar(255),

        "status"                 varchar(24)  NOT NULL DEFAULT 'OPEN',
        "priority"               varchar(16)  NOT NULL DEFAULT 'NORMAL',

        "controlState"           varchar(24)  NOT NULL DEFAULT 'AUTOMATION_ACTIVE',
        -- Both default FALSE. A conversation must not become eligible for AI or automation merely
        -- by existing; the day Phase 5/6 ship, nothing switches on retroactively.
        "aiEnabled"              boolean      NOT NULL DEFAULT false,
        "automationEnabled"      boolean      NOT NULL DEFAULT false,
        "pausedUntil"            timestamptz,

        "takeoverByUserId"       uuid,
        "takeoverReason"         text,
        "takeoverAt"             timestamptz,
        "takeoverExpiresAt"      timestamptz,

        "assignedToUserId"       uuid,
        "assignedToTeamId"       uuid REFERENCES "support_teams"("id") ON DELETE SET NULL,
        "assignedAt"             timestamptz,

        "lastMessageAt"          timestamptz,
        "lastInboundAt"          timestamptz,
        "lastOutboundAt"         timestamptz,
        "messageCount"           integer      NOT NULL DEFAULT 0,
        "isPinned"               boolean      NOT NULL DEFAULT false,
        "resolvedAt"             timestamptz,
        "resolvedById"           uuid,

        "createdAt"              timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"              timestamptz  NOT NULL DEFAULT now(),

        CONSTRAINT "CK_conversations_group_has_group_id"
          CHECK ("kind" <> 'GROUP' OR "groupId" IS NOT NULL)
      )`);
    // One chat is one conversation. The anchor that makes message→conversation resolution
    // deterministic and idempotent.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_conversations_account_external"
        ON "conversations" ("channelAccountId", "externalConversationId")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversations_status" ON "conversations" ("status")`);
    // The inbox's default ordering.
    await queryRunner.query(
      `CREATE INDEX "IDX_conversations_status_activity" ON "conversations" ("status", "lastMessageAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversations_assignee" ON "conversations" ("assignedToUserId", "status")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_conversations_customer" ON "conversations" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversations_activity" ON "conversations" ("lastMessageAt")`);
    // Drives the takeover-expiry sweep; partial so it only covers conversations that have one.
    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_takeover_expiry"
        ON "conversations" ("takeoverExpiresAt") WHERE "takeoverExpiresAt" IS NOT NULL`);

    // --- conversation participants -------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "conversation_participants" (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "conversationId"       uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
        "externalId"           varchar(190) NOT NULL,
        "customerIdentityId"   uuid REFERENCES "customer_identities"("id") ON DELETE SET NULL,
        "customerId"           uuid REFERENCES "customers"("id") ON DELETE SET NULL,
        "teamMemberIdentityId" uuid REFERENCES "team_member_identities"("id") ON DELETE SET NULL,
        "participantType"      varchar(16) NOT NULL DEFAULT 'UNKNOWN',
        "displayName"          varchar(190),
        "phone"                varchar(32),
        "isActive"             boolean     NOT NULL DEFAULT true,
        "firstSeenAt"          timestamptz,
        "lastSeenAt"           timestamptz,
        "createdAt"            timestamptz NOT NULL DEFAULT now(),
        "updatedAt"            timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_conversation_participants_conv_external"
        ON "conversation_participants" ("conversationId", "externalId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_participants_active" ON "conversation_participants" ("conversationId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_participants_customer" ON "conversation_participants" ("customerId")`,
    );

    // --- state history -------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "conversation_state_history" (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "conversationId"       uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
        "previousStatus"       varchar(24),
        "status"               varchar(24),
        "previousControlState" varchar(24),
        "controlState"         varchar(24),
        "source"               varchar(16) NOT NULL,
        "actorId"              uuid,
        "actorUsername"        varchar(64),
        "reason"               text,
        "createdAt"            timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_state_history_conv" ON "conversation_state_history" ("conversationId", "createdAt")`,
    );

    // --- assignment history ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "conversation_assignments" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "conversationId"   uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
        "assignedToUserId" uuid,
        "assignedToTeamId" uuid REFERENCES "support_teams"("id") ON DELETE SET NULL,
        "assignedById"     uuid,
        "reason"           text,
        "unassignedAt"     timestamptz,
        "unassignedById"   uuid,
        "createdAt"        timestamptz NOT NULL DEFAULT now(),

        -- Exactly one target. Both would be ambiguous; neither would be meaningless.
        CONSTRAINT "CK_conversation_assignments_one_target" CHECK (
          ("assignedToUserId" IS NOT NULL AND "assignedToTeamId" IS NULL) OR
          ("assignedToUserId" IS NULL AND "assignedToTeamId" IS NOT NULL)
        )
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_assignments_conv" ON "conversation_assignments" ("conversationId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_assignments_user" ON "conversation_assignments" ("assignedToUserId", "unassignedAt")`,
    );
    // At most one OPEN assignment per conversation. Without this, two concurrent assignments both
    // leave unassignedAt null and "who owns this" has two answers.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_conversation_assignments_one_open"
        ON "conversation_assignments" ("conversationId") WHERE "unassignedAt" IS NULL`);

    // --- customer notes, tags -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "customer_notes" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "customerId"     uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
        "body"           text NOT NULL,
        "authorId"       uuid,
        "authorUsername" varchar(64),
        "isPinned"       boolean     NOT NULL DEFAULT false,
        "createdAt"      timestamptz NOT NULL DEFAULT now(),
        "updatedAt"      timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_notes_customer" ON "customer_notes" ("customerId", "createdAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "tags" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key"         varchar(64) NOT NULL,
        "label"       varchar(80) NOT NULL,
        "color"       varchar(16),
        "description" text,
        "createdAt"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tags_key" UNIQUE ("key")
      )`);

    // Polymorphic by necessity — PROJECT_SPEC.md §111 names one `entity_tags`, and a FK cannot
    // point at three tables. Orphans are prevented by the owning service, not by the database.
    await queryRunner.query(`
      CREATE TABLE "entity_tags" (
        "tagId"      uuid        NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
        "entityType" varchar(24) NOT NULL,
        "entityId"   uuid        NOT NULL,
        "taggedById" uuid,
        "createdAt"  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tagId", "entityType", "entityId")
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_entity_tags_entity" ON "entity_tags" ("entityType", "entityId")`);

    // --- wire Phase 2 messages into conversations -------------------------------------------------
    // Phase 2 shipped `messages.conversationId` as a plain nullable column with no FK, precisely so
    // this migration could add the constraint once the table existed. ON DELETE SET NULL, not
    // CASCADE: deleting a conversation must never destroy the message record.
    await queryRunner.query(`
      ALTER TABLE "messages"
        ADD CONSTRAINT "FK_messages_conversation" FOREIGN KEY ("conversationId")
        REFERENCES "conversations"("id") ON DELETE SET NULL`);

    // The sender's resolved channel identity (Phase 3 brief §5: channel account + conversation +
    // sender identity + message).
    await queryRunner.query(`
      ALTER TABLE "messages"
        ADD COLUMN "senderIdentityId" uuid REFERENCES "customer_identities"("id") ON DELETE SET NULL`);
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_sender_identity" ON "messages" ("senderIdentityId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_sender_identity"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "senderIdentityId"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "FK_messages_conversation"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "entity_tags"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tags"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_notes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_assignments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_state_history"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_participants"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "support_teams"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_identities"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customers"`);
  }
}
