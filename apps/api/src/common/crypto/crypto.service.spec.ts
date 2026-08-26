import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { CryptoService } from './crypto.service';

function makeService(key = randomBytes(32).toString('base64')): CryptoService {
  const config = { getOrThrow: () => key } as unknown as ConfigService;
  return new CryptoService(config);
}

describe('CryptoService', () => {
  describe('master key parsing', () => {
    it('accepts a 32-byte base64 key', () => {
      expect(() => makeService(randomBytes(32).toString('base64'))).not.toThrow();
    });

    it('accepts a 64-character hex key', () => {
      expect(() => makeService(randomBytes(32).toString('hex'))).not.toThrow();
    });

    it('rejects a short key rather than silently padding it', () => {
      expect(() => makeService(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    });

    it('rejects a non-key string', () => {
      expect(() => makeService('hunter2')).toThrow(/32 bytes/);
    });
  });

  describe('encryptSecret / decryptSecret', () => {
    it('round-trips a value', () => {
      const svc = makeService();
      const secret = 'sk-proj-abc123-a-real-looking-api-key';
      expect(svc.decryptSecret(svc.encryptSecret(secret))).toBe(secret);
    });

    it('round-trips unicode and empty strings', () => {
      const svc = makeService();
      for (const value of ['', 'আপনার সমস্যাটি', '🔐 emoji']) {
        expect(svc.decryptSecret(svc.encryptSecret(value))).toBe(value);
      }
    });

    it('produces a different ciphertext every time (random IV)', () => {
      const svc = makeService();
      expect(svc.encryptSecret('same')).not.toBe(svc.encryptSecret('same'));
    });

    it('never leaks the plaintext into the envelope', () => {
      const svc = makeService();
      expect(svc.encryptSecret('SUPER_SECRET_VALUE')).not.toContain('SUPER_SECRET_VALUE');
    });

    it('fails to decrypt with a different master key', () => {
      const a = makeService();
      const b = makeService();
      expect(() => b.decryptSecret(a.encryptSecret('secret'))).toThrow();
    });

    it('detects tampering with the ciphertext', () => {
      const svc = makeService();
      const parts = svc.encryptSecret('secret').split(':');
      const tampered = Buffer.from(parts[3], 'base64');
      tampered[0] ^= 0xff;
      parts[3] = tampered.toString('base64');
      expect(() => svc.decryptSecret(parts.join(':'))).toThrow();
    });

    it('rejects a malformed envelope', () => {
      const svc = makeService();
      expect(() => svc.decryptSecret('not-an-envelope')).toThrow(/Malformed/);
      expect(() => svc.decryptSecret('v2:a:b:c')).toThrow(/Malformed/);
    });

    it('binds ciphertext to its aad context', () => {
      const svc = makeService();
      const envelope = svc.encryptSecret('secret', 'ai_provider:1:apiKey');
      expect(svc.decryptSecret(envelope, 'ai_provider:1:apiKey')).toBe('secret');
      // The same row copied under a different id must not decrypt.
      expect(() => svc.decryptSecret(envelope, 'ai_provider:2:apiKey')).toThrow();
      expect(() => svc.decryptSecret(envelope)).toThrow();
    });
  });

  describe('isEncrypted', () => {
    it('recognises its own envelopes and rejects plaintext', () => {
      const svc = makeService();
      expect(svc.isEncrypted(svc.encryptSecret('x'))).toBe(true);
      expect(svc.isEncrypted('sk-plaintext-key')).toBe(false);
    });
  });

  describe('maskSecret', () => {
    it('shows only the ends of a long secret', () => {
      const svc = makeService();
      expect(svc.maskSecret('sk-abcdefghijklmnop')).toBe('sk-a••••mnop');
    });

    it('reveals nothing at all about a short secret', () => {
      const svc = makeService();
      expect(svc.maskSecret('short')).toBe('••••••••');
    });
  });

  describe('password hashing', () => {
    it('verifies a correct password', () => {
      const svc = makeService();
      expect(svc.verifyPassword('correct horse', svc.hashPassword('correct horse'))).toBe(true);
    });

    it('rejects an incorrect password', () => {
      const svc = makeService();
      expect(svc.verifyPassword('wrong', svc.hashPassword('correct horse'))).toBe(false);
    });

    it('salts, so equal passwords produce different hashes', () => {
      const svc = makeService();
      expect(svc.hashPassword('same')).not.toBe(svc.hashPassword('same'));
    });

    it('never stores the password itself', () => {
      const svc = makeService();
      expect(svc.hashPassword('plaintext-password')).not.toContain('plaintext-password');
    });

    it('returns false rather than throwing on a malformed stored hash', () => {
      const svc = makeService();
      for (const bad of ['', 'nosalt', 'salt:not-hex-!!', 'salt:aabb']) {
        expect(svc.verifyPassword('x', bad)).toBe(false);
      }
    });
  });

  describe('tokens', () => {
    it('generates unique high-entropy url-safe tokens', () => {
      const svc = makeService();
      const tokens = new Set(Array.from({ length: 200 }, () => svc.generateToken()));
      expect(tokens.size).toBe(200);
      for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('hashes tokens deterministically and irreversibly', () => {
      const svc = makeService();
      const token = svc.generateToken();
      expect(svc.hashToken(token)).toBe(svc.hashToken(token));
      expect(svc.hashToken(token)).toHaveLength(64);
      expect(svc.hashToken(token)).not.toContain(token);
    });
  });
});
