import {
  Body,
  BadGatewayException,
  ConflictException,
  Controller,
  Get,
  Header,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AppLogger } from '../../../common/logging/app-logger';
import { AuditService } from '../../audit/audit.service';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { CurrentUser, RequirePermissions } from '../../rbac/permissions.guard';
import { IngestionService } from '../../ingestion/ingestion.service';
import { ChannelAccountService } from '../channel-account.service';
import { ChannelRecoveryService } from '../channel-recovery.service';
import { ChannelConnectionState, ConnectionEventSource } from '../channel-connection';
import { Channel, ChannelKey } from '../entities/channel.entity';
import { Group } from '../../groups/entities/group.entity';
import { ChannelAccount } from '../entities/channel-account.entity';
import {
  describeState,
  isActionable,
  toPresentationState,
  toUserFacingError,
} from './whatsapp-presentation';
import { GoWaClient } from './gowa.client';
import { WhatsAppAutomationGuard } from './whatsapp-automation.guard';
import { WhatsAppChannelAdapter } from './whatsapp.adapter';

export class RegisterAccountDto {
  /** Becomes the gateway session name and appears in URL paths — hence the strict pattern. */
  @IsString()
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/, {
    message: 'sessionId must be 3–64 chars: letters, digits, hyphen or underscore, starting alphanumeric',
  })
  sessionId!: string;

  @IsString() @MinLength(1) @MaxLength(120) label!: string;

  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class PhonePairingDto { @Matches(/^[1-9][0-9]{6,14}$/) phone!: string; }
export class PasskeyAssertionDto { @IsObject() assertion!: Record<string,unknown>; }
export class RemoveDeviceDto { @Matches(/^REMOVE$/) confirm!: string; }

export class SetOwnershipDto {
  @IsBoolean() enabled!: boolean;
}

export class ConfirmLogoutDto {
  @Matches(/^LOGOUT$/) confirm!: string;
}

/**
 * WhatsApp account and session management (Phase 2 brief §3, §20).
 *
 * Every route here was written only after confirming the corresponding gateway endpoint exists in
 * the vendored source — the brief forbids stubs, and `PROJECT_SPEC.md` §209 forbids calling a
 * stubbed endpoint "implemented". Logout is distinct from stopping a session: the web flow and
 * server both require explicit confirmation because reconnecting after unlink needs another scan.
 */
@ApiTags('channels')
@Controller('channels/whatsapp')
export class WhatsAppController {
  private readonly logger = new AppLogger(WhatsAppController.name);

  constructor(
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(ChannelAccount) private readonly accountRepo: Repository<ChannelAccount>,
    private readonly accounts: ChannelAccountService,
    private readonly recovery: ChannelRecoveryService,
    private readonly adapter: WhatsAppChannelAdapter,
    private readonly automationGuard: WhatsAppAutomationGuard,
    private readonly ingestion: IngestionService,
    private readonly audit: AuditService,
    private readonly native: GoWaClient,
  ) {}

  /**
   * The WhatsApp Accounts page.
   *
   * One query per column the page shows, rather than making the browser assemble it from three
   * endpoints. Group counts come from one grouped query, not N+1.
   *
   * Carries no gateway vocabulary: no session id, no gateway URL, no API key. `externalName` is the
   * operator's own label for the session and is safe to show.
   */
  @Get('accounts/overview')
  @RequirePermissions('channels.read')
  @ApiOperation({ summary: 'Everything the WhatsApp Accounts page needs, in one call' })
  async overview() {
    const accounts = await this.accountRepo.find({
      where: { channelKey: ChannelKey.WHATSAPP },
      order: { createdAt: 'ASC' },
    });
    if (accounts.length === 0) return { items: [] };

    // One grouped query for every account's group count and latest activity — never a query per row.
    const stats = await this.groups
      .createQueryBuilder('g')
      .select('g.channelAccountId', 'accountId')
      .addSelect('COUNT(*)::int', 'groupCount')
      .addSelect('MAX(g.lastMessageAt)', 'lastActivityAt')
      .where('g.isActive = true')
      .groupBy('g.channelAccountId')
      .getRawMany<{ accountId: string; groupCount: number; lastActivityAt: Date | null }>();

    const byAccount = new Map(stats.map((row) => [row.accountId, row]));

    return {
      items: accounts.map((account) => {
        const presentation = toPresentationState(account);
        const stat = byAccount.get(account.id);

        return {
          id: account.id,
          name: account.label,
          sessionName: account.externalName,
          phoneNumber: account.accountPhone,
          displayName: account.displayIdentity,
          state: presentation,
          statusText: describeState(presentation),
          canConnect: isActionable(presentation),
          isPrimary: account.isPrimary,
          ownershipEnabled: account.ownershipEnabled,
          connected: presentation === 'CONNECTED',
          lastConnectedAt: account.lastConnectedAt,
          lastHeartbeatAt: account.lastHeartbeatAt,
          lastActivityAt: stat?.lastActivityAt ?? null,
          groupCount: stat?.groupCount ?? 0,
        };
      }),
    };
  }

