import type { Env } from './env.validation';

/**
 * Typed configuration tree derived from the validated environment.
 *
 * Application code reads `configService.get('database.host')` and never `process.env` directly, so
 * there is exactly one place where an environment variable name appears (`env.validation.ts`) and
 * exactly one place where it is shaped (here).
 */
export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  timezone: string;
  http: {
    port: number;
    publicUrl:string;
    baseUrl: string;
    corsOrigins: string[];
    enableSwagger: boolean;
  };
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    name: string;
    ssl: boolean;
    logging: boolean;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
    keyPrefix: string;
  };
  security: {
    secretEncryptionKey: string;
    sessionCookieSecret: string;
    sessionCookieName: string;
    sessionCookieSecure: boolean;
    sessionLifetimeHours: number;
  };
  worker: {
    healthPort: number;
    concurrency: number;
  };
  channelRecovery: {
    maxAttempts: number;
    baseMs: number;
    maxBackoffMs: number;
  };
  storage: {
    driver: 'local';
    localPath: string;
    uploadMaxBytes: number;
  };
  embedding: {
    provider: 'none' | 'openai' | 'test';
    baseUrl: string;
    apiKey?: string;
    model: string;
    dimensions: number;
  };
  ai: {
    provider: 'none' | 'openai' | 'test';
    baseUrl: string;
    apiKey?: string;
    model: string;
    temperature: number;
    maxTokens: number;
    systemPrompt?: string;
    /** Test-only: drives the scripted provider. Never set outside the suite. */
    testScript?: Record<string, unknown>;
  };
  gowa: { baseUrl:string; basicAuth:string; managedAutomationDisabled:boolean; linkPreviewHosts:string[] };
  seed: {
    adminEmail: string;
    adminUsername: string;
    adminPassword: string;
  };
}

export function configuration(): AppConfig {
  // Safe: ConfigModule runs `validateEnv` before this factory, so every value below is present and
  // already coerced to the right type by the schema.
  const env = process.env as unknown as Env;

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    timezone: env.TZ,
    http: {
      port: Number(env.API_PORT),
      baseUrl: env.API_BASE_URL,
      publicUrl:env.CRM_PUBLIC_URL??'http://localhost:12000',
      corsOrigins: String(env.CORS_ORIGINS)
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      enableSwagger: asBool(env.ENABLE_SWAGGER, true),
    },
    database: {
      host: env.DATABASE_HOST,
      port: Number(env.DATABASE_PORT),
      username: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD,
      name: env.DATABASE_NAME,
      ssl: asBool(env.DATABASE_SSL, false),
      logging: asBool(env.DATABASE_LOGGING, false),
    },
    redis: {
      host: env.REDIS_HOST,
      port: Number(env.REDIS_PORT),
      password: env.REDIS_PASSWORD || undefined,
      db: Number(env.REDIS_DB),
      keyPrefix: env.REDIS_KEY_PREFIX,
    },
    security: {
      secretEncryptionKey: env.SECRET_ENCRYPTION_KEY,
      sessionCookieSecret: env.SESSION_COOKIE_SECRET,
      sessionCookieName: env.SESSION_COOKIE_NAME,
      sessionCookieSecure: asBool(env.SESSION_COOKIE_SECURE, false),
      sessionLifetimeHours: Number(env.SESSION_LIFETIME_HOURS),
    },
    worker: {
      healthPort: Number(env.WORKER_HEALTH_PORT),
      concurrency: Number(env.WORKER_CONCURRENCY),
    },
    channelRecovery: {
      maxAttempts: Number(env.CHANNEL_RECOVERY_MAX_ATTEMPTS),
      baseMs: Number(env.CHANNEL_RECOVERY_BASE_MS),
      maxBackoffMs: Number(env.CHANNEL_RECOVERY_MAX_BACKOFF_MS),
    },
    storage: {
      driver: env.STORAGE_DRIVER,
      localPath: env.STORAGE_LOCAL_PATH,
      uploadMaxBytes: Number(env.UPLOAD_MAX_BYTES),
    },
    embedding: {
      provider: env.EMBEDDING_PROVIDER,
      baseUrl: env.EMBEDDING_BASE_URL,
      apiKey: env.EMBEDDING_API_KEY || undefined,
      model: env.EMBEDDING_MODEL,
      dimensions: Number(env.EMBEDDING_DIMENSIONS),
    },
    ai: {
      provider: env.AI_PROVIDER,
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY || undefined,
      model: env.AI_MODEL,
      temperature: Number(env.AI_TEMPERATURE),
      maxTokens: Number(env.AI_MAX_TOKENS),
    },
    gowa: { baseUrl:env.GOWA_BASE_URL??'http://localhost:3001',basicAuth:env.GOWA_BASIC_AUTH??'',managedAutomationDisabled:env.GOWA_MANAGED_AUTOMATION_DISABLED==='true',linkPreviewHosts:String(env.GOWA_LINK_PREVIEW_HOSTS??'').split(',').map(host=>host.trim().toLowerCase()).filter(Boolean) },
    seed: {
      adminEmail: env.SEED_ADMIN_EMAIL,
      adminUsername: env.SEED_ADMIN_USERNAME,
      adminPassword: env.SEED_ADMIN_PASSWORD,
    },
  };
}

/**
 * Zod's transform produces a real boolean, but when the process is started without going through
 * the schema (a bare `ts-node` script, a test harness) the value is still the raw string. Accept
 * both rather than silently treating the string `"false"` as truthy.
 */
function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}
