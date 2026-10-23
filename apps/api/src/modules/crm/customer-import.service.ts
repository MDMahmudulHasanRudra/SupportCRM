import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsString, MaxLength, validateSync } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { CryptoService } from '../../common/crypto/crypto.service';
import { CreateCustomerDto } from './customer-fields.dto';
import { parseCustomerCsv } from './customer-csv';
import { CustomerService } from './customer.service';
import { Customer, CustomerSource, CustomerStatus } from './entities/customer.entity';

export class CustomerCsvDto { @IsString() @MaxLength(524288) csv!: string; }
export class CustomerImportCommitDto extends CustomerCsvDto {
  @IsString() @MaxLength(2048) previewToken!: string;
  @IsBoolean() acknowledgeSharedContacts!: boolean;
}
interface PreviewClaim { id: string; userId: string; csvHash: string; reviewHash: string; expiresAt: number }
interface PreviewRow { record: number; values: Record<string,string>; data: CreateCustomerDto; errors: string[]; warnings: string[] }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

@Injectable()
export class CustomerImportService {
  constructor(private readonly db: DataSource, private readonly crypto: CryptoService) {}

  private async inspect(csv: string, manager: EntityManager) {
    const input = parseCustomerCsv(csv);
    const usernames = [...new Set(input.map(r => r.ownerUsername).filter(Boolean))];
    const owners = await manager.query<Array<{ id: string; username: string }>>('SELECT id,username FROM users WHERE "isActive"=true AND username=ANY($1::text[])', [usernames]);
    const ownerMap = new Map(owners.map(o => [o.username,o.id]));
    const rows: PreviewRow[] = input.map((r,index) => {
      const data = plainToInstance(CreateCustomerDto, {
        displayName: r.name || '', code: r.code || undefined, primaryPhone: r.phone || null,
        email: r.email?.toLowerCase() || null, company: r.company || null, country: r.country?.toUpperCase() || null,
        serviceName: r.service || null, accountOwnerId: r.ownerUsername ? ownerMap.get(r.ownerUsername) : null,
        status: r.status || CustomerStatus.ACTIVE,
      });
      const errors = validateSync(data).flatMap(e => Object.values(e.constraints || {}));
      if (r.ownerUsername && !data.accountOwnerId) errors.push('ownerUsername must match an active dashboard username.');
      if (data.code && /^CL-\d+$/.test(data.code)) errors.push('CL-number codes are automatic; leave code empty or use your own prefix.');
      const phone = CustomerService.normalizePhone(data.primaryPhone);
      if (data.primaryPhone && !phone) errors.push('phone must contain 7 to 15 digits.');
      data.primaryPhone = phone;
      return { record: index+2, values: r, data, errors, warnings: [] };
    });
    const existing = await manager.query<Array<{ kind: string; value: string; count: number }>>(`WITH matches AS (
      SELECT 'code' AS kind,code AS value FROM customers WHERE code=ANY($1::text[])
      UNION ALL SELECT 'phone',"primaryPhone" FROM customers WHERE "primaryPhone"=ANY($2::text[])
      UNION ALL SELECT 'email',lower(email) FROM customers WHERE lower(email)=ANY($3::text[]))
      SELECT kind,value,COUNT(*)::int AS count FROM matches GROUP BY kind,value ORDER BY kind,value`,
    [rows.map(r => r.data.code).filter(Boolean), rows.map(r => r.data.primaryPhone).filter(Boolean), rows.map(r => r.data.email).filter(Boolean)]);
    const codes = new Set<string>(); const phones = new Set<string>(); const emails = new Set<string>();
    for (const row of rows) {
      const { code, primaryPhone: phone, email } = row.data;
      if (code && (codes.has(code) || existing.some(e => e.kind === 'code' && e.value === code))) row.errors.push('Client code already exists in the directory or this file.');
      if (phone && (phones.has(phone) || existing.some(e => e.kind === 'phone' && e.value === phone))) row.warnings.push('Phone is shared with another record. A separate customer will be created.');
      if (email && (emails.has(email) || existing.some(e => e.kind === 'email' && e.value === email))) row.warnings.push('Email is shared with another record. A separate customer will be created.');
      if (code) codes.add(code); if (phone) phones.add(phone); if (email) emails.add(email);
    }
    return { rows, reviewHash: digest(JSON.stringify({ rows, existing })) };
  }

