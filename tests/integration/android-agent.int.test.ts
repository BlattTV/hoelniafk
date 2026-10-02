/**
 * LOCAL INTEGRATION: the Android agent process (dist/agent/android.js – the script the app runs on its
 * embedded Node.js) driven through its control server like the app screen does: sign in, run an AFK
 * session for the manager against a local Minecraft server, pause, sign out.
 *
 * HOELNI_ANDROID_NODE    Node binary to run it with (e.g. Node 18 = the version inside the app)
 * HOELNI_ANDROID_PAYLOAD unpacked assets/agent.zip of a built APK (default: this checkout)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error – plain ESM backend package without type declarations
import { Accounts } from '../../backend/src/accounts.mjs';
// @ts-expect-error – see above
import { openDb } from '../../backend/src/db.mjs';
// @ts-expect-error – see above
import { Relay } from '../../backend/src/relay.mjs';
// @ts-expect-error – see above
import { createBackendServer } from '../../backend/src/server.mjs';
import { createSuite, type Suite } from '../../src/app.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { openDatabase } from '../../src/core/db.js';
import { startLocalServer, type LocalServer } from '../../src/testserver/localServer.js';
import { StaticKeyProvider } from '../../src/vault/keyProviders.js';
import { EncryptedFileVault } from '../../src/vault/vault.js';
import { TEST_RULES, waitFor } from '../helpers.js';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const PW = 'android-password-1';
let mc: LocalServer;
let backendServer: any;
let relay: any;
let suite: Suite;
let backendUrl: string;
let identityId: number;
let serverId: number;
let tmp: string;
let dataDir: string;
let proc: ChildProcess;
let output = '';

async function ctl(p: string, body?: unknown): Promise<any> {
  const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8'));
  const r = await fetch(`http://127.0.0.1:${c.port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'x-token': c.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-android-'));
  dataDir = path.join(tmp, 'agent');
  mc = await startLocalServer({ port: await freePort(), version: '1.20.1' });
  const accounts = new Accounts(openDb(path.join(tmp, 'backend.db')));
  accounts.createUser('niklas', PW, 'admin');
  const quiet = { info: () => undefined, error: () => undefined };
  relay = new Relay(accounts, quiet);
  backendServer = createBackendServer({ accounts, relay, config: { trustProxy: false }, log: quiet });
  await new Promise<void>((r) => backendServer.listen(0, '127.0.0.1', r));
  backendUrl = `http://127.0.0.1:${backendServer.address().port}`;
  suite = createSuite({
    config: { ...DEFAULT_CONFIG, dataDir: tmp, runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process', heartbeatMs: 1000, heartbeatTimeoutMs: 10000 } },
    db: openDatabase(':memory:'),
    store: await EncryptedFileVault.open(null, new StaticKeyProvider()),
    rules: TEST_RULES,
    gameClient: null,
    sessionOptions: { reconcileIntervalMs: 300 },
  });
  suite.repo.setSetting('backend.url', backendUrl);
  serverId = suite.repo.upsertServer({ name: 'SMP', host: '127.0.0.1', port: mc.port, version: '1.20.1' }).id;
  identityId = suite.identities.create({ label: 'Phone01' }).identity.id;
  suite.repo.upsertMinecraft(identityId, { username: 'Phone01', authType: 'offline' });
  suite.repo.assignServer(identityId, { serverId });
  suite.sessions.startReconciler();
  await suite.backend.login('niklas', PW);
  await waitFor(() => suite.backend.status().state === 'online', 10_000, 'manager online');

  // the app starts the script like this (AgentService.java)
  const root = process.env.HOELNI_ANDROID_PAYLOAD ?? path.resolve(__dirname, '../..');
  proc = spawn(process.env.HOELNI_ANDROID_NODE ?? process.execPath, [path.join(root, 'dist/agent/android.js'), '--data', dataDir, '--vault-key', 'a'.repeat(64), '--device-name', 'Pixel Test', '--app-version', '0.2.0-1 (1)'], {
    env: { ...process.env, HOELNI_AGENT_ALLOW_LAN: '1', HOELNI_VAULT_PASSPHRASE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  await waitFor(() => fs.existsSync(path.join(dataDir, 'control.json')), 20_000, 'control server');
}, 90_000);

afterAll(async () => {
  proc?.kill('SIGTERM');
  await suite?.shutdown();
  relay?.close();
  await new Promise((r) => backendServer?.close(r));
  await mc?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}, 30_000);

describe('Android agent (app process)', () => {
  it('control server needs the token; status before sign-in', async () => {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8'));
    expect((await fetch(`http://127.0.0.1:${c.port}/status`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${c.port}/status`, { headers: { 'x-token': 'x'.repeat(48) } })).status).toBe(401);
    const st = await ctl('/status');
    expect(st).toMatchObject({ ok: true, signedIn: false, name: 'Pixel Test', appVersion: '0.2.0-1 (1)' });
    expect(output).toBe(''); // logs go to the log file, not to stdout (invisible on a phone)
  });

  it('wrong password is reported; sign-in starts the agent, the token is in the vault', async () => {
    const bad = await ctl('/login', { user: 'niklas', password: 'nope', backend: backendUrl });
    expect(bad.status).toBe(400);
    expect(bad.ok).toBe(false);
    const st = await ctl('/login', { user: 'niklas', password: PW, name: 'Handy Wohnzimmer', backend: backendUrl });
    expect(st).toMatchObject({ ok: true, signedIn: true, username: 'niklas', name: 'Handy Wohnzimmer', backendUrl });
    const stored = fs.readFileSync(path.join(dataDir, 'agent.json'), 'utf8');
    expect(JSON.parse(stored)).toMatchObject({ tokenInVault: true });
    expect(stored).not.toMatch(/"token"/);
    await waitFor(async () => (await ctl('/status')).agent?.state === 'online', 15_000, 'agent online');
    await waitFor(() => suite.backend.status().agents.some((a) => a.name === 'Handy Wohnzimmer' && a.online), 10_000, 'agent visible in manager');
  }, 30_000);

  it('runs a session placed on the phone; the screen lists it', async () => {
    const agentId = suite.backend.status().agents.find((a) => a.name === 'Handy Wohnzimmer')!.id;
    suite.repo.updateIdentity(identityId, { settings: { agentId } });
    await suite.sessions.startSession(identityId, serverId);
    const sid = `${identityId}:${serverId}`;
    await waitFor(() => suite.sessions.getState(sid).state === 'ONLINE', 40_000, 'ONLINE via phone');
    await waitFor(() => mc.players().includes('Phone01'), 5000, 'player on server');
    await waitFor(async () => (await ctl('/status')).agent?.sessions.length === 1, 5000, 'listed on the phone');
    const st = await ctl('/status');
    expect(st.agent.sessions[0]).toMatchObject({ sessionId: sid, username: 'Phone01' });
    expect(st.log.join('\n')).toMatch(/on Android/);
  }, 60_000);

  it('opening the game is refused with a clear message (no Minecraft on a phone)', async () => {
    const sid = `${identityId}:${serverId}`;
    await suite.sessions.openGame(sid);
    await waitFor(() => /only be opened on a PC/.test(suite.sessions.getState(sid).lastError ?? ''), 10_000, 'refusal reported');
    expect(suite.sessions.getState(sid).state).toBe('ONLINE'); // the AFK session carries on
  }, 30_000);

  it('pause stops the sessions on the phone; sign-out ends the agent', async () => {
    await ctl('/pause', {});
    await waitFor(() => !mc.players().includes('Phone01'), 10_000, 'left on pause');
    expect((await ctl('/status')).agent.state).toBe('paused');
    await ctl('/resume', {});
    await waitFor(() => mc.players().includes('Phone01'), 30_000, 'back after resume');
    const st = await ctl('/logout', {});
    expect(st).toMatchObject({ signedIn: false, agent: null });
    await waitFor(() => !mc.players().includes('Phone01'), 10_000, 'left after sign-out');
  }, 60_000);
});