  /**
   * "+ Connect WhatsApp" — register and connect in ONE call.
   *
   * The two-step register-then-connect flow still exists for scripted use, but an administrator
   * clicking one button should not need two round trips, and a failure between them used to leave a
   * registered account with no session.
   *
   * Returns as soon as the gateway accepts. Pairing needs a human to scan a QR, which arrives over
   * the websocket — blocking the request on it would tie up a worker for minutes.
   */
  @Post('accounts/connect')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Create a WhatsApp account and start connecting it (one call)' })
  async createAndConnect(
    @Body() dto: RegisterAccountDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const account = await this.accounts.register({
      channelKey: ChannelKey.WHATSAPP,
      externalName: dto.sessionId,
      label: dto.label,
      isPrimary: dto.isPrimary,
    });

    await this.audit.record(
      {
        action: 'channels.account_registered',
        resource: 'channel_account',
        resourceId: account.id,
        after: { channelKey: account.channelKey, externalName: account.externalName, label: account.label },
      },
      this.audit.actorFromRequest(request, user),
    );

    // If connecting fails the account row stays — the operator can retry from the list rather than
    // losing their input. The error they see is a sentence, never a gateway detail.
    try {
      return await this.connect(account.id, user, request);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new InternalServerErrorException(toUserFacingError(error));
    }
  }

