import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In,Repository } from 'typeorm';
import { MetricsService } from '../../common/metrics/metrics.service';
import { ConversationResolverService } from '../crm/conversation-resolver.service';
import { MessageClassification as Classification } from './message-types';
import type { NormalizedInboundMessage } from '../channel/channel-adapter.interface';
import { ChannelAccount } from '../channel/entities/channel-account.entity';
import { ChannelKey } from '../channel/entities/channel.entity';
import { Group } from '../groups/entities/group.entity';
import { TeamMemberIdentity } from '../team/entities/team-member-identity.entity';
import { MessageAttachment } from './entities/message-attachment.entity';
import { Message } from './entities/message.entity';
import {
  MessageClassification,
  MessageContentType,
  MessageDirection,
  MessageProcessingStatus,
} from './message-types';

export interface PersistInboundResult {
  message: Message | null;
  duplicate: boolean;
}

/**
 * Turns a normalized inbound message into a persisted `messages` row.
 *
 * Runs on the worker, never in the webhook request. Everything it does — the group lookup, the team
 * identity lookup, the quoted-message resolution — is a database round trip, and doing that inside
 * the webhook handler would slow the acknowledgement enough for the gateway to retry, manufacturing
 * the very duplicates the design is built to avoid.
 */
@Injectable()
export class InboundMessageService {
  constructor(
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(MessageAttachment) private readonly attachments: Repository<MessageAttachment>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(TeamMemberIdentity) private readonly identities: Repository<TeamMemberIdentity>,
    private readonly conversationResolver: ConversationResolverService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Persists a message, or reports that it already existed.
   *
   * Insert-and-catch-23505 rather than select-then-insert: two workers can hold the same event
   * between the check and the insert, and only the unique index can arbitrate. A duplicate is a
   * normal outcome, not an error.
   */
  async persist(
    account: ChannelAccount,
    normalized: NormalizedInboundMessage,
    providerEventId: string | null,
    options:{historical?:boolean}={},
  ): Promise<PersistInboundResult> {
    if(normalized.externalIdAliases?.length){const existing=await this.messages.findOne({where:{channelAccountId:account.id,externalId:In(normalized.externalIdAliases.slice(0,8))}});if(existing)return {message:existing,duplicate:true};}
    const group = normalized.externalGroupId
      ? await this.groups.findOne({
          where: { channelAccountId: account.id, externalId: normalized.externalGroupId },
          select: { id: true },
        })
      : null;

    const classification = await this.classify(account, normalized);

    // Resolve the quoted message only if we already have it. A reply to something that predates
    // tracking is perfectly normal and must not fail the insert — the external id is kept either
    // way, so a later backfill can link it.
    const quoted = normalized.quotedExternalId
      ? await this.messages.findOne({
          where: { channelAccountId: account.id, externalId: In(normalized.quotedExternalIdAliases?.slice(0,8)??[normalized.quotedExternalId]) },
          select: { id: true },
        })
      : null;

    const contentType = toContentType(normalized.messageType);

    // Resolve the conversation and the sender's channel identity BEFORE the insert, so the message
    // row carries both from the moment it exists (brief §5). This runs inside the per-conversation
    // lock the inbound processor already holds.
    const resolved = await this.conversationResolver.resolveForInbound(account, normalized);

    let message: Message;
    try {
      message = await this.messages.save(
        this.messages.create({
          channelKey: account.channelKey as ChannelKey,
          channelAccountId: account.id,
          externalId: normalized.externalId,
        presentation:normalized.presentation??{},
          externalConversationId: normalized.externalConversationId,
          externalGroupId: normalized.externalGroupId,
          groupId: group?.id ?? null,
          direction: normalized.fromMe ? MessageDirection.OUTBOUND : MessageDirection.INBOUND,
          senderExternalId: normalized.senderExternalId,
          senderPhone: normalized.senderPhone,
          senderDisplayName: normalized.senderDisplayName,
          contentType,
          body: normalized.body,
          quotedExternalId: normalized.quotedExternalId,
          quotedMessageId: quoted?.id ?? null,
          mentionedExternalIds: normalized.mentionedExternalIds.length
            ? normalized.mentionedExternalIds
            : null,
          classification,
          fromAccount: normalized.fromMe,
          sentAt: normalized.sentAt,
          processingStatus: MessageProcessingStatus.PENDING,
          providerEventId,
          conversationId: resolved.conversation.id,
          senderIdentityId: resolved.senderIdentity.id,
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        this.metrics.increment('inbound.duplicate');
        return { message: null, duplicate: true };
      }
      throw error;
    }

    if (normalized.attachments.length > 0) {
      await this.attachments.save(
        normalized.attachments.map((attachment) =>
          this.attachments.create({
            messageId: message.id,
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            // bigint columns round-trip as strings in pg to avoid >2^53 precision loss.
            sizeBytes: attachment.sizeBytes === null ? null : String(attachment.sizeBytes),
            omittedByProvider: attachment.omitted,
          }),
        ),
      );
    }

    if (group) {
      // `lastMessageAt` drives inbox ordering in Phase 3. Best-effort: failing to bump a timestamp
      // must not undo a successfully persisted message.
      await this.groups
        .update(group.id, { lastMessageAt: normalized.sentAt })
        .catch(() => undefined);
    }

    // Conversation activity counters, and the RESOLVED→OPEN reopen rule. Only a customer message
    // reopens a resolved conversation: a team member's follow-up or the account's own echo should
    // not drag a closed issue back open.
    await this.conversationResolver.recordActivity(resolved.conversation, {
      at: normalized.sentAt,
      inbound: !normalized.fromMe,
      fromCustomer: !options.historical&&classification === Classification.CUSTOMER_MESSAGE,
    });

    if (resolved.created) this.conversationResolver.emitCreated(resolved.conversation);

    this.metrics.increment('inbound.persisted', { classification });
    return { message, duplicate: false };
  }

  /**
   * Decides what a message *is* in support terms (brief §6).
   *
   * The order is the meaning:
   *  1. A system/group event is not someone speaking.
   *  2. Anything the connected account sent is BOT_MESSAGE — including our own outbound echoes.
   *     This is the primary loop guard: without it the system could later answer itself.
   *  3. A sender matching an active team identity is TEAM_MESSAGE.
   *  4. In a monitored group, everyone else is a customer.
   *  5. Otherwise UNKNOWN.
   *
   * Step 4 is deliberately narrow. The brief (§8) forbids assuming a participant is a customer, so
   * CUSTOMER_MESSAGE is only asserted where there is a reason to: a group we are actively
   * monitoring for support. Everywhere else the answer is honestly UNKNOWN, and Phase 3's customer
   * matching resolves it with real customer records rather than a guess made here.
   */
  private async classify(
    account: ChannelAccount,
    normalized: NormalizedInboundMessage,
  ): Promise<MessageClassification> {
    if (normalized.messageType === 'system') return MessageClassification.SYSTEM_EVENT;
    if (normalized.fromMe) return MessageClassification.BOT_MESSAGE;

    const identity = await this.findTeamIdentity(
      account.channelKey as ChannelKey,
      normalized.senderExternalId,
      normalized.senderPhone,
    );
    if (identity) return MessageClassification.TEAM_MESSAGE;

    if (normalized.externalGroupId) {
      const group = await this.groups.findOne({
        where: { channelAccountId: account.id, externalId: normalized.externalGroupId },
        select: { id: true, monitoringState: true },
      });
      if (group?.monitoringState === 'MONITORED') return MessageClassification.CUSTOMER_MESSAGE;
    }

    return MessageClassification.UNKNOWN;
  }

  /**
   * Looks a sender up as a team member.
   *
   * Tries the exact provider id first, then the phone number. Both are needed: the JID is exact but
   * changes shape for privacy-id senders, while the phone survives that and is what an admin
   * actually types when registering a colleague.
   */
  async findTeamIdentity(
    channelKey: ChannelKey,
    externalId: string,
    phone: string | null,
  ): Promise<TeamMemberIdentity | null> {
    const byExternalId = await this.identities.findOne({
      where: { channelKey, externalId, isActive: true },
    });
    if (byExternalId) return byExternalId;

    if (!phone) return null;
    return this.identities.findOne({ where: { channelKey, phone, isActive: true } });
  }

  async markProcessed(messageId: string, status: MessageProcessingStatus): Promise<void> {
    await this.messages.update(messageId, { processingStatus: status });
  }
}

/** Bridges the adapter interface's message-type union onto our content-type enum. */
function toContentType(type: NormalizedInboundMessage['messageType']): MessageContentType {
  switch (type) {
    case 'text':
      return MessageContentType.TEXT;
    case 'image':
      return MessageContentType.IMAGE;
    case 'video':
      return MessageContentType.VIDEO;
    case 'audio':
      return MessageContentType.AUDIO;
    case 'document':
      return MessageContentType.DOCUMENT;
    case 'sticker':
      return MessageContentType.STICKER;
    case 'location':
      return MessageContentType.LOCATION;
    case 'contact':
      return MessageContentType.CONTACT;
    case 'reaction':
      return MessageContentType.REACTION;
    case 'system':
      return MessageContentType.SYSTEM_EVENT;
    default:
      return MessageContentType.UNSUPPORTED;
  }
}
