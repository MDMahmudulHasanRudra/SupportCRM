import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { ChannelKey } from '../channel/entities/channel.entity';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';
import { CustomerService } from './customer.service';
import { IdentityMatchState } from './entities/customer-identity.entity';
import { CreateCustomerDto, ListCustomersDto, UpdateCustomerDto } from './customer-fields.dto';
export { CreateCustomerDto, ListCustomersDto, UpdateCustomerDto } from './customer-fields.dto';
import { TaggableEntity } from './entities/customer-metadata.entity';

export class CreateIdentityDto {
  @IsEnum(ChannelKey) channelKey!: ChannelKey;
  @IsString() @MinLength(7) @MaxLength(32) phone!: string;
  @IsOptional() @IsString() @MaxLength(190) displayName?: string;
  @IsOptional() @IsUUID() customerId?: string;
}

export class ResolveIdentityDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ListIdentitiesDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsEnum(IdentityMatchState) matchState?: IdentityMatchState;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class AddNoteDto {
  @IsString() @MinLength(1) @MaxLength(10_000) body!: string;
  @IsOptional() @IsBoolean() isPinned?: boolean;
}

export class TagDto {
  @IsString() @MinLength(1) @MaxLength(64) tagKey!: string;
}

/**
 * Customers, identities, notes and tags (Phase 3 brief §1, §2, §9, §13, §14).
 *
 * Every mutating route is audited, and the identity-resolution routes especially so: confirming an
 * identity attributes a customer's whole conversation history to a person, and rejecting one
 * detaches it. Both are decisions a human should be answerable for.
 */
