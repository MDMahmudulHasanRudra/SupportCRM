import type { MigrationInterface, QueryRunner } from 'typeorm';
export class GoWhatsApp1788400004000 implements MigrationInterface {
    async up(q: QueryRunner): Promise<void> {
        await q.query(`ALTER TABLE channel_accounts ADD COLUMN "gatewayProvider" varchar(32) NOT NULL DEFAULT 'gowa';
      CREATE TABLE legacy_gateway_accounts ("accountId" uuid PRIMARY KEY, snapshot jsonb NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now());
      INSERT INTO legacy_gateway_accounts ("accountId",snapshot) SELECT id,to_jsonb(a) FROM channel_accounts a WHERE "channelKey"='whatsapp';
      UPDATE outbound_messages SET status='CANCELLED',"failureReason"='Gateway replaced. Review the saved request before creating a new send.',"updatedAt"=now() WHERE "channelKey"='whatsapp' AND status='QUEUED';
      UPDATE outbound_messages SET status='FAILED',"failureReason"='Legacy gateway outcome uncertain during transport replacement. Inspect phone history before retrying.',"updatedAt"=now() WHERE "channelKey"='whatsapp' AND status='SENDING';
      UPDATE channel_accounts SET "externalId"=NULL,"webhookExternalId"=NULL,"webhookSecretEncrypted"=NULL,
        status='DISCONNECTED',capabilities=NULL,"recoveryNextAttemptAt"=NULL,"recoveryExhaustedAt"=NULL,"recoveryAttempts"=0,
        "disconnectRequestedAt"=now(),"lastError"='WhatsApp transport replaced. Link this account with a new QR; CRM history is retained.',"updatedAt"=now()
        WHERE "channelKey"='whatsapp';
      UPDATE channels SET "adapterKey"='gowa' WHERE key='whatsapp';`);
    }
    async down(q: QueryRunner): Promise<void> {
        await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM channel_accounts WHERE "gatewayProvider"='gowa' AND "externalId" IS NOT NULL)
      THEN RAISE EXCEPTION 'Go WhatsApp devices exist. Preserve and unlink/reconcile them before reverting the transport migration.';END IF;END $$;
      UPDATE channel_accounts a SET "externalId"=b.snapshot->>'externalId',"webhookExternalId"=b.snapshot->>'webhookExternalId',
      "webhookSecretEncrypted"=b.snapshot->>'webhookSecretEncrypted',status=b.snapshot->>'status',capabilities=NULLIF(b.snapshot->'capabilities','null'::jsonb),
      "disconnectRequestedAt"=(b.snapshot->>'disconnectRequestedAt')::timestamptz,"lastError"=b.snapshot->>'lastError'
      FROM legacy_gateway_accounts b WHERE b."accountId"=a.id;
      UPDATE channels SET "adapterKey"='openwa' WHERE key='whatsapp';
      DROP TABLE legacy_gateway_accounts;ALTER TABLE channel_accounts DROP COLUMN "gatewayProvider";`);
    }
}
