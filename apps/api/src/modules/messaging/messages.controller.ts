import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { Message } from './entities/message.entity';
import { OutboundSource } from './entities/outbound-message.entity';
import { DeliveryStatus, MessageClassification, MessageDirection } from './message-types';
import { MessageService } from './message.service';

export class SendMessageDto {
  @IsUUID() channelAccountId!: string;

  /** The channel's conversation identifier. Opaque to Support CRM. */
  @IsString() @MinLength(1) @MaxLength(190) externalConversationId!: string;

  @IsString() @MinLength(1) @MaxLength(16_000) body!: string;

  @IsOptional() @IsString() @MaxLength(255) quotedExternalId?: string;

  /**
   * Supply one to make a retried request safe. Strongly recommended for any caller that might
   * retry — without it, a network timeout on the client side can send a customer two messages.
   */
  @IsOptional() @IsString() @MaxLength(190) idempotencyKey?: string;
}

export class ListMessagesDto {
  @IsOptional() @IsUUID() channelAccountId?: string;
  @IsOptional() @IsString() @MaxLength(190) externalConversationId?: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsOptional() @IsEnum(MessageDirection) direction?: MessageDirection;
  @IsOptional() @IsEnum(MessageClassification) classification?: MessageClassification;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class ListOutboundDto {
  @IsOptional() @IsUUID() channelAccountId?: string;
  @IsOptional() @IsEnum(DeliveryStatus) status?: DeliveryStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * Message inspection and the human send path (brief §20).
 *
 * `POST /messages` is the *only* HTTP route in the application that can cause a WhatsApp message to
 * exist, and it does not send one — it creates an `outbound_messages` row and returns. The actual
 * send happens on the worker, after re-validation (brief §10, §12).
 */
@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    private readonly messageService: MessageService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('messages.read')
  @ApiOperation({ summary: 'Inspect persisted messages (paginated, searchable)' })
  async list(@Query() query: ListMessagesDto) {
    const limit = Math.min(query.limit ?? 50, 100);
    const offset = Math.max(query.offset ?? 0, 0);

    // `m.id` breaks ties: messages that share a `sentAt` (same-second arrivals, and every row of a
    // backfill) otherwise have no defined order, and Postgres is free to return them differently per
    // query — which makes LIMIT/OFFSET repeat one row on two pages and skip another.
    const qb = this.messages
      .createQueryBuilder('m')
      .orderBy('m.sentAt', 'DESC')
      .addOrderBy('m.id', 'DESC');
    if (query.channelAccountId) qb.andWhere('m.channelAccountId = :a', { a: query.channelAccountId });
    if (query.externalConversationId) {
      qb.andWhere('m.externalConversationId = :c', { c: query.externalConversationId });
    }
    if (query.groupId) qb.andWhere('m.groupId = :g', { g: query.groupId });
    if (query.direction) qb.andWhere('m.direction = :d', { d: query.direction });
    if (query.classification) qb.andWhere('m.classification = :cl', { cl: query.classification });
    if (query.search) {
      // Uses the GIN full-text index. `plainto_tsquery` rather than `to_tsquery` because the input
      // is untrusted and the latter would let a user inject query operators.
      qb.andWhere(
        `to_tsvector('simple', coalesce(m.body, '')) @@ plainto_tsquery('simple', :q)`,
        { q: query.search },
      );
    }

    const [items, total] = await qb.skip(offset).take(limit).getManyAndCount();
    return { items: items.map(serializeMessage), total, limit, offset };
  }

  @Get(':id')
  @RequirePermissions('messages.read')
  @ApiOperation({ summary: 'One message with its attachments' })
  async findOne(@Param('id') id: string) {
    const message = await this.messages.findOne({ where: { id }, relations: ['attachments'] });
    if (!message) throw new NotFoundException(`Message ${id} not found`);

    return {
      ...serializeMessage(message),
      body: message.body,
      attachments: (message.attachments ?? []).map((a) => ({
        id: a.id,
        mimeType: a.mimeType,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        omittedByProvider: a.omittedByProvider,
        // Always null in Phase 2 — media metadata is stored, media bytes are not.
        storageRef: a.storageRef,
      })),
    };
  }

  /**
   * Queues a message. Does not send it.
   *
   * Returns 201 with a QUEUED row and its id; the caller watches `deliveryStatus` or the
   * `whatsapp.message.delivery_updated` websocket event. Blocking this request on a gateway call
   * would tie up a request worker for the duration of a WhatsApp round trip (brief §10).
   */
  @Post()
  @RequirePermissions('messages.send')
  @ApiOperation({ summary: 'Queue an outgoing message (async — never sends inline)' })
  async send(
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const row = await this.messageService.send({
      channelAccountId: dto.channelAccountId,
      externalConversationId: dto.externalConversationId,
      body: dto.body,
      quotedExternalId: dto.quotedExternalId ?? null,
      idempotencyKey: dto.idempotencyKey ?? null,
      source: OutboundSource.MANUAL,
      createdById: user.id,
    });

    await this.audit.record(
      {
        action: 'messages.send',
        resource: 'outbound_message',
        resourceId: row.id,
        after: {
          channelAccountId: row.channelAccountId,
          externalConversationId: row.externalConversationId,
          source: row.source,
          bodyLength: row.body?.length ?? 0,
          // The body itself is NOT audited: audit rows are readable by more people than the inbox,
          // and customer conversation content belongs behind the message permission
          // (PROJECT_SPEC.md §110).
        },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serializeOutbound(row);
  }

  @Get('outbound/list')
  @RequirePermissions('messages.read')
  @ApiOperation({ summary: 'Outbound queue with delivery status and failure reasons' })
  async listOutbound(@Query() query: ListOutboundDto) {
    const result = await this.messageService.list(query);
    return { ...result, items: result.items.map(serializeOutbound) };
  }

  @Get('outbound/:id')
  @RequirePermissions('messages.read')
  @ApiOperation({ summary: 'Delivery status of one outbound message' })
  async outboundStatus(@Param('id') id: string) {
    return serializeOutbound(await this.messageService.findOne(id));
  }

  @Post('outbound/:id/cancel')
  @RequirePermissions('messages.send')
  @ApiOperation({ summary: 'Cancel a message that has not been dispatched yet' })
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const row = await this.messageService.cancel(id);
    await this.audit.record(
      { action: 'messages.cancel', resource: 'outbound_message', resourceId: id },
      this.audit.actorFromRequest(request, user),
    );
    return serializeOutbound(row);
  }
}

/** The list projection omits the body — it is returned only from the single-message route. */
function serializeMessage(message: Message) {
  return {
    id: message.id,
    channelKey: message.channelKey,
    channelAccountId: message.channelAccountId,
    externalId: message.externalId,
    externalConversationId: message.externalConversationId,
    externalGroupId: message.externalGroupId,
    groupId: message.groupId,
    direction: message.direction,
    senderExternalId: message.senderExternalId,
    senderPhone: message.senderPhone,
    senderDisplayName: message.senderDisplayName,
    contentType: message.contentType,
    bodyPreview: message.body ? message.body.slice(0, 160) : null,
    classification: message.classification,
    fromAccount: message.fromAccount,
    quotedExternalId: message.quotedExternalId,
    sentAt: message.sentAt,
    processingStatus: message.processingStatus,
    deliveryStatus: message.deliveryStatus,
  };
}

function serializeOutbound(row: {
  id: string;
  channelAccountId: string;
  externalConversationId: string;
  status: DeliveryStatus;
  source: string;
  externalMessageId: string | null;
  messageId: string | null;
  attempts: number;
  scheduledAt: Date;
  sentAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    channelAccountId: row.channelAccountId,
    externalConversationId: row.externalConversationId,
    status: row.status,
    source: row.source,
    externalMessageId: row.externalMessageId,
    messageId: row.messageId,
    attempts: row.attempts,
    scheduledAt: row.scheduledAt,
    sentAt: row.sentAt,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  };
}
