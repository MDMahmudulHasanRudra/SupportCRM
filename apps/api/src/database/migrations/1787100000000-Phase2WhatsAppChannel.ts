import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 — the WhatsApp channel foundation.
 *
 * Explicit SQL, as in Phase 1, so every constraint is a reviewed decision (`PROJECT_SPEC.md` §204).
 *
 * The single most important line in this file is the unique index on
 * `messages (channelAccountId, externalId)`. It is what makes duplicate webhook delivery harmless,
 * and the gateway's own documentation states that a queue failure there can double-POST the same
 * event. An application-level check cannot hold that line across two API replicas; this index can.
 *
 * Also note the `channel_accounts.status` remap. Phase 1 shipped `ACTION_REQUIRED`; Phase 2 uses the
 * normalized lifecycle from the brief, in which that state is `QR_REQUIRED`. Existing rows are
 * translated in both directions so the migration is genuinely reversible.
 */
export class Phase2WhatsAppChannel1787100000000 implements MigrationInterface {
  name = 'Phase2WhatsAppChannel1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- channel_accounts: ownership, webhook provisioning, normalized states ---------------
    // `accountPhone` is deliberately distinct from `externalId`: the latter is the gateway's session
    // NAME (operator-chosen), while this is the WhatsApp number the session is actually paired to.
    // Conflating them means the connected account cannot recognise itself in a participant list.
    await queryRunner.query(`
      ALTER TABLE "channel_accounts"
        ADD COLUMN "ownershipEnabled"       boolean NOT NULL DEFAULT true,
        ADD COLUMN "accountPhone"           varchar(32),
        ADD COLUMN "webhookExternalId"      varchar(128),
        ADD COLUMN "webhookSecretEncrypted" text`);

    await queryRunner.query(
      `UPDATE "channel_accounts" SET "status" = 'QR_REQUIRED' WHERE "status" = 'ACTION_REQUIRED'`,
    );

    await queryRunner.query(`
      CREATE TABLE "channel_connection_events" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelAccountId" uuid NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
        "previousState"    varchar(24),
        "state"            varchar(24) NOT NULL,
        "source"           varchar(24) NOT NULL,
        "rawState"         varchar(64),
        "detail"           text,
        "actorId"          uuid,
        "createdAt"        timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_connection_events_account_time" ON "channel_connection_events" ("channelAccountId", "createdAt")`,
    );

