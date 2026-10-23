import type { MigrationInterface, QueryRunner } from 'typeorm';
export class WhatsAppSchedules1788400006000 implements MigrationInterface {
    async up(q: QueryRunner): Promise<void> {
        await q.query(`CREATE TABLE whatsapp_schedules (
 id uuid PRIMARY KEY, "accountId" uuid NOT NULL REFERENCES channel_accounts(id), "userId" uuid NOT NULL REFERENCES users(id),
 "requestKey" uuid NOT NULL, fingerprint varchar(64) NOT NULL,"operationId" varchar(100) NOT NULL,"encryptedCommand" text NOT NULL,
 recurrence varchar(12) NOT NULL,timezone varchar(100) NOT NULL,weekdays jsonb,"dayOfMonth" int,"endAt" timestamptz,"occurrenceLimit" int,
 "nextRunAt" timestamptz NOT NULL,"runCount" int NOT NULL DEFAULT 0,status varchar(20) NOT NULL DEFAULT 'active',
 "lastActionId" uuid,"lastError" text,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE("userId","accountId","requestKey"));
 CREATE INDEX whatsapp_schedules_due ON whatsapp_schedules(status,"nextRunAt");
 ALTER TABLE whatsapp_operations ADD COLUMN "scheduleId" uuid REFERENCES whatsapp_schedules(id);
 ALTER TABLE outbound_messages ADD COLUMN "managedScheduleId" uuid REFERENCES whatsapp_schedules(id);
 ALTER TABLE messages ADD COLUMN "presentation" jsonb NOT NULL DEFAULT '{}'::jsonb;
 `);
    }
    async down(q: QueryRunner): Promise<void> { await q.query('ALTER TABLE outbound_messages DROP COLUMN "managedScheduleId"; ALTER TABLE messages DROP COLUMN "presentation"; ALTER TABLE whatsapp_operations DROP COLUMN "scheduleId"; DROP TABLE whatsapp_schedules;'); }
}