  @Post('accounts')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Register a WhatsApp account without connecting it' })
  async register(
    @Body() dto: RegisterAccountDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const account = await this.accounts.register({
      channelKey: ChannelKey.WHATSAPP,
      externalName: dto.sessionId,
      label: dto.label,
      isPrimary: dto.isPrimary,
    });

    await this.audit.record(
      {
        action: 'channels.account_registered',
        resource: 'channel_account',
        resourceId: account.id,
        after: { channelKey: account.channelKey, externalName: account.externalName, label: account.label },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serializeAccount(account);
  }

  /**
   * Starts the session and provisions its webhook.
   *
   * Order is deliberate. The automation guard runs FIRST: if the gateway is already autoreplying on
   * this session, connecting would put two independent responders on one customer conversation
   * (`docs/adr/0001` §6). Refusing before anything is started is the only safe order.
   *
   * Returns as soon as the gateway accepts. It does not wait for CONNECTED — pairing needs a human
   * to scan a QR, which can take minutes (brief §10).
   */
  @Post('accounts/:id/connect')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Connect a session and register its webhook' })
  async connect(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const account = await this.accounts.findOne(id);
    if (!account.ownershipEnabled) {
      throw new ConflictException('Support CRM does not own this account. Enable ownership first.');
    }

    return this.accounts.withSessionLock(id, 'connect', async () => {
      // Checked BEFORE the session is started, so a gateway already autoreplying is refused
      // before anything connects. An account with no session yet cannot be autoreplying, and
      // the guard treats an unknown session as safe for exactly that reason.
      const guard = await this.automationGuard.check(account.externalId);
      if (!guard.safe) {
        await this.audit.record(
          {
            action: 'channels.connect_blocked',
            resource: 'channel_account',
            resourceId: id,
            success: false,
            metadata: { reason: 'gateway_automation_active', ruleNames: guard.ruleNames },
          },
          this.audit.actorFromRequest(request, user),
        );
        throw new ConflictException(guard.detail);
      }

      // An operator asking for this account to be up overrides any earlier "keep it down", and
      // gives automatic recovery a clean budget rather than one already spent on a past outage.
      await this.recovery.setOperatorIntent(id, 'connect');

      let state;
      try {
        state = await this.adapter.connect(id);
      } catch (error) {
        // Record the failure on the account so the list shows it, then surface one sentence.
        await this.accounts
          .recordState(account, ChannelConnectionState.ERROR, {
            source: ConnectionEventSource.ADMIN_ACTION,
            actorId: user.id,
            detail: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
        throw new InternalServerErrorException(toUserFacingError(error));
      }

      // Re-read AFTER connect. `connect()` is what learns the gateway's session id and writes it to
      // the row; the `account` captured above still has `externalId: null`, and passing that stale
      // object to webhook provisioning fails with "no gateway session yet" on a connect that
      // actually succeeded.
      const connected = await this.accounts.findOne(id);

      // Provision the webhook only after the session exists on the gateway.
      const { webhookId, secret } = await this.adapter.provisionWebhook(
        connected,
        this.ingestion.callbackUrl(connected.id),
      );
      await this.accounts.setWebhook(id, webhookId, this.adapter.encryptWebhookSecret(id, secret));

      const updated = await this.accounts.recordState(connected, state.status, {
        source: ConnectionEventSource.ADMIN_ACTION,
        rawState: state.status,
        actorId: user.id,
        displayIdentity: state.displayIdentity,
        accountPhone: state.accountPhone ?? null,
        capabilities: state.capabilities,
      });

      await this.audit.record(
        {
          action: 'channels.connect',
          resource: 'channel_account',
          resourceId: id,
          after: { status: updated.status, webhookRegistered: true },
        },
        this.audit.actorFromRequest(request, user),
      );

      return serializeAccount(updated);
    });
  }

  /**
   * The QR code for pairing.
   *
   * Credential-equivalent: whoever holds it can pair a device to the customer's WhatsApp. It is
   * returned to this authorised caller and nowhere else — never persisted, never logged, and the
   * audit entry records that a QR was *viewed*, never its contents.
   */
  @Get('accounts/:id/qr')
  @Header('Cache-Control','no-store')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Fetch the pairing QR code (sensitive — never logged or stored)' })
  async qr(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const payload = await this.adapter.getPairingPayload(id);
    if(payload.state===ChannelConnectionState.CONNECTED){const current=await this.accounts.findOne(id);if(current.status!==ChannelConnectionState.CONNECTED){const live=await this.adapter.getAccountState(id);await this.accounts.recordState(current,live.status,{source:ConnectionEventSource.GATEWAY_POLL,displayIdentity:live.displayIdentity,accountPhone:live.accountPhone??null,capabilities:live.capabilities});}}


    await this.audit.record(
      { action: 'channels.qr_viewed', resource: 'channel_account', resourceId: id },
      this.audit.actorFromRequest(request, user),
    );

    // Shape matches the websocket payload, so a client that reconnects mid-flow can fall back to
    // this once and then keep receiving pushes without special-casing either source.
    return {
      accountId: id,
      state: payload.state,
      qr: payload.qr,
      // Same discrimination the websocket payload carries, so one rendering path serves both.
      format: payload.qr?.startsWith('data:image') ? 'image' : 'text',
      available: payload.qr !== null,
      expiresAt: payload.qr ? new Date(Date.now() + 20_000).toISOString() : null,
    };
  }

  @Post('accounts/:id/disconnect')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Pause CRM ownership while retaining device pairing' })
  async disconnect(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    // The provider cannot suspend a paired socket. This compatibility route now pauses CRM.
    await this.recovery.setOperatorIntent(id, 'disconnect');
    return this.setOwnership(id, {enabled:false}, user, request);
  }

  private async device(id:string) {
    const account=await this.accounts.findOne(id);
    if(account.channelKey!==ChannelKey.WHATSAPP||!account.externalId)throw new ConflictException('Create and connect a WhatsApp account first.');
    return account.externalId;
  }

  @Post('accounts/:id/pairing-code') @RequirePermissions('channels.manage')
  async pairingCode(@Param('id',ParseUUIDPipe)id:string,@Body()dto:PhonePairingDto,@CurrentUser()user:AuthenticatedUser,@Req()req:Request){
    const result=await this.native.pairCode(await this.device(id),dto.phone);
    await this.audit.record({action:'channels.pairing_code_requested',resource:'channel_account',resourceId:id},this.audit.actorFromRequest(req,user));
    return {code:result.pair_code};
  }

  @Post('accounts/:id/passkey/status') @RequirePermissions('channels.manage')
  async passkeyStatus(@Param('id',ParseUUIDPipe)id:string){return this.native.request('GET','/app/passkey',undefined,await this.device(id));}
  @Post('accounts/:id/passkey/response') @RequirePermissions('channels.manage')
  async passkeyResponse(@Param('id',ParseUUIDPipe)id:string,@Body()dto:PasskeyAssertionDto,@CurrentUser()user:AuthenticatedUser,@Req()req:Request){
    const result=await this.native.request('POST','/app/passkey/response',dto.assertion,await this.device(id));
    await this.audit.record({action:'channels.passkey_response',resource:'channel_account',resourceId:id},this.audit.actorFromRequest(req,user));return result;
  }
  @Post('accounts/:id/passkey/confirm') @RequirePermissions('channels.manage')
  async passkeyConfirm(@Param('id',ParseUUIDPipe)id:string,@CurrentUser()user:AuthenticatedUser,@Req()req:Request){
    const result=await this.native.request('POST','/app/passkey/confirm',{},await this.device(id));
    await this.audit.record({action:'channels.passkey_confirm',resource:'channel_account',resourceId:id},this.audit.actorFromRequest(req,user));return result;
  }
  @Post('accounts/:id/remove-device') @RequirePermissions('channels.manage')
  async removeDevice(@Param('id',ParseUUIDPipe)id:string,@Body()_dto:RemoveDeviceDto,@CurrentUser()user:AuthenticatedUser,@Req()req:Request){
    return this.accounts.withSessionLock(id,'remove',async()=>{
      const device=await this.device(id);await this.recovery.setOperatorIntent(id,'disconnect');
      await this.native.request('DELETE',`/devices/${encodeURIComponent(device)}`);
      await this.accountRepo.update(id,{externalId:null,webhookExternalId:null,webhookSecretEncrypted:null,accountPhone:null,capabilities:null,status:ChannelConnectionState.DISCONNECTED,ownershipEnabled:false});
      await this.audit.record({action:'channels.device_removed',resource:'channel_account',resourceId:id},this.audit.actorFromRequest(req,user));
      return serializeAccount(await this.accounts.findOne(id));
    });
  }

  @Post('accounts/:id/logout')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Explicitly unlink the device; requires confirm=LOGOUT and a new QR to link again' })
  async logout(@Param('id', ParseUUIDPipe) id: string, @Body() _dto: ConfirmLogoutDto, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    return this.accounts.withSessionLock(id, 'logout', async () => {
      const account = await this.accounts.findOne(id);
      if (account.channelKey !== ChannelKey.WHATSAPP) throw new ConflictException('This is not a WhatsApp account.');
      await this.recovery.setOperatorIntent(id, 'disconnect');
      await this.accounts.recordState(account, ChannelConnectionState.DISCONNECTING, { source: ConnectionEventSource.ADMIN_ACTION, actorId: user.id, detail: 'Device logout requested' });
      try { await this.adapter.logout(id); }
      catch {
        await this.accounts.recordState(await this.accounts.findOne(id), ChannelConnectionState.ERROR, { source: ConnectionEventSource.ADMIN_ACTION, actorId: user.id, detail: 'Device logout could not be confirmed. Reconnect and retry.', capabilities: null });
        await this.audit.record({ action: 'channels.logout', resource: 'channel_account', resourceId: id, success: false }, this.audit.actorFromRequest(request, user));
        throw new BadGatewayException('WhatsApp could not confirm device logout. Reconnect this account and try again.');
      }
      await this.accountRepo.update(id, { accountPhone: null, capabilities: null, lastError: null });
      const updated = await this.accounts.recordState(await this.accounts.findOne(id), ChannelConnectionState.DISCONNECTED, { source: ConnectionEventSource.ADMIN_ACTION, actorId: user.id, detail: 'Device logout completed; a fresh QR scan is required', capabilities: null });
      await this.audit.record({ action: 'channels.logout', resource: 'channel_account', resourceId: id }, this.audit.actorFromRequest(request, user));
      return serializeAccount(updated);
    });
  }

  @Post('accounts/:id/primary')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Select the primary WhatsApp sending account atomically' })
  async primary(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const account = await this.accounts.findOne(id);
    if (account.channelKey !== ChannelKey.WHATSAPP) throw new ConflictException('This is not a WhatsApp account.');
    await this.accountRepo.manager.transaction(async tx => {
      await tx.findOneOrFail(Channel, { where: { key: ChannelKey.WHATSAPP }, lock: { mode: 'pessimistic_write' } });
      await tx.update(ChannelAccount, { channelKey: ChannelKey.WHATSAPP, isPrimary: true }, { isPrimary: false });
      await tx.update(ChannelAccount, id, { isPrimary: true });
    });
    await this.audit.record({ action: 'channels.primary_changed', resource: 'channel_account', resourceId: id, after: { isPrimary: true } }, this.audit.actorFromRequest(request, user));
    return serializeAccount(await this.accounts.findOne(id));
  }

  /** Reconnect is stop-then-start, so a wedged session recovers without an operator doing both. */
  @Post('accounts/:id/reconnect')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Reconnect the paired WhatsApp device' })
  async reconnect(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.accounts.withSessionLock(id, 'reconnect', async () => {
      await this.recovery.setOperatorIntent(id, 'connect');

      // Already stopped is a fine outcome — the goal is "running", not "was stopped by me".
      const state = await this.adapter.reconnect(id);

      /*
       * Reconcile the webhook, rather than assume one exists.
       *
       * Reconnect does not delete a webhook, so a correctly registered one survives and this is a
       * no-op. It matters for the account whose registration never succeeded — a gateway that could
       * not reach the API when it was first paired leaves the session working and every inbound
       * message going nowhere, silently, forever. Reconnect is the operator's "make this work"
       * button, so it is the right place to repair that.
       *
       * Best-effort: the session is up either way, and failing the whole reconnect because a webhook
       * could not be registered would take a working session down over a recoverable problem.
       */
      const reconnected = await this.accounts.findOne(id);
      if (!reconnected.webhookExternalId) {
        try {
          const { webhookId, secret } = await this.adapter.provisionWebhook(
            reconnected,
            this.ingestion.callbackUrl(reconnected.id),
          );
          await this.accounts.setWebhook(id, webhookId, this.adapter.encryptWebhookSecret(id, secret));
          this.logger.log('Webhook registered during reconnect', { channelAccountId: id, webhookId });
        } catch (error) {
          this.logger.warn('Reconnect could not register the webhook; inbound messages will not arrive', {
            channelAccountId: id,
            error: (error as Error).message,
          });
        }
      }

      const updated = await this.accounts.recordState(reconnected, state.status, {
        source: ConnectionEventSource.ADMIN_ACTION,
        rawState: state.status,
        actorId: user.id,
        displayIdentity: state.displayIdentity,
        accountPhone: state.accountPhone ?? null,
        capabilities: state.capabilities,
      });

      await this.audit.record(
        { action: 'channels.reconnect', resource: 'channel_account', resourceId: id, after: { status: updated.status } },
        this.audit.actorFromRequest(request, user),
      );

      return serializeAccount(updated);
    });
  }

  /**
   * Live health for one account: our stored state, the gateway's current state, and the automation
   * diagnostic — the three things that determine whether this account can safely be used.
   */
  @Get('accounts/:id/health')
  @RequirePermissions('channels.read')
  @ApiOperation({ summary: 'Session health, including the gateway-automation safety check' })
  async health(@Param('id') id: string) {
    const account = await this.accounts.findOne(id);

    let gateway: { reachable: boolean; state: ChannelConnectionState; displayIdentity: string | null };
    try {
      await this.native.request('GET','/health');
      const state = await this.adapter.getAccountState(id);
      gateway = { reachable: true, state: state.status, displayIdentity: state.displayIdentity };
    } catch {
      // An unreachable gateway is reported as UNKNOWN, never guessed at.
      gateway = { reachable: false, state: ChannelConnectionState.UNKNOWN, displayIdentity: null };
    }

    const automation = await this.automationGuard.check(account.externalId);

    return {
      channelAccountId: account.id,
      storedState: account.status,
      ownershipEnabled: account.ownershipEnabled,
      webhookRegistered: Boolean(account.webhookExternalId),
      lastHeartbeatAt: account.lastHeartbeatAt,
      lastConnectedAt: account.lastConnectedAt,
      gateway,
      // `safe: false` here means the session must not be used until the operator acts.
      gatewayAutomation: {
        safe: automation.safe,
        activeRuleCount: automation.activeRuleCount,
        ruleNames: automation.ruleNames,
        detail: automation.detail,
      },
    };
  }

  @Get('accounts/:id/connection-events')
  @RequirePermissions('channels.read')
  @ApiOperation({ summary: 'Connection state history for this account' })
  async connectionEvents(@Param('id') id: string) {
    const items = await this.accounts.listConnectionEvents(id);
    return { items, total: items.length };
  }

  /**
   * Enables or disables Support CRM's ownership of an account.
   *
   * Disabling stops sending, syncing and inbound processing while keeping every row. It is how an
   * account is safely handed back — and the mechanism that makes an account-by-account production
   * cutover possible without deleting anything (`docs/adr/0001` §12).
   */
  @Post('accounts/:id/ownership')
  @RequirePermissions('channels.manage')
  @ApiOperation({ summary: 'Enable or disable Support CRM ownership of this account' })
  async setOwnership(
    @Param('id') id: string,
    @Body() dto: SetOwnershipDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const before = await this.accounts.findOne(id);
    const updated = await this.accounts.setOwnership(id, dto.enabled, user.id);

    await this.audit.record(
      {
        action: 'channels.ownership_changed',
        resource: 'channel_account',
        resourceId: id,
        before: { ownershipEnabled: before.ownershipEnabled },
        after: { ownershipEnabled: updated.ownershipEnabled },
      },
      this.audit.actorFromRequest(request, user),
    );

    return serializeAccount(updated);
  }
}

/** Never serialises the webhook secret or the webhook id — neither belongs in an API response. */
/**
 * The account as an administrator may see it.
 *
 * Note what is ABSENT: `externalId` (the gateway's session UUID), the webhook id, the webhook
 * secret, and any gateway URL or credential. The browser has no use for a session UUID and giving
 * it one would leak the gateway's existence into the client (`docs/WHATSAPP_UX_ARCHITECTURE.md` §9).
 */
function serializeAccount(account: {
  id: string;
  channelKey: string;
  externalId: string | null;
  externalName: string;
  label: string;
  displayIdentity: string | null;
  status: string;
  isPrimary: boolean;
  ownershipEnabled: boolean;
  webhookExternalId: string | null;
  lastError: string | null;
  lastConnectedAt: Date | null;
  lastHeartbeatAt: Date | null;
  recoveryNextAttemptAt?: Date | null;
  recoveryExhaustedAt?: Date | null;
  capabilities: unknown;
}) {
  const presentation = toPresentationState({
    status: account.status as ChannelConnectionState,
    lastError: account.lastError,
    lastConnectedAt: account.lastConnectedAt,
    recoveryNextAttemptAt: account.recoveryNextAttemptAt,
    recoveryExhaustedAt: account.recoveryExhaustedAt,
  });

  return {
    id: account.id,
    channelKey: account.channelKey,
    externalName: account.externalName,
    label: account.label,
    state: presentation,
    statusText: describeState(presentation),
    canConnect: isActionable(presentation),
    displayIdentity: account.displayIdentity,
    status: account.status,
    isPrimary: account.isPrimary,
    ownershipEnabled: account.ownershipEnabled,
    webhookRegistered: Boolean(account.webhookExternalId),
    lastConnectedAt: account.lastConnectedAt,
    lastHeartbeatAt: account.lastHeartbeatAt,
    capabilitiesProbed: account.capabilities !== null,
  };
}
