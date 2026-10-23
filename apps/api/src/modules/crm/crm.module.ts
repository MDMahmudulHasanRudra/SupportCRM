import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelModule } from '../channel/channel.module';
import { GroupsModule } from '../groups/groups.module';
import { Message } from '../messaging/entities/message.entity';
import { RealtimeModule } from '../realtime/realtime.module';
import { TeamModule } from '../team/team.module';
import { ConversationResolverService } from './conversation-resolver.service';
import { ConversationService } from './conversation.service';
import { ConversationsController } from './conversations.controller';
import { CrmMaintenanceProcessor } from './crm-maintenance.processor';
import { CustomerService } from './customer.service';
import { CustomerDirectoryController } from './customer-directory.controller';
import { CustomerImportService } from './customer-import.service';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';
import { CustomersController } from './customers.controller';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import {
  ConversationAssignment,
  ConversationStateHistory,
} from './entities/conversation-history.entity';
import { CustomerIdentity } from './entities/customer-identity.entity';
import { Customer } from './entities/customer.entity';
import {
  CustomerNote,
  EntityTag,
  SupportTeam,
  Tag,
} from './entities/customer-metadata.entity';

const isWorker = process.env.RUN_MODE === 'worker';

/**
 * The CRM domain: customers, identities, conversations, state, assignment (Phase 3).
 *
 * Sits between the channel layer and the future Message Decision Engine. It consumes normalized
 * messages from Phase 2 and produces the durable domain Phase 5 will read — and it interprets
 * nothing (brief §6, §16).
 *
 * `Message` is registered here read/write because `ConversationService` reads message history and
 * the resolver stamps `conversationId`; MessagingModule remains the owner of the send path.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Customer,
      CustomerIdentity,
      CustomerNote,
      Tag,
      EntityTag,
      SupportTeam,
      Conversation,
      ConversationParticipant,
      ConversationStateHistory,
      ConversationAssignment,
      Message,
    ]),
    RealtimeModule,
    GroupsModule,
    TeamModule,
    forwardRef(() => ChannelModule),
  ],
  controllers: [CustomersController, CustomerDirectoryController, ConversationsController, InboxController],
  providers: [
    CustomerService,
    CustomerImportService,
    InboxService,
    ConversationService,
    ConversationResolverService,
    ...(isWorker ? [CrmMaintenanceProcessor] : []),
  ],
  exports: [CustomerService, ConversationService, ConversationResolverService, TypeOrmModule],
})
export class CrmModule {}
