import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { TeamMemberIdentity } from './entities/team-member-identity.entity';
import { TeamController } from './team.controller';
import { TeamIdentityService } from './team-identity.service';

/** Team member ↔ channel identity mapping (Phase 2 brief §9). */
@Module({
  imports: [TypeOrmModule.forFeature([TeamMemberIdentity]), AuthModule],
  controllers: [TeamController],
  providers: [TeamIdentityService],
  exports: [TeamIdentityService, TypeOrmModule],
})
export class TeamModule {}
