import { Injectable, NotFoundException } from '@nestjs/common';
import type { ChannelAdapter } from './channel-adapter.interface';
import type { ChannelKey } from './entities/channel.entity';

/**
 * Resolves a channel key to its adapter.
 *
 * This indirection is what keeps the rest of the application channel-neutral: the decision engine,
 * the outbound layer and the inbox ask the registry for "the adapter for this account's channel"
 * and never import a concrete adapter. Adding Messenger means registering one more implementation.
 *
 * Registration is explicit (a module calls `register()` on bootstrap) rather than
 * decorator-discovered, so the set of live adapters is greppable and a half-finished adapter cannot
 * accidentally activate itself by existing on disk.
 */
@Injectable()
export class ChannelRegistryService {
  private readonly adapters = new Map<ChannelKey, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    const existing = this.adapters.get(adapter.channelKey);
    if (existing && existing.adapterKey !== adapter.adapterKey) {
      // Two adapters claiming one channel means inbound messages could be normalised one way and
      // outbound sent another. Refuse rather than let last-registration-wins decide.
      throw new Error(
        `Channel "${adapter.channelKey}" is already served by adapter "${existing.adapterKey}"; ` +
          `refusing to register "${adapter.adapterKey}" over it.`,
      );
    }
    this.adapters.set(adapter.channelKey, adapter);
  }

  /** Throws rather than returning undefined — a missing adapter is a configuration fault, not a case to branch on. */
  get(channelKey: ChannelKey): ChannelAdapter {
    const adapter = this.adapters.get(channelKey);
    if (!adapter) {
      throw new NotFoundException(
        `No adapter is registered for channel "${channelKey}". ` +
          `It is defined in the channel registry but not yet implemented.`,
      );
    }
    return adapter;
  }

  has(channelKey: ChannelKey): boolean {
    return this.adapters.has(channelKey);
  }

  /** Which channels are actually usable right now — what the UI should offer. */
  implementedChannels(): ChannelKey[] {
    return [...this.adapters.keys()];
  }
}
