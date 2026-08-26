import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AutomationProfile } from '../automation/entities/automation-profile.entity';
import { Group } from '../groups/entities/group.entity';
import { JobsModule } from '../jobs/jobs.module';
import { SettingsModule } from '../settings/settings.module';
import { BulkController } from './bulk.controller';
import { BulkGroupHandler } from './bulk-group.handler';
import { BulkOperationsService } from './bulk-operations.service';

const isWorker = process.env.RUN_MODE === 'worker';

/**
 * Bulk configuration across groups.
 *
 * The handler is registered in worker mode only: applying three thousand updates is exactly the
 * work an API replica should not be doing.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Group, AutomationProfile]), JobsModule, SettingsModule, AuditModule],
  controllers: [BulkController],
  providers: [BulkOperationsService, ...(isWorker ? [BulkGroupHandler] : [])],
  exports: [BulkOperationsService],
})
export class BulkModule {}
