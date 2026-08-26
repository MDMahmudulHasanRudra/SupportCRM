/**
 * Integration tests: run against a REAL Postgres and a REAL Redis.
 * Start them with `pnpm test:infra:up` from the repository root first.
 * Serial by design (--runInBand) — they share one database.
 *
 * Run through `pnpm test:integration`, which sets `--experimental-vm-modules`: the PDF parser is
 * ESM-only and loads pdf.js lazily, which Jest's VM cannot do without that flag. Production is a
 * plain Node process and needs nothing.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.integration-spec.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 60000,
  clearMocks: true,
  // BullMQ workers hold blocking Redis connections that outlive app.close(). The app IS shut down
  // properly in afterAll; this stops Jest hanging on the sockets ioredis keeps for reconnection.
  forceExit: true,
};
