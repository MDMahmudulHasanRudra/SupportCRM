import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerDirectory1788400002000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE SEQUENCE customer_code_seq;
      ALTER TABLE customers
        ADD COLUMN code varchar(40) NOT NULL DEFAULT ('CL-' || nextval('customer_code_seq')::text),
        ADD COLUMN country varchar(2),
        ADD COLUMN "serviceName" varchar(160),
        ADD COLUMN "accountOwnerId" uuid REFERENCES users(id) ON DELETE SET NULL;
      ALTER SEQUENCE customer_code_seq OWNED BY customers.code;
      CREATE UNIQUE INDEX customers_code_unique ON customers(code);
      CREATE INDEX customers_owner ON customers("accountOwnerId");
      CREATE INDEX customers_email_lower ON customers(lower(email));
      CREATE TABLE customer_import_receipts (
        id uuid PRIMARY KEY, "userId" uuid NOT NULL REFERENCES users(id),
        fingerprint varchar(64) NOT NULL, "customerIds" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE customer_import_receipts;
      DROP INDEX customers_email_lower;
      ALTER TABLE customers DROP COLUMN "accountOwnerId", DROP COLUMN "serviceName", DROP COLUMN country, DROP COLUMN code;`);
  }
}
