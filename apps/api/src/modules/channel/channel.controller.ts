import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { normalizeCapabilities } from './channel-capabilities';
import { ChannelRegistryService } from './channel-registry.service';
import { ChannelAccount } from './entities/channel-account.entity';
import { Channel } from './entities/channel.entity';
import { RequirePermissions } from '../rbac/permissions.guard';

/**
 * Read-only in Phase 1.
 *
 * Connect/disconnect/QR arrive in Phase 2 with the WhatsApp adapter. Shipping those routes now
 * would mean shipping endpoints that return "not implemented", which `PROJECT_SPEC.md` §209
 * explicitly rules out — a stubbed endpoint is not a delivered feature.
 */
@ApiTags('channels')
@Controller('channels')
export class ChannelController {
  constructor(
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    @InjectRepository(ChannelAccount) private readonly accounts: Repository<ChannelAccount>,
    private readonly registry: ChannelRegistryService,
  ) {}

  @Get()
  @RequirePermissions('channels.read')
  @ApiOperation({
    summary: 'Channels the platform knows about',
    description:
      '`hasAdapter` distinguishes a channel that is merely declared from one that is actually ' +
      'usable. The UI must gate on it rather than on `isEnabled` alone.',
  })
  async listChannels() {
    const all = await this.channels.find({ order: { key: 'ASC' } });
    return {
      items: all.map((channel) => ({
        key: channel.key,
        name: channel.name,
        isEnabled: channel.isEnabled,
        adapterKey: channel.adapterKey,
        hasAdapter: this.registry.has(channel.key),
      })),
    };
  }

  @Get('accounts')
  @RequirePermissions('channels.read')
  @ApiOperation({ summary: 'Connected channel accounts and their live status' })
  async listAccounts() {
    const all = await this.accounts.find({ order: { createdAt: 'ASC' } });
    return { items: all.map(serializeAccount) };
  }

  @Get('accounts/:id/capabilities')
  @RequirePermissions('channels.read')
  @ApiOperation({
    summary: 'What this account can actually do',
    description:
      'Never assumed from the channel type. `probed: false` means capabilities have not been ' +
      'established, and every action must be treated as unavailable (PROJECT_SPEC.md §174).',
  })
  async capabilities(@Param('id') id: string) {
    const account = await this.accounts.findOne({ where: { id } });
    if (!account) throw new NotFoundException(`Channel account ${id} not found`);

    return {
      channelAccountId: account.id,
      probed: account.capabilities !== null,
      capabilities: normalizeCapabilities(account.capabilities),
    };
  }
}

function serializeAccount(account: ChannelAccount) {
  return {
    id: account.id,
    channelKey: account.channelKey,
    externalName: account.externalName,
    // The channel's own id (a gateway session UUID for WhatsApp) is deliberately absent: the browser
    // has no use for it, and exposing it would leak the gateway's existence into the client
    // (docs/WHATSAPP_UX_ARCHITECTURE.md §9).
    label: account.label,
    displayIdentity: account.displayIdentity,
    status: account.status,
    isPrimary: account.isPrimary,
    // The error text is operational, not sensitive; the pairing payload (QR) is never exposed here.
    lastError: account.lastError,
    lastConnectedAt: account.lastConnectedAt,
    lastHeartbeatAt: account.lastHeartbeatAt,
    capabilitiesProbed: account.capabilities !== null,
  };
}
