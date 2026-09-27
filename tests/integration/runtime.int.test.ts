/**
 * LOCAL INTEGRATION: real mineflayer sessions in supervised runtime host
 * processes against real local Minecraft servers (flying-squid, offline mode).
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuite, type Suite } from '../../src/app.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { openDatabase } from '../../src/core/db.js';
import { startLocalServer, type LocalServer } from '../../src/testserver/localServer.js';
import { StaticKeyProvider } from '../../src/vault/keyProviders.js';
import { EncryptedFileVault } from '../../src/vault/vault.js';
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

let smp: LocalServer;
let event: LocalServer;
let suite: Suite;
let identityId: number;
let smpId: number;
let eventId: number;

beforeAll(async () => {
  smp = await startLocalServer({ port: await freePort(), version: '1.20.1', starIntervalSec: 1 });
  event = await startLocalServer({ port: await freePort(), version: '1.20.1' });
  const store = await EncryptedFileVault.open(null, new StaticKeyProvider());
  suite = createSuite({
    config: {
      ...DEFAULT_CONFIG,
      runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process', sessionsPerHost: 1, heartbeatMs: 1000, heartbeatTimeoutMs: 10000 },
    },
    db: openDatabase(':memory:'),
    store,
    rules: TEST_RULES,
    sessionOptions: { reconcileIntervalMs: 500 },
  });
  const s1 = suite.repo.upsertServer({ name: 'SMP', host: '127.0.0.1', port: smp.port, version: '1.20.1' });
  const s2 = suite.repo.upsertServer({ name: 'Event', host: '127.0.0.1', port: event.port, version: '1.20.1' });
  smpId = s1.id;
  eventId = s2.id;
  identityId = suite.identities.create({ label: 'Identity01', settings: { discordLinking: 'required' } }).identity.id;
  suite.repo.upsertMinecraft(identityId, { username: 'Player01', authType: 'offline' });
  // Source-IP binding: 127.0.0.2 is a valid loopback source address on Linux.
  suite.repo.createNetworkProfile(identityId, { kind: 'BIND', name: 'loop2', localBindIp: process.platform === 'linux' ? '127.0.0.2' : '127.0.0.1' });
  suite.repo.assignServer(identityId, { serverId: smpId });
  suite.repo.assignServer(identityId, { serverId: eventId });
  suite.sessions.startReconciler();
}, 60_000);

afterAll(async () => {
  await suite?.shutdown();
  await smp?.close();
  await event?.close();
}, 30_000);

const sid = () => `${identityId}:${smpId}`;
const state = (id = sid()) => suite.sessions.getState(id);

describe('mineflayer runtime (process hosts) against a local server', () => {
  it('connects through the configured bind IP and reaches ONLINE', async () => {
    await suite.sessions.startSession(identityId, smpId);
    await waitFor(() => state().state === 'ONLINE', 30_000, 'ONLINE');
    await waitFor(() => smp.players().includes('Player01'), 5000, 'player on server');
    expect(smp.players()).toContain('Player01');
    const hosts = suite.runtime.stats().hosts;
    expect(hosts.length).toBeGreaterThanOrEqual(1);
    expect(hosts[0].pid).not.toBe(process.pid); // runs in a separate process
  }, 40_000);

  it('uses the bind IP as TCP source address (seen by the server)', async () => {
    const ev = suite.repo.sessionEvents({ sessionId: sid() }).find((e) => e.kind === 'start');
    expect(ev?.detail).toBe('network=loop2');
    const remote = smp._remoteOf('Player01');
    expect(remote).toBeDefined();
    if (process.platform === 'linux') expect(remote).toMatch(/127\.0\.0\.2$/);
  });

  it('processes link codes and rewards from real server chat', async () => {
    await waitFor(() => !!suite.linking.pendingFor(identityId), 10_000, 'link code');
    expect(suite.linking.pendingFor(identityId)!.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(suite.repo.getDiscord(identityId)!.linkState).toBe('WAITING');
    await suite.sessions.sendChat(sid(), '/link');
    await waitFor(() => suite.repo.getDiscord(identityId)?.linkState === 'LINKED', 10_000, 'LINKED');
    await waitFor(() => suite.repo.getServerReward(identityId, smpId).stars >= 2, 10_000, 'stars');
    const st = suite.repo.getServerReward(identityId, smpId);
    expect(st.discordLinked).toBe(true);
    const chat = suite.sessions.getChat(sid(), { limit: 50 }).map((l) => l.text);
    expect(chat.some((t) => /Discord linked successfully/.test(t))).toBe(true);
  }, 30_000);

  it('runs a second session of the same account on another server at the same time', async () => {
    await suite.sessions.startSession(identityId, eventId);
    await waitFor(() => state(`${identityId}:${eventId}`).state === 'ONLINE', 30_000, 'second ONLINE');
    expect(state().state).toBe('ONLINE');
    expect(event.players()).toContain('Player01');
    expect(smp.players()).toContain('Player01');
  }, 40_000);

  it('reconnects automatically after a kick that allows it', async () => {
    smp.kick('Player01', 'Server restart');
    await waitFor(() => state().state === 'RECONNECTING', 10_000, 'RECONNECTING');
    await waitFor(() => state().state === 'ONLINE', 40_000, 'back ONLINE');
    expect(state().reconnects).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('recovers from a crashed runtime host without touching other sessions', async () => {
    (suite.runtime as any).crashHostOf(sid());
    await waitFor(() => state().lastEndReason === 'runtimeCrash', 10_000, 'crash detected');
    // The Event session (other host) stays online.
    expect(state(`${identityId}:${eventId}`).state).toBe('ONLINE');
    await waitFor(() => state().state === 'ONLINE', 40_000, 'restored after crash');
  }, 60_000);

  it('blocks automatic reconnects after a ban-like kick', async () => {
    smp.kick('Player01', 'You are banned from this server');
    await waitFor(() => state().state === 'BLOCKED', 10_000, 'BLOCKED');
    await new Promise((r) => setTimeout(r, 1500));
    expect(state().state).toBe('BLOCKED');
    expect(smp.players()).not.toContain('Player01');
  }, 30_000);

  it('stops sessions when the desired state goes offline', async () => {
    await suite.sessions.stopSession(`${identityId}:${eventId}`);
    expect(state(`${identityId}:${eventId}`).state).toBe('STOPPED');
    await waitFor(() => !event.players().includes('Player01'), 10_000, 'left server');
  }, 30_000);
});
