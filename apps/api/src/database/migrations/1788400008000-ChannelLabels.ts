import type {MigrationInterface,QueryRunner} from 'typeorm';
export class ChannelLabels1788400008000 implements MigrationInterface {
 async up(q:QueryRunner):Promise<void>{await q.query(`CREATE TABLE channel_labels("accountId" uuid NOT NULL REFERENCES channel_accounts(id),"externalId" varchar(64) NOT NULL,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,"updatedAt" timestamptz NOT NULL DEFAULT now(),PRIMARY KEY("accountId","externalId"));
 CREATE TABLE channel_label_associations("accountId" uuid NOT NULL,"labelId" varchar(64) NOT NULL,"externalConversationId" varchar(190) NOT NULL,applied boolean NOT NULL,"updatedAt" timestamptz NOT NULL,PRIMARY KEY("accountId","labelId","externalConversationId"),FOREIGN KEY("accountId","labelId") REFERENCES channel_labels("accountId","externalId") ON DELETE CASCADE);`);}
 async down(q:QueryRunner):Promise<void>{await q.query('DROP TABLE channel_label_associations; DROP TABLE channel_labels;');}
}
