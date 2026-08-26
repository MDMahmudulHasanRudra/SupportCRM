import { ChannelConnectionState } from '../channel-connection';
import {
  DeliveryStatus,
  MessageContentType,
  ParticipantRole,
  isDeliveryProgression,
} from '../../messaging/message-types';
import {
  KNOWN_SESSION_STATUSES,
  extractPhone,
  isGroupJid,
  mapContentType,
  mapDeliveryStatus,
  mapParticipantRole,
  mapSessionStatus,
  toDate,
  whatsAppCapabilities,
} from './openwa.mappers';

describe('mapSessionStatus', () => {
  it('maps every status the gateway declares', () => {
    // Guards against the gateway adding a status we silently swallow: every documented value must
    // map to something other than UNKNOWN.
    for (const status of KNOWN_SESSION_STATUSES) {
      expect(mapSessionStatus(status)).not.toBe(ChannelConnectionState.UNKNOWN);
    }
  });

  it('maps the states that matter operationally', () => {
    expect(mapSessionStatus('ready')).toBe(ChannelConnectionState.CONNECTED);
    expect(mapSessionStatus('qr_ready')).toBe(ChannelConnectionState.QR_REQUIRED);
    expect(mapSessionStatus('action_required')).toBe(ChannelConnectionState.QR_REQUIRED);
    expect(mapSessionStatus('initializing')).toBe(ChannelConnectionState.CONNECTING);
    expect(mapSessionStatus('authenticating')).toBe(ChannelConnectionState.CONNECTING);
    expect(mapSessionStatus('disconnected')).toBe(ChannelConnectionState.DISCONNECTED);
    expect(mapSessionStatus('failed')).toBe(ChannelConnectionState.ERROR);
  });

  it('treats a created-but-unstarted session as disconnected, not connecting', () => {
    // CONNECTING would leave the UI spinning forever waiting for a transition nobody triggered.
    expect(mapSessionStatus('created')).toBe(ChannelConnectionState.DISCONNECTED);
  });

  it('returns UNKNOWN — never CONNECTED — for an unrecognised status', () => {
    // The safety property: an unmapped state must never let the outbound layer try to send.
    for (const value of ['brand_new_state', '', null, undefined]) {
      expect(mapSessionStatus(value as string)).toBe(ChannelConnectionState.UNKNOWN);
    }
  });
});

describe('mapDeliveryStatus', () => {
  it('maps the gateway signals', () => {
    expect(mapDeliveryStatus('sent')).toBe(DeliveryStatus.SENT);
    expect(mapDeliveryStatus('delivered')).toBe(DeliveryStatus.DELIVERED);
    expect(mapDeliveryStatus('read')).toBe(DeliveryStatus.READ);
    expect(mapDeliveryStatus('failed')).toBe(DeliveryStatus.FAILED);
  });

  it('maps provider "pending" to SENDING, not QUEUED', () => {
    // The provider has accepted it — strictly further along than sitting in our own queue.
    expect(mapDeliveryStatus('pending')).toBe(DeliveryStatus.SENDING);
  });

  it('returns null for an unmapped receipt so the state is not moved on a guess', () => {
    expect(mapDeliveryStatus('teleported')).toBeNull();
    expect(mapDeliveryStatus(undefined)).toBeNull();
  });
});

describe('isDeliveryProgression', () => {
  it('allows forward progress', () => {
    expect(isDeliveryProgression(DeliveryStatus.QUEUED, DeliveryStatus.SENT)).toBe(true);
    expect(isDeliveryProgression(DeliveryStatus.SENT, DeliveryStatus.DELIVERED)).toBe(true);
    expect(isDeliveryProgression(DeliveryStatus.DELIVERED, DeliveryStatus.READ)).toBe(true);
  });

  it('refuses to regress on an out-of-order receipt', () => {
    // Receipts are not ordered on the wire: `delivered` can arrive after `read`.
    expect(isDeliveryProgression(DeliveryStatus.READ, DeliveryStatus.DELIVERED)).toBe(false);
    expect(isDeliveryProgression(DeliveryStatus.DELIVERED, DeliveryStatus.SENT)).toBe(false);
  });

  it('treats terminal states as final', () => {
    expect(isDeliveryProgression(DeliveryStatus.FAILED, DeliveryStatus.DELIVERED)).toBe(false);
    expect(isDeliveryProgression(DeliveryStatus.CANCELLED, DeliveryStatus.SENT)).toBe(false);
  });

  it('ignores a repeat of the same status', () => {
    expect(isDeliveryProgression(DeliveryStatus.SENT, DeliveryStatus.SENT)).toBe(false);
  });

  it('allows a send to fail from any non-terminal state', () => {
    expect(isDeliveryProgression(DeliveryStatus.SENDING, DeliveryStatus.FAILED)).toBe(true);
    expect(isDeliveryProgression(DeliveryStatus.DELIVERED, DeliveryStatus.FAILED)).toBe(true);
  });
});

