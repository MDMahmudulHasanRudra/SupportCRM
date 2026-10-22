import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ShiftLifecycle1788400001000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE workforce_shifts
      ADD COLUMN "cancelledAt" timestamptz,
      ADD COLUMN "cancelledById" uuid REFERENCES users(id),
      ADD COLUMN "cancellationReason" varchar(500);
      CREATE TABLE workforce_shift_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "shiftId" uuid NOT NULL REFERENCES workforce_shifts(id),
        action varchar(16) NOT NULL CHECK (action IN ('UPDATED','CANCELLED')),
        "before" jsonb NOT NULL, "after" jsonb NOT NULL,
        "actorId" uuid NOT NULL REFERENCES users(id),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX workforce_shift_events_shift ON workforce_shift_events("shiftId", "createdAt");`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE workforce_shift_events;
      ALTER TABLE workforce_shifts DROP COLUMN "cancellationReason", DROP COLUMN "cancelledById", DROP COLUMN "cancelledAt";`);
  }
}
