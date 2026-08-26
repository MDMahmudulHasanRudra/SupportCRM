import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RealtimeModule } from '../realtime/realtime.module';
import { Job } from './entities/job.entity';
import { JobItem } from './entities/job-item.entity';
import { JobProcessor } from './job.processor';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { QUEUES } from './queues';

/**
 * `RUN_MODE=worker` starts the queue consumer; the API process registers the queue as a producer
 * only. Running the processor in both would double every job's throughput accounting and let an API
 * container silently become a worker — the split is what makes "scale the workers" a real operation.
 */
const isWorker = process.env.RUN_MODE === 'worker';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job, JobItem]),
    BullModule.registerQueue({ name: QUEUES.JOB_CENTER }),
    RealtimeModule,
  ],
  controllers: [JobsController],
  providers: isWorker ? [JobsService, JobProcessor] : [JobsService],
  // JobProcessor is exported in worker mode so a domain module can register its own item handler
  // (see GroupsModule's ParticipantSyncHandler). The Job Center stays generic — it knows how to
  // walk items, not what an item means.
  exports: isWorker ? [JobsService, JobProcessor] : [JobsService],
})
export class JobsModule {}
