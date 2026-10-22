import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only: existing conversations, accounts and customer identity remain authoritative. */
export class WorkspaceOperations1788400000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE billing_invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "customerId" uuid NOT NULL REFERENCES customers(id),
        number varchar(64) NOT NULL UNIQUE,
        description varchar(500) NOT NULL,
        currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        "amountMinor" bigint NOT NULL CHECK ("amountMinor" > 0 AND "amountMinor" <= 100000000000),
        "dueDate" date NOT NULL,
        "createdById" uuid NOT NULL REFERENCES users(id),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX billing_invoices_customer ON billing_invoices("customerId", "dueDate");
      CREATE TABLE billing_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceId" uuid NOT NULL REFERENCES billing_invoices(id),
        "amountMinor" bigint NOT NULL CHECK ("amountMinor" > 0),
        reference varchar(190) NOT NULL,
        "idempotencyKey" uuid NOT NULL UNIQUE,
        "createdById" uuid NOT NULL REFERENCES users(id),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "reversedAt" timestamptz,
        "reversedById" uuid REFERENCES users(id),
        "reversalReason" varchar(500)
      );
      CREATE INDEX billing_payments_invoice ON billing_payments("invoiceId");
      CREATE TABLE client_subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "customerId" uuid NOT NULL REFERENCES customers(id),
        name varchar(160) NOT NULL,
        status varchar(16) NOT NULL CHECK (status IN ('TRIAL','ACTIVE','PAUSED','CANCELLED')),
        "startsOn" date NOT NULL,
        "endsOn" date NOT NULL CHECK ("endsOn" >= "startsOn"),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE subscription_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "subscriptionId" uuid NOT NULL REFERENCES client_subscriptions(id),
        action varchar(24) NOT NULL,
        detail jsonb NOT NULL,
        "actorId" uuid NOT NULL REFERENCES users(id),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE workforce_memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "teamId" uuid NOT NULL REFERENCES support_teams(id),
        "userId" uuid NOT NULL REFERENCES users(id),
        "joinedAt" timestamptz NOT NULL DEFAULT now(), "leftAt" timestamptz
      );
      CREATE UNIQUE INDEX workforce_membership_current ON workforce_memberships("teamId", "userId") WHERE "leftAt" IS NULL;
      CREATE TABLE workforce_shifts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL REFERENCES users(id),
        "startsAt" timestamptz NOT NULL, "endsAt" timestamptz NOT NULL CHECK ("endsAt" > "startsAt"),
        label varchar(120) NOT NULL,
        "createdById" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX workforce_shifts_window ON workforce_shifts("userId", "startsAt", "endsAt");
      CREATE TABLE workforce_leave (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid NOT NULL REFERENCES users(id),
        "startsOn" date NOT NULL, "endsOn" date NOT NULL CHECK ("endsOn" >= "startsOn"),
        reason varchar(500) NOT NULL, status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
        "reviewedById" uuid REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE workspace_notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid NOT NULL REFERENCES users(id),
        title varchar(190) NOT NULL, body varchar(1000) NOT NULL, href varchar(300),
        "readAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX workspace_notifications_user ON workspace_notifications("userId", "createdAt");
      CREATE TABLE saved_replies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid NOT NULL REFERENCES users(id),
        title varchar(120) NOT NULL, body text NOT NULL CHECK (length(body) <= 8000),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE conversation_drafts (
        "userId" uuid NOT NULL REFERENCES users(id), "destinationKey" varchar(400) NOT NULL,
        body text NOT NULL CHECK (length(body) <= 8000), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("userId", "destinationKey")
      );
      CREATE TABLE workspace_releases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version varchar(40) NOT NULL UNIQUE,
        title varchar(190) NOT NULL, body text NOT NULL CHECK (length(body) <= 20000),
        status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
        "createdById" uuid NOT NULL REFERENCES users(id), "publishedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE workspace_release_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "releaseId" uuid NOT NULL REFERENCES workspace_releases(id),
        snapshot jsonb NOT NULL, "actorId" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE workspace_release_versions, workspace_releases, conversation_drafts,
      saved_replies, workspace_notifications, workforce_leave, workforce_shifts, workforce_memberships,
      subscription_events, client_subscriptions, billing_payments, billing_invoices`);
  }
}
