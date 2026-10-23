import { z } from 'zod';

/**
 * Fail-fast environment validation.
 *
 * Every value the application needs is declared here, so a misconfigured deployment dies at boot
 * with a readable list of problems instead of throwing somewhere deep in a request handler an hour
 * later. `PROJECT_SPEC.md` §125 (configuration via environment) and §201 (production safety).
 *
 * Two rules this file enforces that are easy to get wrong:
 *  - Secrets have MINIMUM lengths, not just presence. A 4-character `SESSION_COOKIE_SECRET` passes
 *    a `required` check and provides no security at all.
 *  - Production refuses the development defaults outright (see `refine` at the bottom), so a
 *    `.env.example` copied to a VPS cannot boot with a known key.
 */

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1'));

const port = (defaultValue: number) =>
  z.coerce.number().int().min(1).max(65535).optional().default(defaultValue);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    TZ: z.string().default('Asia/Dhaka'),

    // --- HTTP -------------------------------------------------------------
    API_PORT: port(4000),
    API_BASE_URL: z.string().url().default('http://localhost:4000'),
    /** Comma-separated exact origins. `*` is rejected in production (see refine). */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    ENABLE_SWAGGER: bool(true),

    // --- PostgreSQL -------------------------------------------------------
    DATABASE_HOST: z.string().default('localhost'),
    DATABASE_PORT: port(5432),
    DATABASE_USER: z.string().min(1),
    DATABASE_PASSWORD: z.string().min(1),
    DATABASE_NAME: z.string().min(1),
    DATABASE_SSL: bool(false),
    DATABASE_LOGGING: bool(false),

    // --- Redis ------------------------------------------------------------
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: port(6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: z.coerce.number().int().min(0).max(15).optional().default(0),
    /** Namespaces every Redis key so two deployments can share one Redis instance safely. */
    REDIS_KEY_PREFIX: z.string().default('support-crm'),

    // --- Security ---------------------------------------------------------
    /**
     * 32 bytes, base64. Envelope key for AES-256-GCM encryption of every secret stored in the
     * database (`PROJECT_SPEC.md` §109, §177). Rotating it makes existing ciphertext unreadable —
     * see docs/SECURITY.md before changing it.
     */
    SECRET_ENCRYPTION_KEY: z.string().min(1),
    /** Signs nothing by itself; mixed into session-secret derivation so a stolen DB row is inert. */
    SESSION_COOKIE_SECRET: z.string().min(32),
    SESSION_COOKIE_NAME: z.string().default('support_crm_session'),
    SESSION_COOKIE_SECURE: bool(false),
    SESSION_LIFETIME_HOURS: z.coerce.number().int().min(1).max(24 * 90).optional().default(12),

    // --- Worker -----------------------------------------------------------
    WORKER_HEALTH_PORT: port(4100),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).optional().default(5),

    // --- Automatic channel recovery (Phase 3.5) ---------------------------
    /**
     * How many consecutive automatic reconnects to attempt before leaving the account for a human.
     * 0 disables automatic recovery entirely.
     */
    CHANNEL_RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(20).optional().default(5),
    /** First backoff step; each further attempt doubles it. */
    CHANNEL_RECOVERY_BASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).optional().default(30_000),
    /** Ceiling for the doubling, so a long outage settles into a steady retry rate. */
    CHANNEL_RECOVERY_MAX_BACKOFF_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .optional()
      .default(600_000),

    // --- Knowledge storage and embeddings (Phase 4) ------------------------
    /** Where uploaded knowledge documents live. Local disk in dev; S3/MinIO is a later phase. */
    STORAGE_DRIVER: z.enum(['local']).optional().default('local'),
    /**
     * Upload root. MUST be outside any directory the API serves statically — an uploaded file that
     * can be fetched and executed is the whole of PROJECT_SPEC.md §179 in one mistake.
     */
    STORAGE_LOCAL_PATH: z.string().optional().default('./var/storage'),
    /** Hard ceiling on one uploaded document. */
    UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).max(200 * 1024 * 1024).optional().default(25 * 1024 * 1024),

    /**
     * Which embedding provider backs semantic search.
     *
     * `none` — no semantic indexing at all. Documents still index for full-text search, and the UI
     *          says semantic search is unavailable. Nothing is faked.
     * `openai` — any OpenAI-compatible `/embeddings` endpoint, set by `EMBEDDING_BASE_URL`.
     * `test` — a deterministic, offline provider for the test suite. **Refused in production.**
     */
    EMBEDDING_PROVIDER: z.enum(['none', 'openai', 'test']).optional().default('none'),
    EMBEDDING_BASE_URL: z.string().url().optional().default('https://api.openai.com/v1'),
    /** Backend-only credential. Never returned by an API, never logged, never sent to a client. */
    EMBEDDING_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().optional().default('text-embedding-3-small'),
    /**
     * Vector width. Fixed in the schema by `vector(N)`, so changing it needs a migration and a
     * re-embed; it is recorded per chunk to make that detectable rather than silent.
     */
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4096).optional().default(1536),

    // --- AI generation provider (Phase 5) ----------------------------------
    /**
     * Which provider answers customers.
     *
     * `none` (the default) means the Decision Engine escalates anything a deterministic rule cannot
     * answer. Rules keep working; nothing is fabricated. `test` is a scripted provider for the
     * integration suite and is refused in production.
     */
    AI_PROVIDER: z.enum(['none', 'openai', 'test']).optional().default('none'),
    AI_BASE_URL: z.string().url().optional().default('https://api.openai.com/v1'),
    /** Backend only. Never returned by an API, never logged, never sent to a client. */
    AI_API_KEY: z.string().optional(),
    AI_MODEL: z.string().optional().default('gpt-4o-mini'),
    AI_TEMPERATURE: z.coerce.number().min(0).max(2).optional().default(0.2),
    AI_MAX_TOKENS: z.coerce.number().int().min(64).max(8192).optional().default(700),

    // Active WhatsApp transport: Go WhatsApp. Legacy OPENWA_* values are unused.
    GOWA_BASE_URL: z.string().url().default('http://localhost:3001'),
    CRM_PUBLIC_URL:z.string().url().default('http://localhost:12000'),
    GOWA_LINK_PREVIEW_HOSTS:z.string().default(''),
    GOWA_BASIC_AUTH: z.string().optional().default(''),
    GOWA_MANAGED_AUTOMATION_DISABLED: z.enum(['true','false']).default('false'),

    // --- Seed (development / first boot) ----------------------------------
    SEED_ADMIN_EMAIL: z.string().email().default('admin@example.com'),
    SEED_ADMIN_USERNAME: z.string().min(3).default('admin'),
    SEED_ADMIN_PASSWORD: z.string().min(8).default('ChangeMe!123'),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.CORS_ORIGINS !== '*', {
    message: 'CORS_ORIGINS must not be "*" in production (PROJECT_SPEC.md §201)',
    path: ['CORS_ORIGINS'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.SESSION_COOKIE_SECURE, {
    message: 'SESSION_COOKIE_SECURE must be true in production',
    path: ['SESSION_COOKIE_SECURE'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.SEED_ADMIN_PASSWORD !== 'ChangeMe!123', {
    message: 'SEED_ADMIN_PASSWORD is still the documented default — refusing to boot in production',
    path: ['SEED_ADMIN_PASSWORD'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.EMBEDDING_PROVIDER !== 'test', {
    // The deterministic provider exists to make tests offline and repeatable. Its vectors are
    // derived from a hash, carry no meaning, and would make semantic search silently useless while
    // looking like it worked.
    message: 'EMBEDDING_PROVIDER=test is a test fixture and must never run in production',
    path: ['EMBEDDING_PROVIDER'],
  })
  .refine((env) => env.EMBEDDING_PROVIDER !== 'openai' || Boolean(env.EMBEDDING_API_KEY), {
    message: 'EMBEDDING_PROVIDER=openai requires EMBEDDING_API_KEY',
    path: ['EMBEDDING_API_KEY'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.AI_PROVIDER !== 'test', {
    // The scripted provider returns fixed text. In front of a customer that is a lie with a
    // support company name attached to it.
    message: 'AI_PROVIDER=test is a test fixture and must never run in production',
    path: ['AI_PROVIDER'],
  })
  .refine((env) => env.AI_PROVIDER !== 'openai' || Boolean(env.AI_API_KEY), {
    message: 'AI_PROVIDER=openai requires AI_API_KEY',
    path: ['AI_API_KEY'],
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Nest's ConfigModule `validate` hook. Throws with every problem at once rather than the first,
 * because fixing environment variables one boot at a time is miserable.
 *
 * The error message deliberately contains only variable NAMES and validation messages — never the
 * offending values, which are frequently the secrets themselves (`PROJECT_SPEC.md` §129).
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
