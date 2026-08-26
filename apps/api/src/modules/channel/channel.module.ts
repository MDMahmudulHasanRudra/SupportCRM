import { BullModule } from '@nestjs/bullmq';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BroadcastModule } from '../broadcast/broadcast.module';
import { GroupsModule } from '../groups/groups.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { JobsModule } from '../jobs/jobs.module';
import { QUEUES } from '../jobs/queues';
import { MessagingModule } from '../messaging/messaging.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChannelAccountService } from './channel-account.service';
import { ChannelController } from './channel.controller';
import { ChannelMaintenanceProcessor } from './channel-maintenance.processor';
import { ChannelRecoveryService } from './channel-recovery.service';
import { ChannelRegistryService } from './channel-registry.service';
import { ChannelAccount } from './entities/channel-account.entity';
import { ChannelConnectionEvent } from './entities/channel-connection-event.entity';
import { Channel } from './entities/channel.entity';
import { OpenWaClient } from './whatsapp/openwa.client';
import { WhatsAppAutomationGuard } from './whatsapp/whatsapp-automation.guard';
import { WhatsAppChannelAdapter } from './whatsapp/whatsapp.adapter';
import { WhatsAppController } from './whatsapp/whatsapp.controller';

const isWorker = process.env.RUN_MODE === 'worker';

/**
 * The channel layer.
 *
 * `whatsapp/` is the only directory in the application permitted to import a gateway client, and
 * the ESLint boundary rule enforces it (`docs/adr/0001` §7). Everything outside this module that
 * needs a channel resolves an adapter from `ChannelRegistryService` and speaks the neutral
 * interface.
 *
 * The maintenance processor is registered only in worker mode — an API replica must not run a
 * repeatable sweep.
 */
@Module({
  imports: [
    forwardRef(() => BroadcastModule),
    TypeOrmModule.forFeature([Channel, ChannelAccount, ChannelConnectionEvent]),
    BullModule.registerQueue({ name: QUEUES.CHANNEL_MAINTENANCE }),
    RealtimeModule,
    JobsModule,
    // The WhatsApp Accounts overview counts groups per account in one query.
    GroupsModule,
    // Circular by nature: ingestion needs the adapter to verify a webhook, and the channel
    // controller needs ingestion to build the callback URL it registers with the gateway.
    forwardRef(() => IngestionModule),
    forwardRef(() => MessagingModule),
  ],
  controllers: [ChannelController, WhatsAppController],
  providers: [
    ChannelRegistryService,
    ChannelAccountService,
    ChannelRecoveryService,
    OpenWaClient,
    WhatsAppChannelAdapter,
    WhatsAppAutomationGuard,
    ...(isWorker ? [ChannelMaintenanceProcessor] : []),
  ],
  exports: [
    ChannelRegistryService,
    ChannelAccountService,
    ChannelRecoveryService,
    WhatsAppChannelAdapter,
    WhatsAppAutomationGuard,
    TypeOrmModule,
  ],
})
export class ChannelModule {}
