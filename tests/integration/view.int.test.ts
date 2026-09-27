/**
 * LOCAL INTEGRATION: interactive view on a running session.
 * AFK (lightweight) → open view → world stream + control → hide → AFK,
 * all without reconnecting the Minecraft session.
 */
import net from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuite, type Suite } from '../../src/app.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { openDatabase } from '../../src/core/db.js';
import { startLocalServer, type LocalServer } from '../../src/testserver/localServer.js';
import { StaticKeyProvider } from '../../src/vault/keyProviders.js';
import { EncryptedFileVault } from '../../src/vault/vault.js';
import { buildServer } from '../../src/web/server.js';
import { TEST_RULES, waitFor } from '../helpers.js';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let mc: LocalServer;
let suite: Suite;
let app: Awaited<ReturnType<typeof buildServer>>['app'];
let port: number;
let sid: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  mc = await startLocalServer({ port: await freePort(), version: '1.20.1' });
  port = await freePort();
  suite = createSuite({
    config: { ...DEFAULT_CONFIG, port, runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process' } },
    db: openDatabase(':memory:'),
    store: await EncryptedFileVault.open(null, new StaticKeyProvider()),
    rules: TEST_RULES,
  });
  const srv = suite.repo.upsertServer({ name: 'SMP', host: '127.0.0.1', port: mc.port, version: '1.20.1' });
  const id = suite.identities.create({ label: 'Viewer' }).identity.id;
  suite.repo.upsertMinecraft(id, { username: 'Viewer01', authType: 'offline' });
  suite.repo.assignServer(id, { serverId: srv.id });
  sid = `${id}:${srv.id}`;
  ({ app } = await buildServer(suite, { apiToken: 'tok' }));
  await app.listen({ host: '127.0.0.1', port });
  await suite.sessions.startSession(id, srv.id);
  await waitFor(() => suite.sessions.getState(sid).state === 'ONLINE', 30_000, 'ONLINE');
  await waitFor(() => suite.sessions.getState(sid).stats !== null, 10_000, 'stats');
}, 60_000);

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await app?.close();
  await suite?.shutdown();
  await mc?.close();
}, 30_000);

const connect = (token: string, role: string) => {
  const s = ioClient(`http://127.0.0.1:${port}`, { path: '/view-io/', query: { vt: token, role }, transports: ['websocket'], extraHeaders: { host: `127.0.0.1:${port}` } });
  sockets.push(s);
  return s;
};

describe('interactive view on the same running session', () => {
  it('starts in lightweight mode (physics off)', () => {
    expect(suite.sessions.getState(sid).stats!.physics).toBe(false);
  });

  it('streams the world and accepts controls, then hides without reconnect', async () => {
    const before = suite.sessions.getState(sid);
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${sid}/view`, headers: { host: `127.0.0.1:${port}`, 'x-hoelni-token': 'tok' } });
    const { token, url } = res.json();
    expect(url).toBe(`/view/${token}/`);

    // view page is served only with a valid token
    const page = await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${port}` } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("worker-src 'self' blob:");
    const bad = await app.inject({ method: 'GET', url: '/view/not-a-token/', headers: { host: `127.0.0.1:${port}` } });
    expect(bad.statusCode).toBe(404);

    const render = connect(token, 'render');
    const events: string[] = [];
    let version: string | null = null;
    render.onAny((ev: string, arg: any) => {
      events.push(ev);
      if (ev === 'version') version = arg;
    });
    await waitFor(() => events.includes('loadChunk') && events.includes('position'), 15_000, 'world stream');
    expect(version).toBe('1.20.1');

    const control = connect(token, 'control');
    const hello = await new Promise<any>((resolve) => control.once('hello', resolve));
    expect(hello.sessionId).toBe(sid);
    await waitFor(() => suite.sessions.getState(sid).stats?.physics === true, 10_000, 'physics on');

    const startPos = suite.sessions.getState(sid).stats!.position!;
    control.emit('control', { kind: 'lookDelta', dYaw: 0.8, dPitch: 0 });
    control.emit('control', { kind: 'state', control: 'forward', value: true });
    await new Promise((r) => setTimeout(r, 1500));
    control.emit('control', { kind: 'state', control: 'forward', value: false });
    control.emit('control', { kind: 'bogus' }); // ignored by validation
    await waitFor(() => {
      const p = suite.sessions.getState(sid).stats?.position;
      return !!p && Math.hypot(p.x - startPos.x, p.z - startPos.z) > 2;
    }, 12_000, 'movement');

    const inv = await new Promise<any>((resolve) => control.emit('inventory', resolve));
    expect(inv.ok).toBe(true);

    const closed = new Promise((resolve) => render.once('closed', resolve));
    const ack = await new Promise<any>((resolve) => control.emit('hide', resolve));
    expect(ack.ok).toBe(true);
    await closed;
    await waitFor(() => suite.sessions.getState(sid).stats?.physics === false, 10_000, 'physics off again');
    const after = suite.sessions.getState(sid);
    expect(after.state).toBe('ONLINE');
    expect(after.viewOpen).toBe(false);
    expect(after.reconnects).toBe(before.reconnects);
    expect(after.onlineSince).toBe(before.onlineSince); // same connection – no reconnect
    // the old token is dead
    const again = await app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${port}` } });
    expect(again.statusCode).toBe(404);
  }, 60_000);
});
