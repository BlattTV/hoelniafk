/**
 * LOCAL INTEGRATION: backend (accounts + relay) ↔ manager (suite, BackendLink) ↔ agent (AgentCore)
 * with a real mineflayer session that runs ON THE AGENT against a local Minecraft server.
 */
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
import { AgentCore } from '../../src/agent/agentCore.js';
import { requestJson } from '../../src/agent/transport.js';
import { createSuite, type Suite } from '../../src/app.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { openDatabase } from '../../src/core/db.js';
import { startLocalServer, type LocalServer } from '../../src/testserver/localServer.js';
import { StaticKeyProvider } from '../../src/vault/keyProviders.js';
import { EncryptedFileVault } from '../../src/vault/vault.js';
import { startSocks5 } from '../fixtures/socks5.js';
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

const ADMIN_PW = 'admin-password-1';
const USER_PW = 'friend-password-1';

let mc: LocalServer;
let backendUrl: string;
let backendServer: any;
let relay: any;
let accounts: any;
let suite: Suite;
let agent: AgentCore;
let agentId: number;
let identityId: number;
let serverId: number;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-relay-'));
  mc = await startLocalServer({ port: await freePort(), version: '1.20.1' });

  accounts = new Accounts(openDb(path.join(tmp, 'backend.db')));
  accounts.createUser('niklas', ADMIN_PW, 'admin');
  accounts.createUser('friend', USER_PW, 'user');
  const quiet = { info: () => undefined, error: () => undefined };
  relay = new Relay(accounts, quiet);
  backendServer = createBackendServer({ accounts, relay, config: { trustProxy: false }, log: quiet });
  await new Promise<void>((r) => backendServer.listen(0, '127.0.0.1', r));
  backendUrl = `http://127.0.0.1:${backendServer.address().port}`;

  const store = await EncryptedFileVault.open(null, new StaticKeyProvider());
  suite = createSuite({
    config: { ...DEFAULT_CONFIG, runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process', heartbeatMs: 1000, heartbeatTimeoutMs: 10000 } },
    db: openDatabase(':memory:'),
    store,
    // Long reconnect backoff: sessions waiting for an agent must still start at once when it comes back.
    rules: { ...TEST_RULES, reconnect: { ...TEST_RULES.reconnect, baseDelaySec: 30, maxDelaySec: 60 } },
    gameClient: null,
    sessionOptions: { reconcileIntervalMs: 300 },
  });
  suite.repo.setSetting('backend.url', backendUrl);
  serverId = suite.repo.upsertServer({ name: 'SMP', host: '127.0.0.1', port: mc.port, version: '1.20.1' }).id;
  identityId = suite.identities.create({ label: 'Remote01' }).identity.id;
  suite.repo.upsertMinecraft(identityId, { username: 'Remote01', authType: 'offline' });
  suite.repo.assignServer(identityId, { serverId });
  suite.sessions.startReconciler();
}, 60_000);

afterAll(async () => {
  await agent?.stop();
  await suite?.shutdown();
  relay?.close();
  await new Promise((r) => backendServer?.close(r));
  await mc?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}, 30_000);