describe('mapContentType', () => {
  it('maps both engines’ vocabularies for text', () => {
    expect(mapContentType('chat')).toBe(MessageContentType.TEXT);
    expect(mapContentType('text')).toBe(MessageContentType.TEXT);
  });

  it('maps media types', () => {
    expect(mapContentType('image')).toBe(MessageContentType.IMAGE);
    expect(mapContentType('video')).toBe(MessageContentType.VIDEO);
    expect(mapContentType('document')).toBe(MessageContentType.DOCUMENT);
    expect(mapContentType('sticker')).toBe(MessageContentType.STICKER);
  });

  it('maps every audio spelling, including push-to-talk', () => {
    for (const type of ['audio', 'ptt', 'voice']) {
      expect(mapContentType(type)).toBe(MessageContentType.AUDIO);
    }
  });

  it('maps group and system notifications to SYSTEM_EVENT', () => {
    for (const type of ['gp2', 'group_notification', 'e2e_notification', 'call_log']) {
      expect(mapContentType(type)).toBe(MessageContentType.SYSTEM_EVENT);
    }
  });

  it('is case-insensitive', () => {
    expect(mapContentType('IMAGE')).toBe(MessageContentType.IMAGE);
  });

  it('returns UNSUPPORTED rather than pretending an unknown type is text', () => {
    // Mislabelling an unknown payload as TEXT would feed an empty body to the decision engine
    // later as though the customer had said nothing.
    expect(mapContentType('poll_creation')).toBe(MessageContentType.UNSUPPORTED);
    expect(mapContentType(undefined)).toBe(MessageContentType.UNSUPPORTED);
  });
});

describe('mapParticipantRole', () => {
  const base = { id: 'x@c.us', number: '1', isAdmin: false, isSuperAdmin: false };

  it('ranks super admin above admin', () => {
    expect(mapParticipantRole({ ...base, isAdmin: true, isSuperAdmin: true })).toBe(ParticipantRole.SUPER_ADMIN);
    expect(mapParticipantRole({ ...base, isSuperAdmin: true })).toBe(ParticipantRole.SUPER_ADMIN);
  });

  it('maps admin and member', () => {
    expect(mapParticipantRole({ ...base, isAdmin: true })).toBe(ParticipantRole.ADMIN);
    expect(mapParticipantRole(base)).toBe(ParticipantRole.MEMBER);
  });
});

describe('extractPhone', () => {
  it('extracts digits from a contact JID', () => {
    expect(extractPhone('8801711223344@c.us')).toBe('8801711223344');
  });

  it('accepts a bare number', () => {
    expect(extractPhone('8801711223344')).toBe('8801711223344');
  });

  it('returns null for a group JID — a group is not a phone number', () => {
    // The local part of a group JID is `<creator>-<timestamp>`; treating it as a number would
    // create a phantom "customer" for every group.
    expect(extractPhone('120363043211234567-1609459200@g.us')).toBeNull();
  });

  it('returns null for values outside E.164 length', () => {
    expect(extractPhone('12345')).toBeNull();
    expect(extractPhone('1234567890123456')).toBeNull();
  });

  it('returns null for empty and nullish input', () => {
    expect(extractPhone('')).toBeNull();
    expect(extractPhone(null)).toBeNull();
    expect(extractPhone(undefined)).toBeNull();
  });

  it('bounds its input so a huge string cannot be a cheap DoS', () => {
    expect(() => extractPhone('9'.repeat(1_000_000))).not.toThrow();
    expect(extractPhone('9'.repeat(1_000_000))).toBeNull();
  });
});

describe('isGroupJid', () => {
  it('identifies group and direct chats', () => {
    expect(isGroupJid('1203630432-1609459200@g.us')).toBe(true);
    expect(isGroupJid('8801711223344@c.us')).toBe(false);
    expect(isGroupJid(null)).toBe(false);
  });
});

describe('toDate', () => {
  it('converts provider epoch seconds', () => {
    expect(toDate(1_800_000_000).toISOString()).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it('falls back to now for implausible values rather than corrupting ordering', () => {
    const before = Date.now();
    for (const value of [0, -1, 1, 99_999_999_999, NaN, null, undefined]) {
      const result = toDate(value as number).getTime();
      expect(result).toBeGreaterThanOrEqual(before - 1000);
    }
  });
});

describe('whatsAppCapabilities', () => {
  it('reports nothing available while disconnected', () => {
    const capabilities = whatsAppCapabilities(false);
    expect(Object.values(capabilities).every((value) => value === false)).toBe(true);
  });

  it('reports the send surface once connected', () => {
    const capabilities = whatsAppCapabilities(true);
    expect(capabilities.canSendText).toBe(true);
    expect(capabilities.canReply).toBe(true);
    expect(capabilities.canSendMedia).toBe(true);
    expect(capabilities.canReadGroupMembers).toBe(true);
    expect(capabilities.canReceiveDeliveryStatus).toBe(true);
    expect(capabilities.canReceiveReadStatus).toBe(true);
  });

  it('reports canBroadcast false even when connected', () => {
    // The gateway has a bulk endpoint, but Support CRM deliberately refuses it — broadcast must go
    // through the Job Center for preview, rate limiting and per-recipient failures (ADR-0001 §6).
    expect(whatsAppCapabilities(true).canBroadcast).toBe(false);
  });
});
