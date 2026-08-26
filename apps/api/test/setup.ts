import 'reflect-metadata';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import cookieParser from 'cookie-parser';

/**
 * Integration harness. Boots the real application against the real Postgres and Redis started by
 * `docker-compose.test.yml`.
 *
 * Deliberately NOT mocked. `PROJECT_SPEC.md` §210 requires production paths to exercise a real
 * database and a real queue, and the properties these tests verify — unique constraints, partial
 * indexes, distributed locks, transactional job creation — do not exist in a mock.
 */

// Point the process at the test stack BEFORE anything reads configuration.
process.env.NODE_ENV = 'test';
process.env.DATABASE_HOST = process.env.TEST_DATABASE_HOST ?? 'localhost';
process.env.DATABASE_PORT = process.env.TEST_DATABASE_PORT ?? '55432';
process.env.DATABASE_USER = 'support_crm_test';
process.env.DATABASE_PASSWORD = 'support_crm_test';
process.env.DATABASE_NAME = 'support_crm_test';
process.env.REDIS_HOST = process.env.TEST_REDIS_HOST ?? 'localhost';
process.env.REDIS_PORT = process.env.TEST_REDIS_PORT ?? '56379';
// Namespaced so a test run can never collide with a developer's local dev stack in the same Redis.
process.env.REDIS_KEY_PREFIX = 'support-crm-test';
process.env.SECRET_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_COOKIE_SECRET ??= 'test-session-cookie-secret-at-least-32-chars';
process.env.SESSION_COOKIE_SECURE = 'false';
process.env.ENABLE_SWAGGER = 'false';
process.env.SEED_ADMIN_PASSWORD ??= 'TestAdmin!123';
// Integration tests always run the full graph INCLUDING the queue consumer, so a job enqueued in a
// test is actually processed. JobsModule reads this at module-definition time, which happens on the
// `require` below — setting it in a beforeAll would be too late.
process.env.RUN_MODE = 'worker';

// Phase 4. The deterministic embedding provider makes semantic search testable offline and
// repeatably — and `env.validation.ts` refuses it outside a non-production environment, which is
// exactly the guarantee that keeps it a fixture rather than a fallback.
process.env.EMBEDDING_PROVIDER ??= 'test';
// Uploads land in a scratch directory the suite owns, never in the repository.
process.env.STORAGE_LOCAL_PATH ??= join(tmpdir(), 'support-crm-test-storage');

// Deliberately `require`, not a top-level `import`: the env assignments above must run BEFORE the
// module graph is evaluated, and ES import hoisting would defeat that.
const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
const { applyBodyParsers } = require('../src/common/http/body-parsers') as typeof import('../src/common/http/body-parsers');

export interface TestContext {
  app: INestApplication;
  dataSource: DataSource;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  // Mirror main.ts exactly — a test that runs without the global pipes would pass while production,
  // with validation and stripping in force, behaves differently.
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  // The SAME parser wiring production uses. Without it every signed webhook fails verification,
  // because the raw bytes the HMAC covers were never captured.
  applyBodyParsers(app);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const dataSource = app.get(DataSource);
  await dataSource.runMigrations({ transaction: 'each' });

  return { app, dataSource };
}

/**
 * Empties every table between suites.
 *
 * `TRUNCATE ... CASCADE` rather than dropping and re-migrating: it is far faster, and it keeps the
 * schema — including the partial unique indexes — exactly as a migration produced it, which is the
 * thing under test.
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const tables = await dataSource.query<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
  );
  if (tables.length === 0) return;

  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await dataSource.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function closeTestApp(context: TestContext): Promise<void> {
  await context.app.close();
}

/** Extracts a Set-Cookie value by name from a supertest response. */
export function extractCookie(setCookieHeader: string[] | undefined, name: string): string | null {
  if (!setCookieHeader) return null;
  for (const raw of setCookieHeader) {
    const [pair] = raw.split(';');
    const [key, ...rest] = pair.split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** Waits for `predicate`, polling — used to observe an asynchronous worker without a fixed sleep. */
export async function waitFor<T>(
  predicate: () => Promise<T | null | undefined | false>,
  { timeoutMs = 20000, intervalMs = 200, description = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last as T;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}
