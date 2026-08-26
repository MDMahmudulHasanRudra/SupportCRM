import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';

/**
 * Runs pending migrations and exits.
 *
 * A compiled entrypoint rather than the TypeORM CLI, because the production image has no
 * TypeScript toolchain. It is the `migrate` compose service's first command
 * (`PROJECT_SPEC.md` §152: migrations, never a destructive reset).
 */
async function migrate(): Promise<void> {
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  try {
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    if (applied.length === 0) {
      console.log('[migrate] schema already up to date');
    } else {
      for (const migration of applied) console.log(`[migrate] applied ${migration.name}`);
    }
  } finally {
    await dataSource.destroy();
  }
}

migrate().catch((error) => {
  console.error('[migrate] failed', error);
  process.exit(1);
});
