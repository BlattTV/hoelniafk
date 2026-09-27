import { expect, test, type Page } from '@playwright/test';

const PAGES = ['/', '/matrix', '/sessions', '/chat', '/inbox', '/verification', '/mailboxes', '/servers', '/templates', '/monitoring', '/logs', '/audit', '/setup', '/settings', '/wizard', '/identity/1', '/wizard/1/5'];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/tracker\.example/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function waitOnline(page: Page, count: number) {
  await expect.poll(async () => {
    const token = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="hoelni-token"]')!.content);
    const r = await page.request.get('/api/sessions', { headers: { 'x-hoelni-token': token } });
    return (await r.json()).filter((s: any) => s.state === 'ONLINE').length;
  }, { timeout: 60_000 }).toBeGreaterThanOrEqual(count);
}

test('every page renders without errors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  for (const p of PAGES) {
    await page.goto(`/#${p}`);
    await page.waitForTimeout(700);
    await expect(page.locator('#view')).not.toContainText('Error');
  }
  expect(errors).toEqual([]);
});

test('dashboard: search, filter and context menu', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/#/');
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.fill('input[type=search]', 'Identity03');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator('tbody tr').first().click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toContainText('Set all sessions online');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  expect(errors).toEqual([]);
});

test('matrix: toggling a cell brings the session online', async ({ page }) => {
  await page.goto('/#/matrix');
  const row = page.locator('tbody tr', { hasText: 'Identity05' });
  const testCell = row.locator('td.cell').nth(2); // Test server
  await expect(testCell).toContainText('should be offline');
  await testCell.click();
  await expect(testCell).toContainText('should be online');
  await expect(testCell).toContainText('ONLINE', { timeout: 45_000 });
  await testCell.click(); // back offline
  await expect(testCell).toContainText('STOPPED', { timeout: 20_000 });
});

test('global chat: command to a session and the reply shows up', async ({ page }) => {
  await page.goto('/#/chat');
  await waitOnline(page, 1);
  await page.goto('/#/chat');
  await page.locator('label.check', { hasText: 'Identity01@SMP' }).locator('input').check();
  await page.fill('input[placeholder^="Message"]', '/stars');
  await page.click('button:has-text("Send")');
  await expect(page.locator('.chat-stream')).toContainText('You have', { timeout: 15_000 });
});

test('setup check lists the configuration state', async ({ page }) => {
  await page.goto('/#/setup');
  await expect(page.locator('.health-list li')).toHaveCount(await page.locator('.health-list li').count());
  await expect(page.locator('#view')).toContainText('Credential vault');
  await expect(page.locator('#view')).toContainText('Minecraft servers');
});