  async preview(csv: string, userId: string) {
    const { rows, reviewHash } = await this.inspect(csv, this.db.manager);
    const expiresAt = Date.now() + 15 * 60_000;
    const valid = rows.every(r => !r.errors.length);
    const claim: PreviewClaim = { id: randomUUID(), userId, csvHash: digest(csv), reviewHash, expiresAt };
    return { rows: rows.map(({ data: _data, ...row }) => row), valid, warningCount: rows.filter(r => r.warnings.length).length,
      expiresAt: new Date(expiresAt).toISOString(), previewToken: valid ? this.crypto.encryptSecret(JSON.stringify(claim), `customer-import:${userId}`) : null };
  }

  async commit(dto: CustomerImportCommitDto, userId: string) {
    let claim: PreviewClaim;
    try {
      const parts = dto.previewToken.split(':');
      if (parts.length !== 4 || parts.slice(1).some(p => Buffer.from(p,'base64').toString('base64') !== p)) throw new Error('Noncanonical preview.');
      claim = JSON.parse(this.crypto.decryptSecret(dto.previewToken, `customer-import:${userId}`)) as PreviewClaim;
    }
    catch { throw new BadRequestException('Invalid import preview. Preview the file again.'); }
    if (claim.userId !== userId || claim.csvHash !== digest(dto.csv)) throw new BadRequestException('The file or operator changed. Preview again.');
    return this.db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('customer-import:' || $1))", [claim.id]);
      const [receipt] = await tx.query<Array<{ customerIds: string[] }>>('SELECT "customerIds" FROM customer_import_receipts WHERE id=$1 AND "userId"=$2', [claim.id,userId]);
      if (receipt) return { importId: claim.id, customerIds: receipt.customerIds, createdCount: receipt.customerIds.length, replayed: true };
      if (claim.expiresAt < Date.now()) throw new ConflictException('This preview expired. Preview again before importing.');
      // Active owner rows cannot be deactivated halfway through this import.
      const ownerNames = parseCustomerCsv(dto.csv).map(r => r.ownerUsername).filter(Boolean);
      await tx.query('SELECT id FROM users WHERE "isActive"=true AND username=ANY($1::text[]) ORDER BY id FOR SHARE', [ownerNames]);
      // Serialize imports; manual writes are covered by revalidation + unique code constraints.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('customer-import-directory'))");
      const { rows, reviewHash } = await this.inspect(dto.csv, tx);
      if (reviewHash !== claim.reviewHash || rows.some(r => r.errors.length)) throw new ConflictException('Directory validation changed. Preview again. Nothing was imported.');
      if (rows.some(r => r.warnings.length) && !dto.acknowledgeSharedContacts) throw new BadRequestException('Acknowledge the shared-contact warnings before importing.');
      try {
        const repo = tx.getRepository(Customer);
        const created = await repo.save(rows.map(r => repo.create({ ...r.data, code: r.data.code || undefined, source: CustomerSource.IMPORT, createdById: userId })));
        const customerIds = created.map(c => c.id);
        await tx.query('INSERT INTO customer_import_receipts (id,"userId",fingerprint,"customerIds") VALUES ($1,$2,$3,$4)', [claim.id,userId,claim.csvHash,JSON.stringify(customerIds)]);
        return { importId: claim.id, customerIds, createdCount: customerIds.length, replayed: false };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ConflictException('A client code was claimed by another request. Preview again. Nothing was imported.');
        throw error;
      }
    });
  }
}
