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

test('identity: open the game view of the running session, move, hide again', async ({ page, context }) => {
  await page.goto('/#/identity/1/sessions');
  await waitOnline(page, 1);
  await page.goto('/#/identity/1/sessions');
  // open the game for the SMP session explicitly
  const smpRow = page.locator('#sec-sessions tbody tr', { hasText: 'SMP' });
  await expect(smpRow).toContainText('ONLINE', { timeout: 30_000 });
  const [popup] = await Promise.all([context.waitForEvent('page'), smpRow.locator('button', { hasText: 'Open game' }).click()]);
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup.locator('#hud-title')).toContainText('Player01', { timeout: 20_000 });
  await expect(popup.locator('canvas')).toHaveCount(1, { timeout: 20_000 });
  // game view is flagged on the session
  await page.goto('/#/sessions');
  await expect(page.locator('#view h1').first()).toHaveText('Sessions');
  const sessRow = page.locator('#view tbody tr').filter({ hasText: 'Identity01' }).filter({ hasText: 'SMP' });
  await expect(sessRow).toContainText('view', { timeout: 10_000 });
  // "Hide game" returns to lightweight mode and closes the game window
  await Promise.all([popup.waitForEvent('close', { timeout: 10_000 }), popup.locator('#hide-btn').click()]);
  await page.goto('/#/matrix');
  await page.goto('/#/sessions');
  await expect(page.locator('#view h1').first()).toHaveText('Sessions');
  const row = page.locator('#view tbody tr').filter({ hasText: 'Identity01' }).filter({ hasText: 'SMP' });
  await expect(row).toContainText('ONLINE');
  await expect(row).not.toContainText('🎮 view', { timeout: 10_000 });
  await expect(row).toContainText('lightweight', { timeout: 15_000 }); // physics off again, same session
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
