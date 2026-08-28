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
import { GroupOperationsService } from './group-operations.service';
import { GroupAiStatusService } from './group-ai-status.service';
import { GroupStatsService } from './group-stats.service';
import { AutomationProfile } from '../automation/entities/automation-profile.entity';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { SettingsModule } from '../settings/settings.module';
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
    // AutomationProfile and ChannelAccount are read-only here: the AI status endpoint reports the
    // profile and session that govern a group, and owns neither.
    TypeOrmModule.forFeature([Group, GroupParticipant, GroupOnboardingRule, AutomationProfile, ChannelAccount]),
    SettingsModule,
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
  providers: [GroupSyncService, GroupOperationsService, GroupAiStatusService, GroupStatsService, GroupOnboardingService, ...(isWorker ? [ParticipantSyncHandler] : [])],
  exports: [GroupSyncService, GroupOperationsService, GroupAiStatusService, GroupStatsService, GroupOnboardingService, TypeOrmModule],
})
export class GroupsModule {}
