import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SecuritySettings } from './entities/security-settings.entity';
import { UserSession } from './entities/user-session.entity';
import { User } from './entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserSession, SecuritySettings]), AuditModule],
  controllers: [AuthController],
  providers: [AuthService],
  // Exported because SessionGuard (global) and RealtimeGateway both resolve sessions.
  exports: [AuthService, TypeOrmModule],
})
export class AuthModule {}
