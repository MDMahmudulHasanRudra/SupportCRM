import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { Conversation } from '../crm/entities/conversation.entity';
import { RealtimeModule } from '../realtime/realtime.module';
import { EscalationController } from './escalation.controller';
import { EscalationService } from './escalation.service';
import { Escalation } from './entities/escalation.entity';
import { EscalationEvent } from './entities/escalation-event.entity';
import { AutomationProfile } from '../automation/entities/automation-profile.entity';
import { EscalationConfigController } from './escalation-config.controller';
import { EscalationNotifier } from './escalation-notifier.service';
import { MessagingModule } from '../messaging/messaging.module';
import { Group } from '../groups/entities/group.entity';

/**
 * Human escalation and takeover release (`PROJECT_SPEC.md` §20–§26).
 *
 * Separate from `decision/` because escalations outlive the decision that raised one: an operator
 * assigns, works and resolves them long after the message that caused it, and the queue is a
 * first-class thing they look at rather than a footnote on a decision.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Escalation, EscalationEvent, Conversation, Group, AutomationProfile]),
    RealtimeModule,
    AuditModule,
    // Circular: messaging's inbound path reaches the decision engine, which reaches escalation,
    // which sends its internal notice back through messaging's one outbound control point.
    forwardRef(() => MessagingModule),
  ],
  controllers: [EscalationController, EscalationConfigController],
  providers: [EscalationService, EscalationNotifier],
  exports: [EscalationService, EscalationNotifier, TypeOrmModule],
})
export class EscalationModule {}
