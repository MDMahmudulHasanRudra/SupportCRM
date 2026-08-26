/**
 * Unit tests: pure logic only. No Postgres, no Redis, no network.
 * Anything needing real infrastructure belongs in jest.integration.config.js.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
};
