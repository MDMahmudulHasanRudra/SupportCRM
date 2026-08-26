import { ChannelKey } from '../entities/channel.entity';
import type { ChannelAccount } from '../entities/channel-account.entity';
import { WhatsAppChannelAdapter, clampSize, sanitizeFilename, sanitizeMimeType, sanitizeText } from './whatsapp.adapter';
import type { OpenWaWebhookEnvelope } from './openwa.contracts';

/**
 * Normalization and sanitisation are pure — they need no gateway, no database and no Nest context,
 * so they are unit-tested directly against a bare instance.
 */
const adapter = new WhatsAppChannelAdapter(
  null as never,
  null as never,
  null as never,
  null as never,
);

const account = { id: 'acc-1', channelKey: ChannelKey.WHATSAPP, externalId: 'session-1' } as ChannelAccount;

function envelope(data: Record<string, unknown>): OpenWaWebhookEnvelope {
  return {
    event: 'message.received',
    timestamp: new Date().toISOString(),
    sessionId: 'session-1',
    idempotencyKey: 'k',
    deliveryId: 'd',
    data,
  };
}

const directMessage = {
  id: 'MSG-1',
  from: '8801711223344@c.us',
  to: '8801999999999@c.us',
  chatId: '8801711223344@c.us',
  body: 'MikroTik unreachable',
  type: 'chat',
  timestamp: 1_800_000_000,
  fromMe: false,
  isGroup: false,
};

const groupMessage = {
  ...directMessage,
  id: 'MSG-2',
  // In a group the gateway puts the GROUP jid in `from` and the real sender in `author`.
  from: '120363043211234567-1609459200@g.us',
  chatId: '120363043211234567-1609459200@g.us',
  author: '8801711223344@c.us',
  isGroup: true,
};

describe('normalizeInboundMessage', () => {
  it('normalizes a direct message', () => {
    const result = adapter.normalizeInboundMessage(account, envelope(directMessage))!;

    expect(result.externalId).toBe('MSG-1');
    expect(result.channelAccountId).toBe('acc-1');
    expect(result.externalConversationId).toBe('8801711223344@c.us');
    expect(result.externalGroupId).toBeNull();
    expect(result.senderExternalId).toBe('8801711223344@c.us');
    expect(result.senderPhone).toBe('8801711223344');
    expect(result.body).toBe('MikroTik unreachable');
    expect(result.messageType).toBe('text');
    expect(result.fromMe).toBe(false);
  });

  it('attributes a group message to its author, not to the group', () => {
    // The single most consequential mapping in the adapter. Getting it backwards would attribute
    // every group message to the group itself, making Support Activity and classification useless.
    const result = adapter.normalizeInboundMessage(account, envelope(groupMessage))!;

    expect(result.senderExternalId).toBe('8801711223344@c.us');
    expect(result.senderPhone).toBe('8801711223344');
    expect(result.externalGroupId).toBe('120363043211234567-1609459200@g.us');
    expect(result.externalConversationId).toBe('120363043211234567-1609459200@g.us');
  });

  it('detects a group from the JID even when isGroup is absent', () => {
    const { isGroup: _omitted, ...withoutFlag } = groupMessage;
    const result = adapter.normalizeInboundMessage(account, envelope(withoutFlag))!;
    expect(result.externalGroupId).toBe('120363043211234567-1609459200@g.us');
  });

  it('drops status/story broadcasts — they are not conversations', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({ ...directMessage, isStatusBroadcast: true }),
    );
    expect(result).toBeNull();
  });

  it('returns null rather than throwing on an unaddressable payload', () => {
    expect(adapter.normalizeInboundMessage(account, envelope({}))).toBeNull();
    expect(adapter.normalizeInboundMessage(account, envelope({ id: 'x' }))).toBeNull();
    expect(adapter.normalizeInboundMessage(account, envelope({ chatId: 'x@c.us' }))).toBeNull();
    // A group message with neither author nor from is unattributable.
    expect(
      adapter.normalizeInboundMessage(account, envelope({ id: 'x', chatId: 'g@g.us', isGroup: true })),
    ).toBeNull();
  });

  it('carries media metadata and marks a provider-omitted payload', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({
        ...directMessage,
        type: 'image',
        media: { mimetype: 'image/jpeg', filename: 'photo.jpg', sizeBytes: 2048, omitted: true },
      }),
    )!;

    expect(result.messageType).toBe('image');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
      sizeBytes: 2048,
      omitted: true,
    });
  });

  it('records the quoted message reference', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({ ...directMessage, quotedMessage: { id: 'MSG-0', body: 'earlier' } }),
    )!;
    expect(result.quotedExternalId).toBe('MSG-0');
  });

  it('bounds mentions so a hostile message cannot allocate without limit', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({ ...directMessage, mentionedIds: Array.from({ length: 10_000 }, (_, i) => `${i}@c.us`) }),
    )!;
    expect(result.mentionedExternalIds.length).toBeLessThanOrEqual(256);
  });

  it('discards non-string entries in mentions', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({ ...directMessage, mentionedIds: ['a@c.us', null, 42, { evil: true }] }),
    )!;
    expect(result.mentionedExternalIds).toEqual(['a@c.us']);
  });

  it('marks an unrecognised type UNSUPPORTED but still normalizes the message', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({ ...directMessage, type: 'poll_creation' }),
    )!;
    expect(result.messageType).toBe('unsupported');
    // Persisted in full — never dropped just because we cannot classify it.
    expect(result.externalId).toBe('MSG-1');
  });

  it('never puts message content in the raw diagnostic blob', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({ ...directMessage, body: 'a customer secret' }),
    )!;
    expect(JSON.stringify(result.raw)).not.toContain('a customer secret');
  });

  it('caps an oversized body', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({ ...directMessage, body: 'x'.repeat(100_000) }),
    )!;
    expect(result.body!.length).toBe(16_000);
  });

  it('treats a missing body as null, not an empty string', () => {
    const result = adapter.normalizeInboundMessage(
      account,
      envelope({ ...directMessage, body: '', type: 'image', media: { mimetype: 'image/png' } }),
    )!;
    expect(result.body).toBeNull();
  });
});

