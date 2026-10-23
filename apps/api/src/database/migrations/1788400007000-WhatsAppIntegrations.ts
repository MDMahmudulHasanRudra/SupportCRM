import type { MigrationInterface, QueryRunner } from 'typeorm';
export class WhatsAppIntegrations1788400007000 implements MigrationInterface {
    async up(q: QueryRunner): Promise<void> {
        await q.query(`CREATE TABLE whatsapp_integrations("accountId" uuid PRIMARY KEY REFERENCES channel_accounts(id),"userId" uuid NOT NULL REFERENCES users(id),"encryptedConfig" text NOT NULL,"secretHash" varchar(64) NOT NULL,enabled boolean NOT NULL DEFAULT false,"syncSince" timestamptz NOT NULL DEFAULT now(),"includeMedia" boolean NOT NULL DEFAULT true,"includeGroups" boolean NOT NULL DEFAULT false,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now());
 CREATE TABLE whatsapp_chatwoot_bindings("accountId" uuid NOT NULL REFERENCES channel_accounts(id),chat varchar(190) NOT NULL,"conversationId" bigint NOT NULL,"contactId" bigint NOT NULL,PRIMARY KEY("accountId",chat));
 CREATE TABLE whatsapp_chatwoot_deliveries("accountId" uuid NOT NULL REFERENCES channel_accounts(id),"messageId" uuid NOT NULL REFERENCES messages(id),status varchar(16) NOT NULL DEFAULT 'RUNNING',"remoteId" bigint,error text,"createdAt" timestamptz NOT NULL DEFAULT now(),PRIMARY KEY("accountId","messageId"));`);
    }
    async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE whatsapp_chatwoot_deliveries; DROP TABLE whatsapp_chatwoot_bindings; DROP TABLE whatsapp_integrations;'); }
}
