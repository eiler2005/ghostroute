import { test, expect } from '@playwright/test';
test.skip(process.env.GHOSTROUTE_PUBLIC_DELIVERY !== '1', 'requires the authenticated public delivery runner');

test('public iPhone delivery keeps styled mobile pages and channel health', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'iPhone/WebKit contract');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/m(?:\?|$)/);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(7, 17, 31)');
  await expect(page.locator('.mobile-shell')).toBeVisible();
  expect(await page.locator('.mobile-shell').evaluate(element => getComputedStyle(element).boxSizing === 'border-box' && parseFloat(getComputedStyle(element).paddingLeft) > 0)).toBe(true);
  await page.goto('/m/live', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Client activity summary').first()).toBeVisible();
  await page.goto('/m/health', { waitUntil: 'domcontentloaded' });
  for (const channel of ['D', 'anyT', 'Snell']) {
    await expect(page.locator(`[data-channel="${channel}"]`)).toBeVisible();
  }
});

test('public desktop compressed delivery retains inline traffic detail', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop traffic workbench');
  const started = performance.now();
  const response = await page.goto('/traffic', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Flow Explorer').first()).toBeVisible();
  expect(response?.ok()).toBe(true);
  const elapsed = performance.now() - started;
  await testInfo.attach('public-document-timing', { body: JSON.stringify({ path: '/traffic', elapsed_ms: elapsed, encoding: response?.headers()['content-encoding'] || 'identity' }), contentType: 'application/json' });
  expect(elapsed).toBeLessThan(2500);
  if (await page.getByText('No traffic rows', { exact: true }).isVisible()) return;
  await expect(page.locator('.flow-detail-panel')).toBeVisible();
  await expect(page.locator('.flow-detail-panel')).toContainText('Why this route?');
});