describe('sanitizers', () => {
  describe('sanitizeText', () => {
    it('strips control characters that could inject into a log line', () => {
      expect(sanitizeText('hello\u0000\u001bworld', 100)).toBe('helloworld');
    });

    it('trims and caps length', () => {
      expect(sanitizeText('  spaced  ', 100)).toBe('spaced');
      expect(sanitizeText('x'.repeat(500), 10)).toBe('x'.repeat(10));
    });

    it('returns null for empty or non-string input', () => {
      expect(sanitizeText('   ', 10)).toBeNull();
      expect(sanitizeText(undefined, 10)).toBeNull();
      expect(sanitizeText(42 as never, 10)).toBeNull();
    });

    it('preserves non-Latin text', () => {
      // Bangla is this deployment's primary traffic; mangling it would be a silent data loss.
      expect(sanitizeText('সফটওয়্যার স্লো', 100)).toBe('সফটওয়্যার স্লো');
    });
  });

  describe('sanitizeMimeType', () => {
    it('reduces to a bare type/subtype', () => {
      expect(sanitizeMimeType('image/jpeg; charset=binary')).toBe('image/jpeg');
      expect(sanitizeMimeType('IMAGE/JPEG')).toBe('image/jpeg');
    });

    it('falls back to octet-stream for anything malformed', () => {
      // The least-privileged interpretation, never the caller's claim.
      for (const bad of ['not-a-mime', '', '../../etc/passwd', undefined, '<script>']) {
        expect(sanitizeMimeType(bad as string)).toBe('application/octet-stream');
      }
    });
  });

  describe('sanitizeFilename', () => {
    it('strips directory components', () => {
      expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    });

    it('strips leading dots so a hidden file cannot be produced', () => {
      expect(sanitizeFilename('...hidden')).toBe('hidden');
    });

    it('strips control characters and caps length', () => {
      expect(sanitizeFilename('do\u0000c.pdf')).toBe('doc.pdf');
      expect(sanitizeFilename(`${'a'.repeat(500)}.pdf`)!.length).toBe(255);
    });

    it('returns null when nothing usable remains', () => {
      expect(sanitizeFilename('...')).toBeNull();
      expect(sanitizeFilename('/')).toBeNull();
      expect(sanitizeFilename(undefined)).toBeNull();
    });
  });

  describe('clampSize', () => {
    it('accepts a plausible size', () => {
      expect(clampSize(2048)).toBe(2048);
    });

    it('rejects nonsense rather than storing it', () => {
      expect(clampSize(-1)).toBeNull();
      expect(clampSize(NaN)).toBeNull();
      expect(clampSize(undefined)).toBeNull();
    });

    it('clamps an absurd declared size', () => {
      expect(clampSize(Number.MAX_SAFE_INTEGER)).toBe(1024 * 1024 * 1024);
    });
  });
});

describe('identifyWebhookAccount', () => {
  it('reads sessionId from an unverified body', () => {
    expect(adapter.identifyWebhookAccount(Buffer.from('{"sessionId":"s1"}'))).toBe('s1');
  });

  it('returns null for malformed JSON instead of throwing', () => {
    // This parses attacker-controlled bytes before any authentication has happened.
    expect(adapter.identifyWebhookAccount(Buffer.from('not json'))).toBeNull();
    expect(adapter.identifyWebhookAccount(Buffer.alloc(0))).toBeNull();
    expect(adapter.identifyWebhookAccount(Buffer.from('{"sessionId":42}'))).toBeNull();
  });

  it('bounds the value it will accept', () => {
    const long = JSON.stringify({ sessionId: 'x'.repeat(10_000) });
    expect(adapter.identifyWebhookAccount(Buffer.from(long))!.length).toBe(128);
  });
});
