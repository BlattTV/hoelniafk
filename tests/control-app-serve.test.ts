/** The backend serves the Control app with content-hashed script / style addresses (no stale caches). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore
import { Accounts } from '../backend/src/accounts.mjs';
// @ts-ignore
import { openDb } from '../backend/src/db.mjs';
// @ts-ignore
import { Relay } from '../backend/src/relay.mjs';
// @ts-ignore
import { createBackendServer } from '../backend/src/server.mjs';

describe('control app served by the backend', () => {
  it('index names app.js / app.css with a build hash, is not cached; files and the font are served', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
    const accounts = new Accounts(openDb(path.join(tmp, 'b.db')));
    const quiet = { info: () => undefined, error: () => undefined };
    const server = createBackendServer({ accounts, relay: new Relay(accounts, quiet), config: { trustProxy: false }, log: quiet });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const page = await fetch(`${url}/app/`);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    const build = /name="hoelni-build" content="([0-9a-f]{10})"/.exec(html)?.[1];
    expect(build).toBeTruthy();
    expect(html).toContain(`href="app.css?v=${build}"`);
    expect(html).toContain(`src="app.js?v=${build}"`);
    const css = await fetch(`${url}/app/app.css?v=${build}`);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('--bg');
    const font = await fetch(`${url}/app/inter-latin.woff2`);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    // the download page uses the same look (stylesheet from the app folder)
    expect((await fetch(`${url}/app/download.css`)).status).toBe(200);
    server.close();
  });
});
