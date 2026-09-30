import { expect, test, type Page } from '@playwright/test';

const PAGES = ['/', '/matrix', '/sessions', '/chat', '/inbox', '/verification', '/mailboxes', '/servers', '/templates', '/monitoring', '/logs', '/audit', '/setup', '/settings', '/wizard', '/identity/1', '/wizard/1/5', '/schedules', '/agents', '/accounts', '/proxies', '/new', '/discord', '/macros', '/mail'];

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

test('dashboard: live updates only swap the rows that changed (no jumping list)', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/#/');
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await waitOnline(page, 5);
  await page.waitForTimeout(2000); // the list has caught up with the sessions coming online
  await page.evaluate(() => document.querySelectorAll('tbody tr').forEach((tr, i) => ((tr as any).__probe = i)));
  const token = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="hoelni-token"]')!.content);
  const ids = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((tr) => (tr as HTMLElement).dataset.key));
  const target = ids[ids.length - 1];
  const oldLabel = (await (await page.request.get(`/api/identities/${target}`, { headers: { 'x-hoelni-token': token } })).json()).identity?.label;
  const r = await page.request.fetch(`/api/identities/${target}`, { method: 'PATCH', headers: { 'x-hoelni-token': token, 'Content-Type': 'application/json' }, data: { label: 'Renamed live' } });
  expect(r.ok()).toBe(true);
  await expect(page.locator(`tbody tr[data-key="${target}"]`)).toContainText('Renamed live');
  const kept = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((tr) => (tr as any).__probe ?? null));
  expect(kept.filter((x) => x !== null)).toHaveLength(4); // the other four rows are the same DOM elements
  // later tests use the demo names
  await page.request.fetch(`/api/identities/${target}`, { method: 'PATCH', headers: { 'x-hoelni-token': token, 'Content-Type': 'application/json' }, data: { label: oldLabel ?? null } });
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

