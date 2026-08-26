import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/** Version tag on every ciphertext, so the format can change later without ambiguity. */
const ENVELOPE_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce — the size GCM is specified for
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 64;

/**
 * Every cryptographic primitive the application uses, in one auditable place.
 *
 * Three distinct jobs, deliberately not interchangeable:
 *  - `encryptSecret`/`decryptSecret` — reversible AES-256-GCM for values the system must read back
 *    (AI provider API keys, the gateway API key). `PROJECT_SPEC.md` §22, §109, §177.
 *  - `hashPassword`/`verifyPassword` — one-way scrypt for user passwords, never reversible.
 *  - `hashToken` — fast SHA-256 for high-entropy session secrets. Correct precisely BECAUSE the
 *    input is 256 random bits: there is nothing to brute-force, so a slow KDF would only add
 *    latency to every authenticated request.
 *
 * scrypt is used over argon2 to stay on Node's built-in `crypto` — no native module to compile,
 * which keeps `pnpm install` working identically on the Windows dev machine and the Linux VPS.
 */
@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(private readonly config: ConfigService) {
    const raw = this.config.getOrThrow<string>('security.secretEncryptionKey');
    this.masterKey = CryptoService.parseMasterKey(raw);
  }

  /**
   * Accepts base64 (the documented format) or 64 hex characters. Anything that does not decode to
   * exactly 32 bytes is rejected at construction, so a truncated key fails at boot rather than
   * producing ciphertext nobody can decrypt later.
   */
  static parseMasterKey(raw: string): Buffer {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      const hex = Buffer.from(raw, 'hex');
      if (hex.length === KEY_BYTES) return hex;
    }

    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === KEY_BYTES) return b64;

    throw new Error(
      `SECRET_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (base64 or 64 hex chars). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  /**
   * Returns `v1:<iv>:<authTag>:<ciphertext>`, all base64.
   *
   * `aad` binds the ciphertext to a context string (for example `ai_provider:<id>:apiKey`). A row
   * copied into a different record fails to decrypt instead of silently working, which turns a
   * database-level tamper into a loud error.
   */
  encryptSecret(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  /** Throws on any tampering, wrong key, or mismatched `aad` — GCM authenticates, it does not guess. */
  decryptSecret(envelope: string, aad?: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw new Error('Malformed encrypted value: expected "v1:<iv>:<tag>:<ciphertext>"');
    }

    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');

    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('Malformed encrypted value: bad IV or auth tag length');
    }

    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** True if the string looks like one of our envelopes — used to avoid double-encrypting on update. */
  isEncrypted(value: string): boolean {
    return value.startsWith(`${ENVELOPE_VERSION}:`) && value.split(':').length === 4;
  }

  /**
   * A display-safe fingerprint of a secret: never the secret, but stable enough that an admin can
   * confirm which key is configured. `PROJECT_SPEC.md` §113 (never expose secrets).
   */
  maskSecret(plaintext: string): string {
    if (plaintext.length <= 8) return '••••••••';
    return `${plaintext.slice(0, 4)}••••${plaintext.slice(-4)}`;
  }

  /** Stored as `salt:hash`, both hex. */
  hashPassword(password: string): string {
    const salt = randomBytes(SCRYPT_SALT_BYTES).toString('hex');
    const hash = scryptSync(password, salt, SCRYPT_KEY_BYTES).toString('hex');
    return `${salt}:${hash}`;
  }

  /** Constant-time. Returns false (never throws) on a malformed stored value. */
  verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;

    let expected: Buffer;
    try {
      expected = Buffer.from(hash, 'hex');
    } catch {
      return false;
    }
    if (expected.length !== SCRYPT_KEY_BYTES) return false;

    const candidate = scryptSync(password, salt, SCRYPT_KEY_BYTES);
    return timingSafeEqual(candidate, expected);
  }

  /** 256 bits of entropy, URL-safe. Used for session secrets and future API keys. */
  generateToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** SHA-256 hex. Only ever applied to high-entropy tokens — never to a password. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
