import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingService } from './billing.service';
import { WorkforceService } from './workforce.service';
import { WorkspaceService } from './workspace.service';
import { WorkspaceController } from './workspace.controller';
import { UsersController } from './users.controller';
import { CryptoModule } from '../../common/crypto/crypto.module';

@Module({ imports: [AuditModule, CryptoModule], controllers: [WorkspaceController, UsersController], providers: [BillingService, WorkforceService, WorkspaceService] })
export class WorkspaceModule {}
