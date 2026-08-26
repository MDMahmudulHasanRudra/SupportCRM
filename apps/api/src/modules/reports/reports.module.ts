import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../crm/entities/conversation.entity';
import { DecisionLog } from '../decision/entities/decision-log.entity';
import { Escalation } from '../escalation/entities/escalation.entity';
import { Group } from '../groups/entities/group.entity';
import { Broadcast } from '../broadcast/entities/broadcast.entity';
import { Job } from '../jobs/entities/job.entity';
import { OutboundMessage } from '../messaging/entities/outbound-message.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { OperationsAnalyticsService } from './operations-analytics.service';

/**
 * Reporting (`PROJECT_SPEC.md` §100–§106).
 *
 * Read-only by construction: it registers repositories for the tables it counts and provides no
 * service that writes to any of them. A reporting layer that can change the thing it measures is
 * a reporting layer nobody can trust.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, OutboundMessage, DecisionLog, Escalation, Group, Job, Broadcast]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService, OperationsAnalyticsService],
  exports: [ReportsService, OperationsAnalyticsService],
})
export class ReportsModule {}