@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomerService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: 'List customers (paginated, searchable by name, phone, email or company)' })
  async list(@Query() query: ListCustomersDto) {
    return this.customers.list(query);
  }

  @Get(':id')
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: 'One customer with its channel identities and tags' })
  async findOne(@Param('id') id: string) {
    const customer = await this.customers.findOne(id);
    const tags = await this.customers.listTagsFor(TaggableEntity.CUSTOMER, id);
    return { ...customer, tags };
  }

  @Post()
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Create a customer' })
  async create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const customer = await this.customers.create({ ...dto, createdById: user.id });

    await this.audit.record(
      {
        action: 'customers.create',
        resource: 'customer',
        resourceId: customer.id,
        // The phone number is PII; the audit trail records that a customer was created and by whom,
        // not their contact details (`PROJECT_SPEC.md` §110).
        after: { displayName: customer.displayName, status: customer.status, source: customer.source },
      },
      this.audit.actorFromRequest(request, user),
    );

    return customer;
  }

  @Patch(':id')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Update a customer' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const { before, after } = await this.customers.update(id, dto);

    await this.audit.record(
      {
        action: 'customers.update',
        resource: 'customer',
        resourceId: id,
        before: { displayName: before.displayName, status: before.status },
        after: { displayName: after.displayName, status: after.status },
      },
      this.audit.actorFromRequest(request, user),
    );

    return after;
  }

  // === identities ================================================================================

  @Get('identities/list')
  @RequirePermissions('customers.read')
  @ApiOperation({
    summary: 'List channel identities',
    description:
      'Filter by `matchState=UNRESOLVED` for the review queue — every sender the system has seen but ' +
      'nobody has attributed to a customer yet.',
  })
  async listIdentities(@Query() query: ListIdentitiesDto) {
    return this.customers.listIdentities(query);
  }

  @Post('identities')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Register a channel identity, optionally linked to a customer' })
  async createIdentity(
    @Body() dto: CreateIdentityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const identity = await this.customers.createIdentity({ ...dto, resolvedById: user.id });

    await this.audit.record(
      {
        action: 'customers.identity_created',
        resource: 'customer_identity',
        resourceId: identity.id,
        after: { channelKey: identity.channelKey, matchState: identity.matchState, customerId: identity.customerId },
      },
      this.audit.actorFromRequest(request, user),
    );

    return identity;
  }

  /**
   * Asks the matcher whether this identity has an obvious owner.
   *
   * Proposes `CANDIDATE` at most — never confirms. The brief §2 forbids automatic promotion, and an
   * exact phone match is evidence worth surfacing, not a decision worth making.
   */
  @Post('identities/:id/propose-match')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Propose a customer for an unresolved identity (exact phone match only)' })
  async proposeMatch(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const result = await this.customers.proposeMatch(id);

    if (result.proposed) {
      await this.audit.record(
        {
          action: 'customers.identity_candidate_proposed',
          resource: 'customer_identity',
          resourceId: id,
          after: { customerId: result.identity.customerId, matchSource: result.identity.matchSource },
        },
        this.audit.actorFromRequest(request, user),
      );
    }

    return { proposed: result.proposed, reason: result.reason, identity: result.identity };
  }

  @Post('identities/:id/confirm')
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Confirm an identity belongs to a customer',
    description:
      'The only path to CONFIRMED. Backfills the customer onto conversations this identity ' +
      'participates in that have no customer yet; never overwrites a different one.',
  })
  async confirmIdentity(
    @Param('id') id: string,
    @Body() dto: ResolveIdentityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.customers.findIdentity(id);
    const customerId = dto.customerId ?? before.customerId;
    if (!customerId) {
      // Confirming without naming a customer is meaningless, and the database would reject it.
      return { error: 'customerId is required to confirm an identity' };
    }

    const identity = await this.customers.confirmIdentity(id, customerId, user.id, dto.note);

    await this.audit.record(
      {
        action: 'customers.identity_confirmed',
        resource: 'customer_identity',
        resourceId: id,
        before: { matchState: before.matchState, customerId: before.customerId },
        after: { matchState: identity.matchState, customerId: identity.customerId },
        metadata: { note: dto.note ?? null },
      },
      this.audit.actorFromRequest(request, user),
    );

    return identity;
  }

  @Post('identities/:id/reject')
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Record that an identity is NOT the linked customer',
    description:
      'Keeps the link recorded as REJECTED so the same wrong match is not re-proposed, and detaches ' +
      'any conversation attributed on the strength of it.',
  })
  async rejectIdentity(
    @Param('id') id: string,
    @Body() dto: ResolveIdentityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.customers.findIdentity(id);
    const identity = await this.customers.rejectIdentity(id, user.id, dto.note);

    await this.audit.record(
      {
        action: 'customers.identity_rejected',
        resource: 'customer_identity',
        resourceId: id,
        before: { matchState: before.matchState, customerId: before.customerId },
        after: { matchState: identity.matchState },
        metadata: { note: dto.note ?? null },
      },
      this.audit.actorFromRequest(request, user),
    );

    return identity;
  }

  // === notes and tags =============================================================================

  @Get(':id/notes')
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: 'Internal notes on a customer (never sent to the customer or to AI)' })
  async listNotes(
    @Param('id') id: string,
    @Query() query: { limit?: number; offset?: number },
  ) {
    return this.customers.listNotes(id, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  }

  @Post(':id/notes')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Add an internal note' })
  async addNote(
    @Param('id') id: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const note = await this.customers.addNote(
      id,
      dto.body,
      { id: user.id, username: user.username },
      dto.isPinned ?? false,
    );

    await this.audit.record(
      {
        action: 'customers.note_added',
        resource: 'customer',
        resourceId: id,
        // The note BODY is not audited: notes are internal commentary about a customer, and the
        // audit log is readable by more roles than the CRM itself.
        after: { noteId: note.id, isPinned: note.isPinned, length: note.body.length },
      },
      this.audit.actorFromRequest(request, user),
    );

    return note;
  }

  @Post(':id/tags')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Attach a tag (created on first use)' })
  async addTag(
    @Param('id') id: string,
    @Body() dto: TagDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.customers.findOne(id);
    const tag = await this.customers.addTag(TaggableEntity.CUSTOMER, id, dto.tagKey, user.id);

    await this.audit.record(
      { action: 'customers.tag_added', resource: 'customer', resourceId: id, after: { tag: tag.key } },
      this.audit.actorFromRequest(request, user),
    );

    return tag;
  }

  @Post(':id/tags/remove')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Detach a tag' })
  async removeTag(
    @Param('id') id: string,
    @Body() dto: TagDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    await this.customers.removeTag(TaggableEntity.CUSTOMER, id, dto.tagKey);

    await this.audit.record(
      { action: 'customers.tag_removed', resource: 'customer', resourceId: id, before: { tag: dto.tagKey } },
      this.audit.actorFromRequest(request, user),
    );

    return { removed: true };
  }
}
