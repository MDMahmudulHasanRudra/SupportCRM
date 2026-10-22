import { expect, test, type Cookie } from '@playwright/test';
import { NAVIGATION } from '../src/navigation';

// Screenshots are taken explicitly only for ordinary pages below, never for sign-in or QR flows.
test.use({ screenshot: 'off', trace: 'off' });

let cookies: Cookie[] = [];
test.beforeAll(async ({ playwright, baseURL }) => {
  const password = process.env.CRM_E2E_PASSWORD || process.env.SEED_ADMIN_PASSWORD;
  if (!password) throw new Error('Set CRM_E2E_PASSWORD or SEED_ADMIN_PASSWORD for a local test account.');
  const api = await playwright.request.newContext({ baseURL });
  const response = await api.post('/api/v1/auth/login', {
    data: { identifier: process.env.CRM_E2E_USERNAME || process.env.SEED_ADMIN_USERNAME || 'admin', password },
  });
  expect(response.status(), 'Local test account must sign in').toBe(200);
  cookies = (await api.storageState()).cookies;
  await api.dispose();
});
test.beforeEach(async ({ context }) => { await context.addCookies(cookies); });

for (const theme of ['light', 'dark']) for (const width of [375, 768, 1280, 1440]) {
  test(`${theme} workspace at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await page.addInitScript(value => localStorage.setItem('support-crm:theme', value), theme);
    const errors: string[] = [];
    const failures: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().includes('/api/v1/') && response.status() >= 400 && !response.url().includes('/health')) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    for (const destination of NAVIGATION) {
      await test.step(destination.label, async () => {
        console.log(`${theme} ${width}px: ${destination.to}`);
        await page.goto(destination.to);
        await expect(page.locator('#main-content')).toBeVisible();
        await expect(page.locator('#main-content h1')).toBeVisible();
        await expect(page.locator('#main-content .progress .spinner, #main-content .skeleton')).toHaveCount(0, { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth), `${destination.to} page overflow`).toBeLessThanOrEqual(width + 1);
        if ([375, 1440].includes(width) && ['/', '/conversations', '/channels/whatsapp', '/billing', '/team', '/reports'].includes(destination.to)) {
          await page.screenshot({ path: testInfo.outputPath(`${destination.to.replaceAll('/', '_') || 'overview'}.png`), fullPage: true });
        }
      });
    }
    expect(errors, 'No uncaught React/browser errors').toEqual([]);
    expect(failures, 'Page data loads without API errors').toEqual([]);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Find a page' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search available pages' }).fill('WhatsApp');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/channels\/whatsapp$/);
    await expect(page.getByRole('dialog', { name: 'Find a page' })).toHaveCount(0);
    if (width <= 860) {
      await page.getByRole('button', { name: 'Toggle navigation' }).click();
      const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
      await expect(drawer).toBeVisible();
      await drawer.getByRole('link', { name: 'Overview', exact: true }).click();
      await expect(drawer).toHaveCount(0);
      await expect(page).toHaveURL(/\/$/);
    }
    await page.goto('/channels/whatsapp');
    await page.getByRole('button', { name: /Add WhatsApp account/i }).click();
    await expect(page.locator('#whatsapp-account-name')).toBeFocused();
  });
}

test.describe('Sign-in acceptance', () => {
  test('signs in through the web form and preserves the selected theme', async ({ page, context }) => {
    await context.clearCookies();
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto('/login');
    await page.getByLabel('Username or email').fill(process.env.CRM_E2E_USERNAME || process.env.SEED_ADMIN_USERNAME || 'admin');
    await page.getByLabel('Password', { exact: true }).fill(process.env.CRM_E2E_PASSWORD || process.env.SEED_ADMIN_PASSWORD || '');
    await page.getByRole('button', { name: 'Sign in to workspace' }).click();
    await expect(page.locator('#main-content h1')).toHaveText('Overview');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('Optional real gateway acceptance', () => {
  // A QR is a credential: no screenshots, traces, payload logging or phone scan in automation.
  test('real gateway QR can be requested and rendered from the web app', async ({ page }) => {
    test.skip(process.env.CRM_E2E_PAIRING !== '1', 'Opt in explicitly on a fresh local workspace.');
    const overview = await page.request.get('/api/v1/channels/whatsapp/accounts/overview');
    expect(overview.ok()).toBeTruthy();
    const accounts = await overview.json();
    test.skip(accounts.items.length !== 0, 'Never alter an existing phone account for a smoke test.');
    await page.goto('/channels/whatsapp');
    await page.locator('#whatsapp-account-name').fill('Support WhatsApp');
    const connecting = page.waitForResponse(r => r.url().endsWith('/accounts/connect') && r.request().method() === 'POST', { timeout: 90_000 });
    await page.getByRole('button', { name: 'Get QR code' }).click();
    const response = await connecting;
    expect(response.status(), 'Gateway must accept the account connection').toBe(201);
    const account = await response.json();
    try {
      const qr = page.getByRole('img', { name: 'WhatsApp pairing code' });
      await expect(qr).toBeVisible({ timeout: 90_000 });
      expect(await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth >= 200)).toBe(true);
      const state = await page.request.get(`/api/v1/channels/whatsapp/accounts/${account.id}/qr`);
      expect(state.ok()).toBeTruthy();
      const result = await state.json();
      expect(result.available && Boolean(result.qr)).toBe(true);
      expect(result.state).not.toBe('CONNECTED'); // No phone has been scanned.
    } finally {
      // Keep the CRM account/history for the owner, stop the unpaired test session.
      const stopped = await page.request.post(`/api/v1/channels/whatsapp/accounts/${account.id}/disconnect`);
      expect(stopped.ok(), 'Stop the unpaired validation session').toBeTruthy();
    }
  });
});
