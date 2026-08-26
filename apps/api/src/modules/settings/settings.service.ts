import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Setting, SettingValueType } from './entities/setting.entity';

/**
 * Feature flags (`PROJECT_SPEC.md` §124).
 *
 * Every flag defaults to OFF for anything that can send a message or spend money. A feature that
 * silently defaults on is a feature nobody consciously enabled.
 */
export const FEATURE_FLAGS = {
  AI_ENABLED: 'feature.ai_enabled',
  AUTOMATION_ENABLED: 'feature.automation_enabled',
  BROADCAST_ENABLED: 'feature.broadcast_enabled',
  BULK_MEMBER_OPERATIONS_ENABLED: 'feature.bulk_member_operations_enabled',
  AI_GENERATED_AUTOMATION_ENABLED: 'feature.ai_generated_automation_enabled',
  AI_AUTO_ACTIVATION_ENABLED: 'feature.ai_auto_activation_enabled',
  EXTERNAL_AI_API_ENABLED: 'feature.external_ai_api_enabled',
} as const;

/**
 * The global kill switches (`PROJECT_SPEC.md` §37).
 *
 * Separate from feature flags on purpose: a feature flag says "this capability is not built out for
 * us"; an emergency stop says "stop RIGHT NOW". They are read at different points and audited
 * differently, and collapsing them would make an emergency stop look like a configuration change.
 */
export const EMERGENCY_STOPS = {
  ALL_AI_PAUSED: 'emergency.all_ai_paused',
  ALL_AUTOMATION_PAUSED: 'emergency.all_automation_paused',
  OUTGOING_MESSAGES_STOPPED: 'emergency.outgoing_messages_stopped',
  BROADCAST_DISABLED: 'emergency.broadcast_disabled',
  BULK_OPERATIONS_PAUSED: 'emergency.bulk_operations_paused',
} as const;

/**
 * Settings keys that may never be written through the settings API.
 *
 * These are infrastructure credentials, not product configuration. Allowing an administrator with
 * `settings.manage` to set the WhatsApp gateway's API key would put an internal credential behind a
 * user-facing form — exactly the boundary `docs/WHATSAPP_UX_ARCHITECTURE.md` §3 draws. They come
 * from the environment and change by redeploying.
 */
export const INFRASTRUCTURE_ONLY_KEYS: readonly string[] = ['openwa.api_key'];

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Setting) private readonly repo: Repository<Setting>,
    private readonly crypto: CryptoService,
  ) {}

  /** Typed read with a fallback. An unset key is not an error — the default is the answer. */
  async get<T = string>(key: string, defaultValue: T): Promise<T> {
    const setting = await this.repo.findOne({ where: { key } });
    if (!setting || setting.value === null) return defaultValue;
    return this.deserialize(setting) as T;
  }

  async getBoolean(key: string, defaultValue = false): Promise<boolean> {
    return this.get<boolean>(key, defaultValue);
  }

  async isFeatureEnabled(flag: string): Promise<boolean> {
    return this.getBoolean(flag, false);
  }

  /** True when the named emergency stop is engaged. Checked before anything is sent. */
  async isStopped(stop: string): Promise<boolean> {
    return this.getBoolean(stop, false);
  }

  /**
   * Reads a secret in plaintext. **Server-side only** — never call this from anything that
   * serialises its result into an HTTP response.
   */
  async getSecret(key: string): Promise<string | null> {
    const setting = await this.repo.findOne({ where: { key } });
    if (!setting?.value) return null;
    if (setting.valueType !== SettingValueType.SECRET) return setting.value;
    return this.crypto.decryptSecret(setting.value, `setting:${key}`);
  }

  /**
   * Writes a value. Returns the previous state so the caller can pass it to `AuditService` as
   * `before` — a settings change without a before/after is not auditable (`PROJECT_SPEC.md` §107).
   */
  async set(
    key: string,
    value: unknown,
    options: { valueType?: SettingValueType; category?: string; description?: string; updatedById?: string | null } = {},
  ): Promise<{ before: unknown; after: unknown }> {
    if (INFRASTRUCTURE_ONLY_KEYS.includes(key)) {
      throw new ForbiddenException(
        `"${key}" is server configuration and cannot be changed from the application. ` +
          'It is set through the deployment environment.',
      );
    }

    const existing = await this.repo.findOne({ where: { key } });
    const valueType = options.valueType ?? existing?.valueType ?? inferType(value);

    const before = existing
      ? existing.valueType === SettingValueType.SECRET
        ? '[SET]'
        : this.deserialize(existing)
      : null;

    const stored =
      valueType === SettingValueType.SECRET
        ? this.crypto.encryptSecret(String(value), `setting:${key}`)
        : serialize(value, valueType);

    await this.repo.save(
      this.repo.create({
        key,
        value: stored,
        valueType,
        category: options.category ?? existing?.category ?? 'general',
        description: options.description ?? existing?.description ?? null,
        // A secret is never public, whatever the caller asks for.
        isPublic: valueType !== SettingValueType.SECRET,
        updatedById: options.updatedById ?? null,
      }),
    );

    return { before, after: valueType === SettingValueType.SECRET ? '[SET]' : value };
  }

  /**
   * Everything an authenticated admin may see.
   *
   * Secrets are included as metadata with `isSet` but never a value — an operator needs to know
   * whether a key is configured without being shown it (`PROJECT_SPEC.md` §113).
   */
  async listPublic(): Promise<
    Array<{ key: string; value: unknown; valueType: SettingValueType; category: string; description: string | null; isSet: boolean }>
  > {
    const all = await this.repo.find({ order: { category: 'ASC', key: 'ASC' } });
    return all.map((setting) => ({
      key: setting.key,
      value: setting.valueType === SettingValueType.SECRET ? null : this.deserialize(setting),
      valueType: setting.valueType,
      category: setting.category,
      description: setting.description,
      isSet: setting.value !== null && setting.value !== '',
    }));
  }

  async delete(key: string): Promise<void> {
    const result = await this.repo.delete({ key });
    if (!result.affected) throw new NotFoundException(`Setting "${key}" not found`);
  }

  private deserialize(setting: Setting): unknown {
    if (setting.value === null) return null;
    switch (setting.valueType) {
      case SettingValueType.BOOLEAN:
        return setting.value === 'true';
      case SettingValueType.NUMBER:
        return Number(setting.value);
      case SettingValueType.JSON:
        try {
          return JSON.parse(setting.value);
        } catch {
          // A malformed JSON setting must not crash every reader of the settings table.
          return null;
        }
      case SettingValueType.SECRET:
        return null;
      default:
        return setting.value;
    }
  }
}

function inferType(value: unknown): SettingValueType {
  if (typeof value === 'boolean') return SettingValueType.BOOLEAN;
  if (typeof value === 'number') return SettingValueType.NUMBER;
  if (value !== null && typeof value === 'object') return SettingValueType.JSON;
  return SettingValueType.STRING;
}

function serialize(value: unknown, valueType: SettingValueType): string {
  if (valueType === SettingValueType.JSON) return JSON.stringify(value);
  return String(value);
}
