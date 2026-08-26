import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelModule } from '../channel/channel.module';
import { JobsModule } from '../jobs/jobs.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TeamModule } from '../team/team.module';
import { GroupParticipant } from './entities/group-participant.entity';
import { Group } from './entities/group.entity';
import { GroupOnboardingRule } from './entities/group-onboarding-rule.entity';
import { AuditModule } from '../audit/audit.module';
import { GroupOnboardingController } from './group-onboarding.controller';
import { GroupOnboardingService } from './group-onboarding.service';
import { GroupSyncService } from './group-sync.service';
import { GroupsController } from './groups.controller';
import { ParticipantSyncHandler } from './participant-sync.handler';

const isWorker = process.env.RUN_MODE === 'worker';

/**
 * Groups and their participants.
 *
 * The Job Center handler is registered only in worker mode: it is invoked by the queue consumer,
 * which only exists there.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Group, GroupParticipant, GroupOnboardingRule]),
    JobsModule,
    RealtimeModule,
    TeamModule,
    AuditModule,
    forwardRef(() => ChannelModule),
  ],
  // Order matters: GroupsController owns `GET groups/:id`, which happily matches the literal
  // "onboarding-rules" and then fails as an invalid UUID. Nest resolves routes in registration
  // order, so the specific controller is registered first.
  controllers: [GroupOnboardingController, GroupsController],
  providers: [GroupSyncService, GroupOnboardingService, ...(isWorker ? [ParticipantSyncHandler] : [])],
  exports: [GroupSyncService, GroupOnboardingService, TypeOrmModule],
})
export class GroupsModule {}
