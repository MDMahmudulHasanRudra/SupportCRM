import { BullModule } from '@nestjs/bullmq';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelModule } from '../channel/channel.module';
import { CrmModule } from '../crm/crm.module';
import { Conversation } from '../crm/entities/conversation.entity';
import { DecisionModule } from '../decision/decision.module';
import { GroupsModule } from '../groups/groups.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { QUEUES } from '../jobs/queues';
import { RealtimeModule } from '../realtime/realtime.module';
import { TeamModule } from '../team/team.module';
import { ChannelLabelService } from './channel-label.service';
import { MessagePresentationService } from './message-presentation.service';
import { DeliveryService } from './delivery.service';
import { InboundMessageService } from './inbound-message.service';
import { InboundProcessor } from './inbound.processor';
import { Message } from './entities/message.entity';
import { MessageAttachment } from './entities/message-attachment.entity';
import { MessageService } from './message.service';
import { MessagesController } from './messages.controller';
import { OutboundMessage } from './entities/outbound-message.entity';
import { OutboundProcessor } from './outbound.processor';

const isWorker = process.env.RUN_MODE === 'worker';

/**
 * The messaging layer: the normalized message log, the single outbound control point, and the two
 * queue consumers that do the work the webhook deliberately does not.
 *
 * Processors register only in worker mode — an API replica must never consume the send queue, or
 * "scale the API" would silently mean "send more messages in parallel".
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Conversation,Message, MessageAttachment, OutboundMessage]),
    BullModule.registerQueue({ name: QUEUES.MESSAGE_INCOMING }, { name: QUEUES.MESSAGE_OUTGOING }),
    RealtimeModule,
    // Circular by nature: the inbound processor hands a persisted message to the Decision Engine,
    // and the decision service sends its reply back through this module's outbound control point.
    forwardRef(() => DecisionModule),
    GroupsModule,
    TeamModule,
    // Inbound persistence resolves a conversation and a sender identity before it writes the
    // message row, so messaging depends on the CRM domain (never the reverse).
    forwardRef(() => CrmModule),
    forwardRef(() => ChannelModule),
    forwardRef(() => IngestionModule),
  ],
  controllers: [MessagesController],
  providers: [
    MessageService,
    InboundMessageService,
    DeliveryService,MessagePresentationService,ChannelLabelService,
    ...(isWorker ? [InboundProcessor, OutboundProcessor] : []),
  ],
  exports: [ChannelLabelService,MessagePresentationService,MessageService, InboundMessageService, DeliveryService, TypeOrmModule],
})
export class MessagingModule {}