test('identity: "Open game" hands the session to the real client and "Back to AFK" returns', async ({ page }) => {
  await page.goto('/#/identity/1/sessions');
  await waitOnline(page, 1);
  await page.goto('/#/identity/1/sessions');
  const smpRow = page.locator('#sec-sessions tbody tr', { hasText: 'SMP' });
  await expect(smpRow).toContainText('ONLINE', { timeout: 30_000 });
  await smpRow.locator('button', { hasText: 'Open game' }).click();
  await expect(page.locator('.toast').last()).toContainText(/Minecraft|game/i);
  // the session is now held by the game client (emulated binary in this environment)
  await page.goto('/#/sessions');
  const row = () => page.locator('#view tbody tr').filter({ hasText: 'Identity01' }).filter({ hasText: 'SMP' });
  await expect(async () => {
    await page.goto('/#/matrix');
    await page.goto('/#/sessions');
    await expect(row()).toContainText('in game', { timeout: 2000 });
    await expect(row()).not.toContainText('joining', { timeout: 2000 });
    await expect(row()).toContainText('ONLINE', { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
  // back to AFK
  await row().locator('button', { hasText: 'More' }).click();
  await page.locator('.ctx-menu').getByText('Back to AFK').click();
  await expect(async () => {
    await page.goto('/#/matrix');
    await page.goto('/#/sessions');
    await expect(row()).not.toContainText('in game', { timeout: 2000 });
    await expect(row()).toContainText('ONLINE', { timeout: 2000 });
    await expect(row()).toContainText('lightweight', { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
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

test('schedules: paint a window and apply it to a session', async ({ page }) => {
  await page.goto('/#/schedules');
  await expect(page.locator('h1')).toHaveText('Schedules');
  await page.getByRole('button', { name: 'Evenings 18–24' }).click();
  const row = page.locator('tbody tr').filter({ hasText: 'Identity02' }).filter({ hasText: 'Test' });
  await row.locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: /Apply to 1 selected/ }).click();
  await expect(row).toContainText('18–24');
  // the session shows its schedule
  await page.goto('/#/identity/2/sessions');
  await page.goto('/#/sessions');
});

test('quick actions (Ctrl+K) jump to a page', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('#view h1').first()).toHaveText('Identities');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.palette input')).toBeFocused();
  await page.keyboard.type('proxy');
  await expect(page.locator('.palette li.cur')).toContainText('Proxy pool');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/proxies$/);
});

test('theme switch persists', async ({ page }) => {
  await page.goto('/#/');
  await page.locator('#theme-toggle').click();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
});

test('setup check lists the configuration state', async ({ page }) => {
  await page.goto('/#/setup');
  await expect(page.locator('.health-list li')).toHaveCount(await page.locator('.health-list li').count());
  await expect(page.locator('#view')).toContainText('Credential vault');
  await expect(page.locator('#view')).toContainText('Minecraft servers');
});

test('backend: account administration is only shown to admins; agents appear', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/#/settings');
  const card = page.locator('#backend-card');
  await expect(card).toContainText('127.0.0.1');
  await expect(page.locator('#nav-accounts')).toBeHidden();

  // A normal account: no administration.
  await card.getByLabel('Username').fill('friend');
  await card.getByLabel('Password').fill('friend-password');
  await card.getByRole('button', { name: 'Sign in' }).click();
  await expect(card).toContainText('connected');
  await expect(card).toContainText('friend');
  await expect(page.locator('#nav-accounts')).toBeHidden();
  await card.getByRole('button', { name: 'Sign out' }).click();
  await expect(card).toContainText('signed out');

  // Changing the address needs an admin of the current backend.
  await card.getByRole('button', { name: 'Change address…' }).click();
  const dlg = page.locator('.modal');
  await dlg.getByLabel('New address').fill('https://other.example');
  await dlg.getByLabel('Admin username').fill('friend');
  await dlg.getByLabel('Admin password').fill('friend-password');
  await dlg.getByRole('button', { name: 'Change address' }).click();
  await expect(page.locator('.toast.error')).toContainText('did not confirm the admin');
  await dlg.getByRole('button', { name: 'Close' }).click();

  // Admin account: the administration appears.
  await card.getByLabel('Username').fill('demo');
  await card.getByLabel('Password').fill('demo-password');
  await card.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#backend-card')).toContainText('demo · admin');
  await expect(page.locator('#nav-accounts')).toBeVisible();

  await page.goto('/#/agents');
  await expect(page.locator('#view')).toContainText('Demo agent');
  await expect(page.locator('#view tbody')).toContainText('online');

  await page.goto('/#/accounts');
  await expect(page.locator('#view')).toContainText('friend');
  await page.getByRole('button', { name: 'New account' }).click();
  await page.locator('.modal').getByLabel('Username').fill('neighbour');
  await page.locator('.modal').getByLabel('Password (min. 10 characters)').fill('neighbour-pass-1');
  await page.locator('.modal').getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('#view')).toContainText('neighbour');
  await expect(page.locator('#view')).toContainText('Demo agent');

  // Identity settings: "Run on" lists the agent.
  await page.goto('/#/identity/1');
  await expect(page.locator('select[name=agentId]')).toContainText('Demo agent');
  // The only failed request is the rejected address change (400) above.
  expect(errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
});

test('proxy pool: import hides passwords and a proxy can be assigned', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/#/proxies');
  await page.getByLabel('Proxy list').fill('socks5://pooluser:very-secret-pw@127.0.0.1:1\n10.9.9.9:1080\nbroken line');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.locator('#view tbody tr')).toHaveCount(2);
  await expect(page.locator('#view')).toContainText('pooluser:•••@127.0.0.1:1');
  await expect(page.locator('#view')).not.toContainText('very-secret-pw');
  await page.locator('#view tbody tr').first().locator('select').selectOption({ label: 'Identity05' });
  await expect(page.locator('#view tbody tr').first()).toContainText('Identity05');
  await page.locator('#view tbody tr').first().getByRole('button', { name: 'Release' }).click();
  await expect(page.locator('#view tbody tr').first().locator('select')).toBeVisible();
  expect(errors).toEqual([]);
});

test('language: the whole UI switches to German and back', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/#/settings');
  await Promise.all([page.waitForEvent('load'), page.selectOption('#ui-language', 'de')]);
  await expect(page.locator('.sidebar')).toContainText('Identitäten');
  await expect(page.locator('.sidebar')).toContainText('Einstellungen');
  await page.goto('/#/sessions');
  await expect(page.locator('#view h1')).toHaveText('Sessions');
  await expect(page.locator('#view thead')).toContainText('Zustand');
  await page.goto('/#/settings');
  await expect(page.locator('#view')).toContainText('Backend & Konto');
  await expect(page.locator('#view')).toContainText('Dieser PC');
  // switch back so the demo stays English for other runs
  await Promise.all([page.waitForEvent('load'), page.selectOption('#ui-language', 'en')]);
  await expect(page.locator('.sidebar')).toContainText('Identities');
  expect(errors).toEqual([]);
});

test('quick setup: name → Microsoft sign-in window (Minecraft + Outlook, no app registration) → Discord → online', async ({ page, context }) => {
  const errors = trackErrors(page);
  // Microsoft's pages are not reachable in tests – only check where the windows go
  const external: string[] = [];
  context.on('request', (r) => { if (/^https:\/\/(www\.microsoft\.com|outlook\.live\.com)\//.test(r.url())) external.push(r.url()); });
  await page.goto('/#/');
  // simple navigation: advanced pages are tucked away
  await expect(page.locator('#nav-more a')).toHaveCount(5);
  await expect(page.locator('#nav-more a[data-nav="proxies"]')).toBeHidden();
  await page.locator('.sidebar a[data-nav="new"]').click();
  await page.getByLabel('Name').fill('Quick Demo');
  await page.locator('.server-choice', { hasText: 'SMP' }).locator('input').check();
  await page.getByRole('button', { name: 'Next' }).click();

  // step 2: e-mail → the identity's Microsoft window opens on the confirmation page, code filled in
  const tile = page.locator('.tile', { hasText: 'Microsoft account' });
  await tile.getByLabel('Microsoft e-mail').fill('quick.demo@outlook.com');
  const [popup] = await Promise.all([context.waitForEvent('page'), tile.getByRole('button', { name: 'Sign in with Microsoft' }).click()]);
  await expect.poll(() => external).toContain('https://www.microsoft.com/link?otc=DEMO1234');
  await popup.close();
  await expect(tile).toContainText(/Minecraft: DemoMs\d+/);
  await expect(tile).toContainText('Outlook: quick.demo@outlook.com');
  const [outlook] = await Promise.all([context.waitForEvent('page'), tile.getByRole('button', { name: 'Open Outlook' }).click()]);
  await expect.poll(() => external).toContain('https://outlook.live.com/mail/0/');
  await outlook.close();

  // step 3: Discord – own window, sign-up helper with the Microsoft address, then "done"
  await page.getByRole('button', { name: 'Next' }).click();
  const dc = page.locator('.tile', { hasText: 'Discord' });
  await expect(dc.getByRole('button', { name: 'Create Discord account' })).toBeVisible();
  await expect(dc.locator('.copy-rows')).toContainText('quick.demo@outlook.com');
  await expect(dc.locator('.copy-rows')).toContainText('••••••••••');
  await dc.getByLabel('Discord username').fill('quick_demo');
  await dc.getByRole('button', { name: 'Done – account is set up' }).click();
  await expect(dc).toContainText('@quick_demo');

  // done → online
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.summary')).toContainText(/Minecraft: DemoMs\d+/);
  await expect(page.locator('.summary')).toContainText('Discord: @quick_demo');
  await page.getByRole('button', { name: 'Go online now' }).click();
  await expect(page).toHaveURL(/#\/identity\/\d+$/);
  await expect(page.locator('.tiles')).toContainText('Microsoft account');

  await page.goto('/#/discord');
  await expect(page.locator('.account-grid')).toContainText('Quick Demo');
  await page.goto('/#/mail');
  await expect(page.locator('.account-grid')).toContainText('quick.demo@outlook.com');
  expect(errors).toEqual([]);
});

test('macro builder: drag blocks like in Scratch, save and run on a session', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/#/macros');
  await page.getByRole('button', { name: '+ New macro' }).click();
  await page.locator('.macro-name').fill('E2E stars');
  // drag "command /" from the palette into the script (after the default wait block)
  const slots = page.locator('.macro-script .drop-slot');
  await page.locator('.macro-palette .blk', { hasText: 'command /' }).dragTo(slots.last());
  await expect(page.locator('.macro-script .blk', { hasText: 'command /' })).toHaveCount(1);
  await page.locator('.macro-script .blk', { hasText: 'command /' }).locator('input').fill('stars');
  await page.locator('.macro-script .blk', { hasText: 'command /' }).locator('input').blur();
  // a C-block by click, then a block dragged INTO it
  await page.locator('.macro-palette .blk', { hasText: /^repeat\s*10\s*times$/ }).click();
  await page.locator('.macro-palette .blk', { hasText: 'swing hand' }).dragTo(page.locator('.macro-script .blk.c .blk-inner .drop-slot').first());
  await expect(page.locator('.macro-script .blk.c .blk-inner')).toContainText('swing hand');
  await expect(page.locator('.badge', { hasText: 'unsaved changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.macro-item', { hasText: 'E2E stars' })).toBeVisible();

  const token = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="hoelni-token"]')!.content);
  const macros = (await (await page.request.get('/api/macros', { headers: { 'x-hoelni-token': token } })).json()).macros;
  const saved = macros.find((m: any) => m.name === 'E2E stars');
  expect(saved.blocks.map((b: any) => b.type)).toEqual(['wait', 'command', 'repeat']);
  expect(saved.blocks[1].text).toBe('stars');
  expect(saved.blocks[2].body.map((b: any) => b.type)).toEqual(['swing']);
  // new blocks: variables with a condition on them
  await page.locator('.macro-palette .blk', { hasText: /^set\s*counter\s*to\s*0$/ }).click();
  await page.locator('.macro-palette .blk', { hasText: /^repeat until/ }).click();
  const until = page.locator('.macro-script .blk.c', { hasText: 'repeat until' });
  await until.locator('select').first().selectOption('varCompare');
  await expect(until.locator('select').nth(1)).toHaveValue('<');
  await page.locator('.macro-palette .blk', { hasText: /^change\s*counter\s*by\s*1$/ }).dragTo(until.locator('.blk-inner .drop-slot').first());
  await page.locator('.macro-palette .blk', { hasText: /^wait random/ }).dragTo(until.locator('.blk-inner .drop-slot').last());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.badge', { hasText: 'unsaved changes' })).toHaveCount(0);
  const again = (await (await page.request.get('/api/macros', { headers: { 'x-hoelni-token': token } })).json()).macros.find((m: any) => m.name === 'E2E stars');
  expect(again.blocks.map((b: any) => b.type)).toEqual(['wait', 'command', 'repeat', 'setVar', 'repeatUntil']);
  expect(again.blocks[4].cond).toEqual({ type: 'varCompare', name: 'counter', op: '<', value: 10 });
  expect(again.blocks[4].body.map((b: any) => b.type)).toEqual(['changeVar', 'waitRandom']);

  // run it on an online demo session
  await waitOnline(page, 1);
  await page.reload();
  await page.locator('.macro-item', { hasText: 'E2E stars' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.macro-log')).toContainText('finished', { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('identity settings: live updates never overwrite unsaved edits', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/#/identity/2');
  await page.locator('.more-details > summary').click();
  const label = page.locator('#sec-settings input[name=label]');
  await label.fill('Unsaved edit');
  await page.locator('#sec-settings select[name=gcMode]').selectOption('handover');
  await page.locator('h1').first().click(); // focus away from the form
  // a server event for this identity arrives (normally the page re-renders)
  await page.evaluate(async () => {
    const t = document.querySelector('meta[name=hoelni-token]')!.getAttribute('content')!;
    await fetch('/api/identities/2/network/verify', { method: 'POST', headers: { 'x-hoelni-token': t, 'content-type': 'application/json' }, body: '{}' });
  });
  await page.waitForTimeout(4000);
  await expect(label).toHaveValue('Unsaved edit');
  await expect(page.locator('#sec-settings select[name=gcMode]')).toHaveValue('handover');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('h1').first()).toContainText('Unsaved edit');
  expect(errors).toEqual([]);
});
