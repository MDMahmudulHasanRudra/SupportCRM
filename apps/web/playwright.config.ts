import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Only local, read-only smoke checks. Credentials never enter reports or storage-state files.
try { process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch { /* CI supplies env directly. */ }
const baseURL = process.env.CRM_E2E_URL || 'http://localhost:12000';
if (!['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) {
  throw new Error('Browser smoke tests must target a local CRM instance.');
}
export default defineConfig({
  testDir: './e2e',
  outputDir: '../../data/browser-smoke/results',
  reporter: [['list'], ['json', { outputFile: '../../data/browser-smoke/report.json' }]],
  workers: 1,
  timeout: 180_000,
  use: { baseURL, browserName: 'chromium', headless: true, actionTimeout: 10_000, navigationTimeout: 20_000, screenshot: 'only-on-failure', trace: 'off' },
});
