import { NotFoundException } from '@nestjs/common';
import { ChannelRegistryService } from './channel-registry.service';
import { ChannelKey } from './entities/channel.entity';
import type { ChannelAdapter } from './channel-adapter.interface';

const fakeAdapter = (channelKey: ChannelKey, adapterKey: string): ChannelAdapter =>
  ({ channelKey, adapterKey }) as ChannelAdapter;

describe('ChannelRegistryService', () => {
  let registry: ChannelRegistryService;

  beforeEach(() => {
    registry = new ChannelRegistryService();
  });

  it('starts empty — nothing is implicitly available', () => {
    expect(registry.implementedChannels()).toEqual([]);
    expect(registry.has(ChannelKey.WHATSAPP)).toBe(false);
  });

  it('resolves a registered adapter', () => {
    const adapter = fakeAdapter(ChannelKey.WHATSAPP, 'openwa');
    registry.register(adapter);
    expect(registry.get(ChannelKey.WHATSAPP)).toBe(adapter);
    expect(registry.has(ChannelKey.WHATSAPP)).toBe(true);
  });

  it('throws an explanatory error for a channel with no adapter', () => {
    expect(() => registry.get(ChannelKey.MESSENGER)).toThrow(NotFoundException);
    expect(() => registry.get(ChannelKey.MESSENGER)).toThrow(/not yet implemented/);
  });

  it('refuses a second adapter for the same channel', () => {
    registry.register(fakeAdapter(ChannelKey.WHATSAPP, 'openwa'));
    expect(() => registry.register(fakeAdapter(ChannelKey.WHATSAPP, 'other'))).toThrow(
      /already served by adapter "openwa"/,
    );
  });

  it('allows re-registering the same adapter (idempotent bootstrap)', () => {
    registry.register(fakeAdapter(ChannelKey.WHATSAPP, 'openwa'));
    expect(() => registry.register(fakeAdapter(ChannelKey.WHATSAPP, 'openwa'))).not.toThrow();
  });

  it('keeps channels independent', () => {
    registry.register(fakeAdapter(ChannelKey.WHATSAPP, 'openwa'));
    registry.register(fakeAdapter(ChannelKey.MESSENGER, 'meta'));
    expect(registry.implementedChannels().sort()).toEqual(
      [ChannelKey.MESSENGER, ChannelKey.WHATSAPP].sort(),
    );
  });
});
