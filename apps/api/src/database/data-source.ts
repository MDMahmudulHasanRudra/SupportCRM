import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { join } from 'node:path';

// The TypeORM CLI runs outside Nest, so it never sees ConfigModule. Load the same .env by hand.
//
// The path is resolved from this file rather than from the working directory. `dotenv` defaults to
// `${cwd}/.env`, and the CLI runs with the working directory set to `apps/api`, where there is no
// .env — so the defaults below took over and every migration command failed to authenticate. The
// environment lives at the repository root, next to `docker-compose.yml`, and that is what is
// loaded here.
loadEnv({ path: join(__dirname, '..', '..', '..', '..', '.env') });

/**
 * DataSource used by the TypeORM CLI for migration generate/run/revert.
 *
 * `synchronize` is false here and everywhere else, permanently. `PROJECT_SPEC.md` §152 forbids
 * destructive resets as a deployment strategy and §204 requires reviewed, tested, reversible
 * migrations — `synchronize: true` is incompatible with both, because it silently alters production
 * schema from whatever the entity files happen to say.
 *
 * Globs rather than an explicit import list: entities live beside their modules, and an explicit
 * list is one more place to forget a new entity — which fails at runtime, not at compile time.
 */
export const dataSourceOptions = {
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  username: process.env.DATABASE_USER ?? 'support_crm',
  password: process.env.DATABASE_PASSWORD ?? 'support_crm',
  database: process.env.DATABASE_NAME ?? 'support_crm',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  /*
   * Pin the database session to the application's timezone.
   *
   * The application runs with `TZ` set (Asia/Dhaka in this deployment) and Node computes day
   * boundaries in that zone. Postgres, left alone, runs `Etc/UTC` — so `date_trunc('day', now())`
   * in SQL and `new Date(y, m, d)` in Node disagreed by six hours, and "today" meant two different
   * things depending on which one produced a figure. For a Dhaka team that made every "today"
   * count computed in SQL wrong between midnight and 6am, on screens sitting next to ones that
   * were right.
   *
   * Setting it on the connection rather than converting at each call site means there is one
   * definition of a day, and a query added later inherits it instead of having to remember.
   */
  extra: { options: `-c timezone=${process.env.TZ ?? 'UTC'}` },
  synchronize: false,
  migrationsRun: false,
  logging: process.env.DATABASE_LOGGING === 'true',
  entities: [join(__dirname, '..', 'modules', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
};

export default new DataSource(dataSourceOptions);
