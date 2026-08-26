import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { TeamMemberIdentity } from './entities/team-member-identity.entity';
import { SupportAnalyticsController } from './support-analytics.controller';
import { SupportAnalyticsService } from './support-analytics.service';
import { TeamController } from './team.controller';
import { TeamIdentityService } from './team-identity.service';

/** Team member ↔ channel identity mapping (Phase 2 brief §9). */
@Module({
  imports: [TypeOrmModule.forFeature([TeamMemberIdentity]), AuthModule],
  controllers: [TeamController, SupportAnalyticsController],
  providers: [TeamIdentityService, SupportAnalyticsService],
  exports: [TeamIdentityService, SupportAnalyticsService, TypeOrmModule],
})
export class TeamModule {}