describe('backend relay: manager and agent of the same account', () => {
  it('uses afk.hoelni.de as default and only an admin of the current backend can change it', async () => {
    const def = createSuite({ db: openDatabase(':memory:'), store: await EncryptedFileVault.open(null, new StaticKeyProvider()), gameClient: null });
    expect(def.backend.status().url).toBe('https://afk.hoelni.de');
    expect(def.backend.status().isDefault).toBe(true);
    await def.shutdown();

    await expect(suite.backend.changeBackend('https://evil.example', 'friend', USER_PW)).rejects.toThrow(/did not confirm the admin/);
    await expect(suite.backend.changeBackend('https://evil.example', 'niklas', 'wrong-password')).rejects.toThrow(/did not confirm the admin/);
    expect(suite.backend.status().url).toBe(backendUrl);
  });

  it('manager signs in; the agent signs in with the same account and becomes a runtime host', async () => {
    const st = await suite.backend.login('niklas', ADMIN_PW);
    expect(st.role).toBe('admin');
    await waitFor(() => suite.backend.status().state === 'online', 10_000, 'manager online');

    const r = await requestJson<{ token: string; deviceId: number }>(`${backendUrl}/api/login`, 'POST', { username: 'niklas', password: ADMIN_PW, client: 'agent', name: 'Living room PC' });
    agentId = r.deviceId;
    agent = new AgentCore({ backendUrl, token: r.token, agentId, name: 'Living room PC', transport: {}, dataDir: tmp, allowPrivateTargets: true });
    agent.start();
    await waitFor(() => agent.status.state === 'online' && agent.status.managerOnline, 10_000, 'agent online');
    await waitFor(() => suite.backend.status().agents.some((a) => a.id === agentId && a.online), 10_000, 'agent visible in manager');
    expect(suite.backend.status().agents[0].name).toBe('Living room PC');
  }, 30_000);

  it('runs an identity set to "Run on: agent" on the agent and relays chat', async () => {
    suite.repo.updateIdentity(identityId, { settings: { agentId } });
    await suite.sessions.startSession(identityId, serverId);
    const sid = `${identityId}:${serverId}`;
    await waitFor(() => suite.sessions.getState(sid).state === 'ONLINE', 30_000, 'ONLINE via agent');
    await waitFor(() => mc.players().includes('Remote01'), 5000, 'player on server');
    expect(suite.runtime.isRemoteSession?.(sid)).toBe(true);
    await waitFor(() => agent.status.sessions.length === 1, 5000, 'agent lists session');
    expect(suite.backend.status().agents[0].sessions).toContain(sid);
    // Round trip: command from the manager → agent → server, server answer → agent → manager chat.
    await suite.sessions.sendChat(sid, '/link');
    await waitFor(() => mc.linked.has('Remote01'), 5000, 'command reached server');
    await waitFor(() => suite.sessions.getChat(sid, { limit: 50 }).some((l) => /Discord linked successfully/.test(l.text)), 5000, 'answer reached manager');
  }, 45_000);

  it('a pool proxy assigned to the identity is used by the session on the agent', async () => {
    const sid = `${identityId}:${serverId}`;
    const exit = process.platform === 'linux' ? '127.0.0.6' : '127.0.0.1';
    const socks = await startSocks5({ password: 'pool-secret', exitAddress: exit });
    try {
      await suite.sessions.stopSession(sid);
      await waitFor(() => !mc.players().includes('Remote01'), 10_000, 'stopped');
      await suite.proxies.import(`socks5://pooluser:pool-secret@127.0.0.1:${socks.port}`);
      const proxy = suite.proxies.list()[0];
      await suite.proxies.assign(identityId, proxy.id);
      await suite.sessions.startSession(identityId, serverId);
      await waitFor(() => suite.sessions.getState(sid).state === 'ONLINE', 30_000, 'ONLINE via agent + proxy');
      expect(suite.runtime.isRemoteSession?.(sid)).toBe(true);
      expect(socks.auths).toContain('pooluser:pool-secret');
      if (process.platform === 'linux') expect(mc._remoteOf('Remote01')).toMatch(/127\.0\.0\.6$/);
    } finally {
      for (const p of suite.proxies.list()) await suite.proxies.remove(p.id); // later tests connect directly again
      socks.close();
    }
  }, 60_000);

  it('the household can pause: sessions stop and no new ones start there', async () => {
    agent.pause();
    const sid = `${identityId}:${serverId}`;
    await waitFor(() => !mc.players().includes('Remote01'), 10_000, 'left server on pause');
    await waitFor(() => suite.backend.status().agents.find((a) => a.id === agentId)?.paused === true, 5000, 'paused visible');
    await new Promise((r) => setTimeout(r, 1500));
    expect(suite.sessions.getState(sid).state).not.toBe('ONLINE');
    agent.resume();
    await waitFor(() => suite.sessions.getState(sid).state === 'ONLINE', 10_000, 'back ONLINE right after resume (no backoff wait)');
  }, 60_000);

  it('admin API is only available to admins signed in to a manager', async () => {
    const friend = await requestJson<{ token: string }>(`${backendUrl}/api/login`, 'POST', { username: 'friend', password: USER_PW, client: 'manager', name: 'friend PC' });
    await expect(requestJson(`${backendUrl}/api/admin/overview`, 'GET', undefined, {}, { Authorization: `Bearer ${friend.token}` })).rejects.toThrow(/admin/i);
    const agentTok = await requestJson<{ token: string }>(`${backendUrl}/api/login`, 'POST', { username: 'niklas', password: ADMIN_PW, client: 'agent', name: 'x' });
    await expect(requestJson(`${backendUrl}/api/admin/overview`, 'GET', undefined, {}, { Authorization: `Bearer ${agentTok.token}` })).rejects.toThrow(/admin/i);

    const overview = (await suite.backend.admin('GET', 'overview')) as any;
    expect(overview.users.map((u: any) => u.username).sort()).toEqual(['friend', 'niklas']);
    expect(overview.devices.some((d: any) => d.id === agentId && d.online)).toBe(true);
    expect(JSON.stringify(overview)).not.toMatch(/token_hash|password_hash|\$scrypt/);
    const created = (await suite.backend.admin('POST', 'users', { username: 'guest', password: 'guest-password-1', role: 'user' })) as any;
    expect(created.role).toBe('user');
  }, 20_000);

  it('another account cannot reach this account’s agent', async () => {
    const friend = await requestJson<{ token: string }>(`${backendUrl}/api/login`, 'POST', { username: 'friend', password: USER_PW, client: 'agent', name: 'friend agent' });
    const agents = await requestJson<any[]>(`${backendUrl}/api/agents`, 'GET', undefined, {}, { Authorization: `Bearer ${friend.token}` });
    expect(agents.some((a) => a.id === agentId)).toBe(false);
  });

  it('revoking the agent in the account administration disconnects it for good', async () => {
    await suite.backend.admin('DELETE', `devices/${agentId}`);
    await waitFor(() => agent.status.state === 'revoked', 10_000, 'agent revoked');
    await waitFor(() => !mc.players().includes('Remote01'), 10_000, 'session gone');
    await waitFor(() => !suite.backend.status().agents.find((a) => a.id === agentId)?.online, 5000, 'offline in manager');
  }, 30_000);
});
