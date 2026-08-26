import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundMessage } from '../messaging/entities/outbound-message.entity';
import { Setting } from './entities/setting.entity';
import { KillSwitchController } from './kill-switch.controller';
import { KillSwitchService } from './kill-switch.service';
import { RateLimitPolicy } from './entities/rate-limit-policy.entity';
import { RateLimitController } from './rate-limit.controller';
import { RateLimitPolicyService } from './rate-limit-policy.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/** Global: feature flags and emergency stops are read from many places, including the worker. */
@Global()
@Module({
  // `OutboundMessage` is registered read/write here for one reason: the emergency stop cancels
  // what is already queued, and §37 is explicit that pending messages are cancelled rather than
  // drained. Nothing else in this module touches messaging.
  imports: [TypeOrmModule.forFeature([Setting, OutboundMessage, RateLimitPolicy]), AuditModule],
  controllers: [SettingsController, KillSwitchController, RateLimitController],
  providers: [SettingsService, KillSwitchService, RateLimitPolicyService],
  exports: [SettingsService, KillSwitchService, RateLimitPolicyService],
})
export class SettingsModule {}
