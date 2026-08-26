import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from '../jobs/entities/job.entity';
import { AIProviderConfig } from '../ai/entities/ai-provider.entity';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { StorageService } from '../../common/storage/storage.service';
import { HealthController } from './health.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Job, ChannelAccount, AIProviderConfig])],
  controllers: [HealthController],
  // Its own StorageService instance rather than an import edge into the knowledge module. The
  // service is stateless apart from a resolved root path, and a health check must not depend on a
  // feature module to report on infrastructure.
  providers: [StorageService],
})
export class HealthModule {}
