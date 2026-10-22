import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { InvoiceDto, PaymentDto, SubscriptionActionDto, SubscriptionDto } from './workspace.dto';

export interface Invoice { id: string; customerId: string; amountMinor: string; currency: string; }
export interface Payment { id: string; invoiceId: string; amountMinor: string; reference: string; reversedAt: Date | null; }
export interface Subscription { id: string; status: string; startsOn: string; endsOn: string; }

@Injectable()
export class BillingService {
  constructor(private readonly db: DataSource) {}

  async overview() {
    const invoices = await this.db.query(`SELECT i.*, c."displayName" AS "customerName",
      COALESCE(p.paid, 0)::text AS "paidMinor", (i."amountMinor" - COALESCE(p.paid, 0))::text AS "balanceMinor",
      CASE WHEN COALESCE(p.paid, 0) >= i."amountMinor" THEN 'PAID'
        WHEN i."dueDate" < CURRENT_DATE THEN 'OVERDUE' WHEN COALESCE(p.paid, 0) > 0 THEN 'PARTIAL' ELSE 'UNPAID' END AS status
      FROM billing_invoices i JOIN customers c ON c.id = i."customerId"
      LEFT JOIN LATERAL (SELECT SUM("amountMinor") AS paid FROM billing_payments
        WHERE "invoiceId" = i.id AND "reversedAt" IS NULL) p ON true
      ORDER BY i."createdAt" DESC LIMIT 200`);
    const totals = await this.db.query(`SELECT i.currency, SUM(i."amountMinor")::text AS "invoicedMinor",
      SUM(COALESCE(p.paid, 0))::text AS "paidMinor", SUM(i."amountMinor" - COALESCE(p.paid, 0))::text AS "balanceMinor"
      FROM billing_invoices i LEFT JOIN LATERAL (SELECT SUM("amountMinor") AS paid FROM billing_payments
        WHERE "invoiceId" = i.id AND "reversedAt" IS NULL) p ON true GROUP BY i.currency ORDER BY i.currency`);
    const payments = await this.db.query(`SELECT p.*, i.number, i.currency, c."displayName" AS "customerName"
      FROM billing_payments p JOIN billing_invoices i ON i.id = p."invoiceId"
      JOIN customers c ON c.id = i."customerId" ORDER BY p."createdAt" DESC LIMIT 200`);
    const subscriptions = await this.db.query(`SELECT s.*, c."displayName" AS "customerName",
      CASE WHEN s.status IN ('ACTIVE','TRIAL') AND s."endsOn" < CURRENT_DATE THEN 'EXPIRED' ELSE s.status END AS "displayStatus"
      FROM client_subscriptions s JOIN customers c ON c.id = s."customerId" ORDER BY s."endsOn", s.id LIMIT 200`);
    return { invoices, totals, payments, subscriptions, limit: 200 };
  }

