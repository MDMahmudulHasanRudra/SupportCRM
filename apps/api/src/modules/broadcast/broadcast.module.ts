import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { Conversation } from '../crm/entities/conversation.entity';
import { Group } from '../groups/entities/group.entity';
import { JobsModule } from '../jobs/jobs.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SettingsModule } from '../settings/settings.module';
import { BroadcastController } from './broadcast.controller';
import { BroadcastHandler } from './broadcast.handler';
import { BroadcastService } from './broadcast.service';
import { Broadcast } from './entities/broadcast.entity';
import { BroadcastRecipient } from './entities/broadcast-recipient.entity';

const isWorker = process.env.RUN_MODE === 'worker';

/**
 * Campaigns.
 *
 * Sends through the messaging module's outbound control point rather than a channel adapter, so a
 * broadcast is subject to every safeguard an ordinary message is.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Broadcast, BroadcastRecipient, Group, Conversation]),
    JobsModule,
    SettingsModule,
    AuditModule,
    forwardRef(() => MessagingModule),
  ],
  controllers: [BroadcastController],
  providers: [BroadcastService, ...(isWorker ? [BroadcastHandler] : [])],
  exports: [BroadcastService],
})
export class BroadcastModule {}
