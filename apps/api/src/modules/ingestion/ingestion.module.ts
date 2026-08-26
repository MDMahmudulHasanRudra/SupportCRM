import { BullModule } from '@nestjs/bullmq';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelModule } from '../channel/channel.module';
import { QUEUES } from '../jobs/queues';
import { ProviderEvent } from './entities/provider-event.entity';
import { IngestionService } from './ingestion.service';
import { WebhookController } from './webhook.controller';

/**
 * Webhook ingress. Verifies, dedupes, persists, enqueues — and nothing else
 * (`PROJECT_SPEC.md` §6, Phase 2 brief §4).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ProviderEvent]),
    BullModule.registerQueue({ name: QUEUES.MESSAGE_INCOMING }),
    forwardRef(() => ChannelModule),
  ],
  controllers: [WebhookController],
  providers: [IngestionService],
  exports: [IngestionService, TypeOrmModule],
})
export class IngestionModule {}
