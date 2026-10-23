import type { MigrationInterface, QueryRunner } from 'typeorm';
export class WhatsAppTools1788400005000 implements MigrationInterface {
    async up(q: QueryRunner): Promise<void> {
        await q.query(`
  ALTER TABLE outbound_messages ADD COLUMN "channelCommand" jsonb,ADD COLUMN "scheduledFor" timestamptz;
  CREATE TABLE whatsapp_operations (
   id uuid PRIMARY KEY,"accountId" uuid NOT NULL REFERENCES channel_accounts(id),"userId" uuid NOT NULL REFERENCES users(id),
   "operationId" varchar(100) NOT NULL,"requestKey" uuid NOT NULL,fingerprint varchar(64) NOT NULL,"encryptedInput" text NOT NULL,
   status varchar(32) NOT NULL DEFAULT 'QUEUED',"jobId" uuid REFERENCES jobs(id),"outboundId" uuid REFERENCES outbound_messages(id),
   result jsonb,error text,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now(),
   UNIQUE("userId","accountId","requestKey")
  );
  CREATE INDEX whatsapp_operations_recent ON whatsapp_operations("accountId","createdAt" DESC);
  CREATE TABLE whatsapp_uploads (
   id uuid PRIMARY KEY,"accountId" uuid NOT NULL REFERENCES channel_accounts(id),"userId" uuid NOT NULL REFERENCES users(id),
   ref text NOT NULL,name varchar(255) NOT NULL,mime varchar(128) NOT NULL,size bigint NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now()
  );
 `);
    }
    async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE whatsapp_operations,whatsapp_uploads;ALTER TABLE outbound_messages DROP COLUMN "channelCommand",DROP COLUMN "scheduledFor";'); }
}
