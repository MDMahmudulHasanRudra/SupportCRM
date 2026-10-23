import type { MigrationInterface, QueryRunner } from 'typeorm';
export class InboxReading1788400003000 implements MigrationInterface {
  async up(q:QueryRunner):Promise<void> {
    await q.query(`CREATE TABLE conversation_user_state (
      "userId" uuid NOT NULL REFERENCES users(id), "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      "isArchived" boolean NOT NULL DEFAULT false, "markedUnread" boolean NOT NULL DEFAULT false,
      "updatedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("userId","conversationId")
    );
    CREATE TABLE message_user_reads (
      "userId" uuid NOT NULL REFERENCES users(id), "messageId" uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      "readAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("userId","messageId")
    );
    CREATE INDEX messages_inbox_inbound ON messages("conversationId","sentAt",id) WHERE direction='INBOUND' AND "contentType"<>'SYSTEM_EVENT';`);
  }
  async down(q:QueryRunner):Promise<void> { await q.query('DROP TABLE message_user_reads,conversation_user_state; DROP INDEX messages_inbox_inbound;'); }
}
