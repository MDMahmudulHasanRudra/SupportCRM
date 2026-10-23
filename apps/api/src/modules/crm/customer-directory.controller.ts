import { Body, Controller, Get, Header, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { CUSTOMER_COLUMNS, csvLine } from './customer-csv';
import { ListCustomersDto } from './customer-fields.dto';
import { CustomerCsvDto, CustomerImportCommitDto, CustomerImportService } from './customer-import.service';
import { CustomerService } from './customer.service';

@ApiTags('customers')
@Controller('customers/directory')
export class CustomerDirectoryController {
  constructor(private readonly customers: CustomerService, private readonly imports: CustomerImportService, private readonly audit: AuditService) {}

  @Get('owners') @RequirePermissions('customers.manage')
  owners() { return this.customers.owners(); }

  @Get('template') @RequirePermissions('customers.read', 'customers.import', 'customers.manage')
  template(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="customer-import-template.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.send('\uFEFF'+csvLine([...CUSTOMER_COLUMNS])+csvLine(['','Example client','8801711223344','client@example.test','Example Ltd','BD','Support plan','','ACTIVE']));
  }

  @Post('import/preview') @RequirePermissions('customers.read', 'customers.import', 'customers.manage')
  @Header('Cache-Control','no-store')
  @ApiOperation({ summary: 'Validate a create-only CSV and issue an actor-bound 15-minute preview' })
  async preview(@Body() dto: CustomerCsvDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const result = await this.imports.preview(dto.csv,user.id);
    await this.audit.record({ action: 'customers.import_previewed', resource: 'customer_import', metadata: { records: result.rows.length, valid: result.valid } },this.audit.actorFromRequest(req,user));
    return result;
  }

  @Post('import/commit') @RequirePermissions('customers.read', 'customers.import', 'customers.manage')
  @Header('Cache-Control','no-store')
  @ApiOperation({ summary: 'Atomically commit an unchanged preview; safe to retry with the same token' })
  async commit(@Body() dto: CustomerImportCommitDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const result = await this.imports.commit(dto,user.id);
    await this.audit.record({ action: 'customers.import_committed', resource: 'customer_import', resourceId: result.importId, metadata: { createdCount: result.createdCount, replayed: result.replayed } },this.audit.actorFromRequest(req,user));
    return result;
  }

  @Get('export') @RequirePermissions('customers.read', 'customers.export')
  @ApiOperation({ summary: 'Stream all matching customers as formula-safe CSV with a consistent snapshot' })
  async export(@Query() query: ListCustomersDto, @Res() res: Response, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="customers.csv"');
    res.setHeader('Cache-Control','no-store');
    const write = async (text: string) => {
      if (res.destroyed) throw new Error('Export cancelled.');
      if (res.write(text)) return;
      await new Promise<void>((resolve,reject) => {
        const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); };
        const drained = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error('Export cancelled.')); };
        const failed = (e: Error) => { cleanup(); reject(e); };
        res.once('drain',drained); res.once('close',closed); res.once('error',failed);
      });
    };
    try {
      await write('\uFEFF'+csvLine([...CUSTOMER_COLUMNS]));
      const count = await this.customers.exportRows(query, async rows => {
        await write(rows.map(c => csvLine([c.code,c.displayName,c.primaryPhone,c.email,c.company,c.country,c.serviceName,c.accountOwner?.username,c.status])).join(''));
      });
      await this.audit.record({ action:'customers.exported',resource:'customer',metadata:{count} },this.audit.actorFromRequest(req,user));
      res.end();
    } catch {
      await this.audit.record({ action:'customers.exported',resource:'customer',success:false },this.audit.actorFromRequest(req,user));
      res.destroy();
    }
  }
}