  async invoice(dto: InvoiceDto, userId: string) {
    const customers = await this.db.query<Array<{ id: string }>>('SELECT id FROM customers WHERE id=$1', [dto.customerId]);
    if (!customers.length) throw new NotFoundException('Customer not found.');
    const rows = await this.db.query<Invoice[]>(`INSERT INTO billing_invoices
      ("customerId", number, description, currency, "amountMinor", "dueDate", "createdById")
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [dto.customerId, `INV-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`, dto.description.trim(), dto.currency, dto.amountMinor, dto.dueDate, userId]);
    return rows[0];
  }

  async pay(dto: PaymentDto, userId: string) {
    return this.db.transaction(async (tx) => {
      // A key is global, even when concurrent requests name different invoices.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [dto.idempotencyKey]);
      const [invoice] = await tx.query<Invoice[]>('SELECT * FROM billing_invoices WHERE id=$1 FOR UPDATE', [dto.invoiceId]);
      if (!invoice) throw new NotFoundException('Invoice not found.');
      const [existing] = await tx.query<Payment[]>('SELECT * FROM billing_payments WHERE "idempotencyKey"=$1', [dto.idempotencyKey]);
      if (existing) {
        if (existing.invoiceId !== dto.invoiceId || Number(existing.amountMinor) !== dto.amountMinor || existing.reference !== dto.reference.trim()) {
          throw new ConflictException('This payment key was already used for different payment details.');
        }
        return existing;
      }
      const [sum] = await tx.query<Array<{ paid: string }>>(`SELECT COALESCE(SUM("amountMinor"),0)::text AS paid
        FROM billing_payments WHERE "invoiceId"=$1 AND "reversedAt" IS NULL`, [invoice.id]);
      if (BigInt(dto.amountMinor) > BigInt(invoice.amountMinor) - BigInt(sum.paid)) {
        throw new BadRequestException('Payment exceeds the outstanding invoice balance.');
      }
      const [payment] = await tx.query<Payment[]>(`INSERT INTO billing_payments
        ("invoiceId", "amountMinor", reference, "idempotencyKey", "createdById") VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [dto.invoiceId, dto.amountMinor, dto.reference.trim(), dto.idempotencyKey, userId]);
      return payment;
    });
  }

  async reverse(id: string, reason: string, userId: string) {
    return this.db.transaction(async (tx) => {
      const [payment] = await tx.query<Payment[]>('SELECT * FROM billing_payments WHERE id=$1', [id]);
      if (!payment) throw new NotFoundException('Payment not found.');
      await tx.query('SELECT id FROM billing_invoices WHERE id=$1 FOR UPDATE', [payment.invoiceId]);
      const rows = await tx.query<Payment[]>(`WITH updated AS (UPDATE billing_payments SET "reversedAt"=now(), "reversedById"=$2,
        "reversalReason"=$3 WHERE id=$1 AND "reversedAt" IS NULL RETURNING *) SELECT * FROM updated`, [id, userId, reason.trim()]);
      if (!rows.length) throw new ConflictException('This payment has already been reversed.');
      return rows[0];
    });
  }

  async subscribe(dto: SubscriptionDto, userId: string) {
    if (dto.endsOn < dto.startsOn) throw new BadRequestException('End date must be on or after the start date.');
    return this.db.transaction(async (tx) => {
      const [customer] = await tx.query<Array<{ id: string }>>('SELECT id FROM customers WHERE id=$1', [dto.customerId]);
      if (!customer) throw new NotFoundException('Customer not found.');
      const [sub] = await tx.query<Subscription[]>(`INSERT INTO client_subscriptions
        ("customerId", name, status, "startsOn", "endsOn") VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [dto.customerId, dto.name.trim(), dto.status, dto.startsOn, dto.endsOn]);
      await tx.query('INSERT INTO subscription_events ("subscriptionId", action, detail, "actorId") VALUES ($1,$2,$3,$4)',
        [sub.id, 'CREATE', JSON.stringify(dto), userId]);
      return sub;
    });
  }

  async subscriptionAction(id: string, dto: SubscriptionActionDto, userId: string) {
    return this.db.transaction(async (tx) => {
      const [sub] = await tx.query<Subscription[]>('SELECT *, "startsOn"::text AS "startsOn", "endsOn"::text AS "endsOn" FROM client_subscriptions WHERE id=$1 FOR UPDATE', [id]);
      if (!sub) throw new NotFoundException('Subscription not found.');
      if (sub.status === 'CANCELLED') throw new ConflictException('A cancelled subscription cannot be changed. Create a new term.');
      const next: Record<string, string> = { PAUSE: 'PAUSED', RESUME: 'ACTIVE', CANCEL: 'CANCELLED', RENEW: 'ACTIVE' };
      if (dto.action === 'PAUSE' && sub.status === 'PAUSED') throw new ConflictException('Already paused.');
      if (dto.action === 'RESUME' && sub.status !== 'PAUSED') throw new ConflictException('Only a paused subscription can be resumed.');
      if (dto.action === 'RENEW' && (!dto.endsOn || dto.endsOn <= sub.endsOn)) {
        throw new BadRequestException('Renewal needs an end date later than the current term.');
      }
      const [updated] = await tx.query<Subscription[]>(`WITH updated AS (UPDATE client_subscriptions SET status=$2,
        "endsOn"=$3, "updatedAt"=now() WHERE id=$1 RETURNING *) SELECT * FROM updated`, [id, next[dto.action], dto.action === 'RENEW' ? dto.endsOn : sub.endsOn]);
      await tx.query('INSERT INTO subscription_events ("subscriptionId", action, detail, "actorId") VALUES ($1,$2,$3,$4)',
        [id, dto.action, JSON.stringify({ before: sub, after: updated }), userId]);
      return updated;
    });
  }

  async history(id: string) {
    return { items: await this.db.query('SELECT * FROM subscription_events WHERE "subscriptionId"=$1 ORDER BY "createdAt" DESC LIMIT 200', [id]) };
  }
}
