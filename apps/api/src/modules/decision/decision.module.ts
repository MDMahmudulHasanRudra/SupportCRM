import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { AutomationExecution } from '../automation/entities/automation-execution.entity';
import { AutomationProfile } from '../automation/entities/automation-profile.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { RuleEvaluator } from '../automation/rule-evaluator';
import { Conversation } from '../crm/entities/conversation.entity';
import { EscalationModule } from '../escalation/escalation.module';
import { Group } from '../groups/entities/group.entity';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { Message } from '../messaging/entities/message.entity';
import { MessagingModule } from '../messaging/messaging.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SettingsModule } from '../settings/settings.module';
import { DecisionContextBuilder } from './decision-context';
import { DecisionController } from './decision.controller';
import { DecisionEngine } from './decision-engine.service';
import { DecisionPolicy } from './decision-policy';
import { DecisionService } from './decision.service';
import { DryRunService } from './dry-run.service';
import { AiRun } from './entities/ai-run.entity';
import { DecisionLog } from './entities/decision-log.entity';

/**
 * The Message Decision Engine (`PROJECT_SPEC.md` §5, §157–§161).
 *
 * Note what the engine itself is given and what it is not: `DecisionEngine` receives the evaluator,
 * the policy, retrieval and the provider — and no `MessageService`, no channel adapter, no outbound
 * queue. It cannot send. `DecisionService` is the only thing here that can, and it only ever does so
 * from a decision.
 *
 * Channel agnostic: nothing in this module or in `automation/` imports a channel, an adapter or a
 * gateway type, and the ESLint boundary fails the build if that changes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DecisionLog,
      AiRun,
      AutomationRule,
      AutomationProfile,
      AutomationExecution,
      Conversation,
      Message,
      Group,
    ]),
    KnowledgeModule,
    AiModule,
    SettingsModule,
    RealtimeModule,
    AuditModule,
    EscalationModule,
    // Circular by nature: messaging's inbound processor calls the decision service, and the
    // decision service sends through messaging's outbound control point.
    forwardRef(() => MessagingModule),
  ],
  controllers: [DecisionController],
  providers: [
    DecisionEngine,
    DecisionService,
    DecisionContextBuilder,
    DecisionPolicy,
    DryRunService,
    RuleEvaluator,
  ],
  exports: [DecisionService, DecisionEngine, DryRunService, TypeOrmModule],
})
export class DecisionModule {}
