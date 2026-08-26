import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AutomationCandidate } from '../automation/entities/automation-candidate.entity';
import { Escalation } from '../escalation/entities/escalation.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { Group } from '../groups/entities/group.entity';
import { Message } from '../messaging/entities/message.entity';
import { AiModule } from '../ai/ai.module';
import { ReportsModule } from '../reports/reports.module';
import { CandidatesController } from './candidates.controller';
import { CopilotController } from './copilot.controller';
import { CandidateDetectorService } from './candidate-detector.service';
import { CopilotService } from './copilot.service';
import { CopilotAction } from './entities/copilot-action.entity';

/**
 * The admin Copilot and the learning loop (`PROJECT_SPEC.md` §85–§91).
 *
 * Note what it does not import: nothing from `messaging`, `channel` or the decision engine. The
 * Copilot cannot send a message and cannot make a decision — it reads, and it proposes. Everything
 * it proposes lands in a queue a person works through.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CopilotAction, AutomationCandidate, AutomationRule, Group, Escalation, Message]),
    ReportsModule,
    AiModule,
    AuditModule,
  ],
  controllers: [CopilotController, CandidatesController],
  providers: [CopilotService, CandidateDetectorService],
  exports: [CopilotService, CandidateDetectorService],
})
export class CopilotModule {}