    // --- team member channel identities ------------------------------------------------------
    // No FK to "users": an identity may exist for someone with no dashboard login, and removing a
    // user must never be blocked by their historical WhatsApp identity.
    await queryRunner.query(`
      CREATE TABLE "team_member_identities" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId"      uuid,
        "channelKey"  varchar(32)  NOT NULL REFERENCES "channels"("key") ON DELETE RESTRICT,
        "externalId"  varchar(190) NOT NULL,
        "phone"       varchar(32)  NOT NULL,
        "displayName" varchar(160) NOT NULL,
        "jobRole"     varchar(80),
        "isActive"    boolean      NOT NULL DEFAULT true,
        "createdAt"   timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz  NOT NULL DEFAULT now()
      )`);
    // Both unique: one JID and one phone number may each belong to exactly one team member.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_team_identity_channel_external" ON "team_member_identities" ("channelKey", "externalId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_team_identity_channel_phone" ON "team_member_identities" ("channelKey", "phone")`,
    );

    // --- groups ------------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "groups" (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelKey"            varchar(32)  NOT NULL REFERENCES "channels"("key") ON DELETE RESTRICT,
        "channelAccountId"      uuid         NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
        "externalId"            varchar(190) NOT NULL,
        "name"                  varchar(255) NOT NULL,
        "description"           text,
        "participantCount"      integer,
        "ownerExternalId"       varchar(190),
        "isActive"              boolean      NOT NULL DEFAULT true,
        "isAnnounceOnly"        boolean      NOT NULL DEFAULT false,
        "monitoringState"       varchar(16)  NOT NULL DEFAULT 'UNMONITORED',
        "aiEnabled"             boolean      NOT NULL DEFAULT false,
        "automationEnabled"     boolean      NOT NULL DEFAULT false,
        "lastSyncedAt"          timestamptz,
        "participantsSyncedAt"  timestamptz,
        "lastMessageAt"         timestamptz,
        "createdAt"             timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"             timestamptz  NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_groups_account_external" ON "groups" ("channelAccountId", "externalId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_groups_account_active" ON "groups" ("channelAccountId", "isActive")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_groups_monitoring" ON "groups" ("monitoringState")`);
    // Trigram index on the name: the group list must stay searchable across thousands of rows,
    // and ILIKE '%term%' cannot use a btree index (PROJECT_SPEC.md §115).
    await queryRunner.query(
      `CREATE INDEX "IDX_groups_name_trgm" ON "groups" USING gin ("name" gin_trgm_ops)`,
    );

    await queryRunner.query(`
      CREATE TABLE "group_participants" (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "groupId"              uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
        "externalId"           varchar(190) NOT NULL,
        "phone"                varchar(32),
        "displayName"          varchar(190),
        "role"                 varchar(16) NOT NULL DEFAULT 'MEMBER',
        "participantType"      varchar(16) NOT NULL DEFAULT 'UNKNOWN',
        "teamMemberIdentityId" uuid REFERENCES "team_member_identities"("id") ON DELETE SET NULL,
        "isActive"             boolean     NOT NULL DEFAULT true,
        "lastSeenInSyncAt"     timestamptz,
        "createdAt"            timestamptz NOT NULL DEFAULT now(),
        "updatedAt"            timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_group_participants_group_external" ON "group_participants" ("groupId", "externalId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_group_participants_group_active" ON "group_participants" ("groupId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_group_participants_phone" ON "group_participants" ("phone")`,
    );

    // --- provider events (the idempotency ledger) --------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "provider_events" (
        "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelAccountId"        uuid NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
        "providerIdempotencyKey"  varchar(190) NOT NULL,
        "providerDeliveryId"      varchar(128),
        "eventType"               varchar(64)  NOT NULL,
        "status"                  varchar(16)  NOT NULL DEFAULT 'RECEIVED',
        "rawPayload"              jsonb,
        "payloadRetainedUntil"    timestamptz,
        "messageId"               uuid,
        "error"                   text,
        "providerRetryCount"      integer      NOT NULL DEFAULT 0,
        "processedAt"             timestamptz,
        "createdAt"               timestamptz  NOT NULL DEFAULT now()
      )`);
    // THE duplicate-event guard. Scoped by account: provider keys are unique per session, not
    // globally, so two sessions could otherwise wrongly dedupe each other's events.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_provider_events_account_key"
        ON "provider_events" ("channelAccountId", "providerIdempotencyKey")`);
    await queryRunner.query(`CREATE INDEX "IDX_provider_events_type" ON "provider_events" ("eventType")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_provider_events_status_time" ON "provider_events" ("status", "createdAt")`,
    );
    // Drives the retention sweep; partial so it only covers rows that still hold a payload.
    await queryRunner.query(`
      CREATE INDEX "IDX_provider_events_retention"
        ON "provider_events" ("payloadRetainedUntil") WHERE "rawPayload" IS NOT NULL`);

    // --- outbound messages -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "outbound_messages" (
        "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelKey"              varchar(32)  NOT NULL REFERENCES "channels"("key") ON DELETE RESTRICT,
        "channelAccountId"        uuid         NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
        "externalConversationId"  varchar(190) NOT NULL,
        "conversationId"          uuid,
        "contentType"             varchar(24)  NOT NULL DEFAULT 'TEXT',
        "body"                    text,
        "quotedExternalId"        varchar(255),
        "attachments"             jsonb,
        "idempotencyKey"          varchar(190),
        "status"                  varchar(16)  NOT NULL DEFAULT 'QUEUED',
        "source"                  varchar(24)  NOT NULL DEFAULT 'MANUAL',
        "externalMessageId"       varchar(255),
        "messageId"               uuid,
        "attempts"                integer      NOT NULL DEFAULT 0,
        "scheduledAt"             timestamptz  NOT NULL DEFAULT now(),
        "lastAttemptAt"           timestamptz,
        "sentAt"                  timestamptz,
        "failureReason"           text,
        "createdById"             uuid,
        "createdAt"               timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"               timestamptz  NOT NULL DEFAULT now()
      )`);
    // Partial: most sends carry no key, and NULLs must not collide.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_outbound_idempotencyKey"
        ON "outbound_messages" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbound_status_scheduled" ON "outbound_messages" ("status", "scheduledAt")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_outbound_status" ON "outbound_messages" ("status")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbound_account_time" ON "outbound_messages" ("channelAccountId", "createdAt")`,
    );
    // Delivery receipts arrive keyed by the provider's message id, so this lookup is hot.
    await queryRunner.query(
      `CREATE INDEX "IDX_outbound_external_message" ON "outbound_messages" ("externalMessageId")`,
    );

    // --- messages ----------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "messages" (
        "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelKey"              varchar(32)  NOT NULL REFERENCES "channels"("key") ON DELETE RESTRICT,
        "channelAccountId"        uuid         NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
        "externalId"              varchar(255) NOT NULL,
        "externalConversationId"  varchar(190) NOT NULL,
        "externalGroupId"         varchar(190),
        "groupId"                 uuid REFERENCES "groups"("id") ON DELETE SET NULL,
        "conversationId"          uuid,
        "direction"               varchar(16)  NOT NULL,
        "senderExternalId"        varchar(190) NOT NULL,
        "senderPhone"             varchar(32),
        "senderDisplayName"       varchar(190),
        "contentType"             varchar(24)  NOT NULL,
        "body"                    text,
        "quotedExternalId"        varchar(255),
        "quotedMessageId"         uuid REFERENCES "messages"("id") ON DELETE SET NULL,
        "mentionedExternalIds"    jsonb,
        "classification"          varchar(24)  NOT NULL DEFAULT 'UNKNOWN',
        "fromAccount"             boolean      NOT NULL DEFAULT false,
        "sentAt"                  timestamptz  NOT NULL,
        "processingStatus"        varchar(16)  NOT NULL DEFAULT 'PENDING',
        "deliveryStatus"          varchar(16),
        "outboundMessageId"       uuid REFERENCES "outbound_messages"("id") ON DELETE SET NULL,
        "providerEventId"         uuid REFERENCES "provider_events"("id") ON DELETE SET NULL,
        "createdAt"               timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"               timestamptz  NOT NULL DEFAULT now()
      )`);

    // ============================================================================
    // The idempotency guarantee. Everything else about duplicate handling is an
    // optimisation in front of this index (PROJECT_SPEC.md §59, Phase 2 brief §4).
    // ============================================================================
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_messages_account_external"
        ON "messages" ("channelAccountId", "externalId")`);

    await queryRunner.query(
      `CREATE INDEX "IDX_messages_conversation_time" ON "messages" ("externalConversationId", "sentAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_conversationId_time" ON "messages" ("conversationId", "sentAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_account_time" ON "messages" ("channelAccountId", "sentAt")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_messages_group" ON "messages" ("externalGroupId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_classification" ON "messages" ("classification")`,
    );
    // Full-text search over message bodies (PROJECT_SPEC.md §115: Postgres FTS, not Elasticsearch).
    // 'simple' rather than 'english': this deployment's traffic is Bangla and English mixed, and an
    // English stemmer would mangle one of them.
    await queryRunner.query(`
      CREATE INDEX "IDX_messages_body_fts"
        ON "messages" USING gin (to_tsvector('simple', coalesce("body", '')))`);

    await queryRunner.query(`
      CREATE TABLE "message_attachments" (
        "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "messageId"         uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
        "mimeType"          varchar(128) NOT NULL,
        "filename"          varchar(255),
        "sizeBytes"         bigint,
        "omittedByProvider" boolean     NOT NULL DEFAULT false,
        "storageRef"        varchar(512),
        "createdAt"         timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_message_attachments_message" ON "message_attachments" ("messageId")`,
    );

    // Deferred FK: messages.outboundMessageId and outbound_messages.messageId point at each other,
    // so one direction has to be added after both tables exist.
    await queryRunner.query(`
      ALTER TABLE "outbound_messages"
        ADD CONSTRAINT "FK_outbound_message" FOREIGN KEY ("messageId")
        REFERENCES "messages"("id") ON DELETE SET NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" DROP CONSTRAINT IF EXISTS "FK_outbound_message"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "message_attachments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "outbound_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "provider_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "group_participants"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "groups"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "team_member_identities"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_connection_events"`);

    // Translate back so the Phase 1 schema is genuinely restored, not approximately restored.
    await queryRunner.query(
      `UPDATE "channel_accounts" SET "status" = 'ACTION_REQUIRED' WHERE "status" = 'QR_REQUIRED'`,
    );
    await queryRunner.query(`
      UPDATE "channel_accounts" SET "status" = 'DISCONNECTED'
       WHERE "status" IN ('DISCONNECTING', 'UNKNOWN')`);
    await queryRunner.query(`
      ALTER TABLE "channel_accounts"
        DROP COLUMN "ownershipEnabled",
        DROP COLUMN "accountPhone",
        DROP COLUMN "webhookExternalId",
        DROP COLUMN "webhookSecretEncrypted"`);
  }
}
