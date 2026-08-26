import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AIProviderService } from '../../common/ai/ai-provider';
import { AuditModule } from '../audit/audit.module';
import { Message } from '../messaging/entities/message.entity';
import { AIConfigService } from './ai-config.service';
import { AIController } from './ai.controller';
import { AIFeedbackService } from './ai-feedback.service';
import { AIGatewayService } from './ai-gateway.service';
import { AIMemoryService } from './ai-memory.service';
import { AIRegistryService } from './ai-registry.service';
import { AIConfiguration } from './entities/ai-configuration.entity';
import { AIConversation } from './entities/ai-conversation.entity';
import { AICustomerFact } from './entities/ai-customer-fact.entity';
import { AIFeedback } from './entities/ai-feedback.entity';
import { AIMessage } from './entities/ai-message.entity';
import { AIProviderConfig } from './entities/ai-provider.entity';

/**
 * The AI layer (`PROJECT_SPEC.md` §16–§27).
 *
 * Deliberately has no dependency on the channel or gateway modules — it is asked a question and
 * returns a verdict, and could not send a WhatsApp message if it decided to. That boundary is
 * enforced by ESLint as well as by this import list.
 *
 * `Message` is registered here read-only, for memory assembly. The AI reads the conversation; it
 * never writes to it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AIProviderConfig,
      AIConfiguration,
      AIConversation,
      AIMessage,
      AIFeedback,
      AICustomerFact,
      Message,
    ]),
    AuditModule,
  ],
  controllers: [AIController],
  providers: [
    AIRegistryService,
    AIConfigService,
    AIMemoryService,
    AIFeedbackService,
    AIGatewayService,
    // The environment-configured provider stays available as the fallback path and as what the
    // test profile drives.
    AIProviderService,
  ],
  exports: [
    AIRegistryService,
    AIConfigService,
    AIMemoryService,
    AIFeedbackService,
    AIGatewayService,
    AIProviderService,
    TypeOrmModule,
  ],
})
export class AiModule {}
