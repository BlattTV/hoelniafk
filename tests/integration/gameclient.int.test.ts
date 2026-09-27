/**
 * LOCAL INTEGRATION: "Open game" end to end.
 *
 *   suite ─▶ launcher (installs from a local Mojang/Fabric mirror, incl. the Java runtime)
 *         ─▶ "java" = client emulator (tests/fixtures/clientEmulator.mjs) with the real
 *            launch command line ─▶ forwarder (bind IP) ─▶ flying-squid server
 *
 * What is real here: session manager, handover logic, launcher, SHA-1 verified
 * installation, argument building, process management, forwarder, network profile,
 * the Minecraft protocol login, latest.log parsing. What is emulated: the game
 * binary itself (Mojang downloads are not reachable from the build environment).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuite, type Suite } from '../../src/app.js';
import type { WindowController, WindowResult } from '../../src/client/window.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { openDatabase } from '../../src/core/db.js';
import { startLocalServer, type LocalServer } from '../../src/testserver/localServer.js';
import { StaticKeyProvider } from '../../src/vault/keyProviders.js';
import { EncryptedFileVault } from '../../src/vault/vault.js';
import { startFakeMojang, type FakeMojang } from '../fixtures/fakeMojang.js';
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Records window operations; a window "exists" while the process is alive. */
class FakeWindows implements WindowController {
  readonly name = 'fake';
  calls: Array<[string, number]> = [];
  async show(pid: number): Promise<WindowResult> {
    this.calls.push(['show', pid]);
    return 'ok';
  }
  async minimize(pid: number): Promise<WindowResult> {
    this.calls.push(['minimize', pid]);
    return 'ok';
  }
  async close(pid: number): Promise<WindowResult> {
    this.calls.push(['close', pid]);
    return 'nowindow'; // → runtime falls back to SIGTERM
  }
  async hasWindow(pid: number) {
    return alive(pid);
  }
  dispose() {}
}

let server: LocalServer;
let fake: FakeMojang;
let suite: Suite;
let tmp: string;
const windows = new FakeWindows();
let identityId: number;
let serverId: number;
const sid = () => `${identityId}:${serverId}`;
const state = () => suite.sessions.getState(sid());
const bindIp = process.platform === 'linux' ? '127.0.0.2' : '127.0.0.1';

beforeAll(async () => {
  server = await startLocalServer({ port: await freePort(), version: '1.20.1', starIntervalSec: 1 });
  fake = await startFakeMojang();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-game-'));
  suite = createSuite({
    config: {
      ...DEFAULT_CONFIG,
      dataDir: tmp,
      runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process', sessionsPerHost: 2, heartbeatMs: 1000, heartbeatTimeoutMs: 10000 },
      client: { ...DEFAULT_CONFIG.client, mirrors: fake.mirrors, onlineAfterMs: 1500, joinTimeoutMs: 60_000 },
    },
    db: openDatabase(':memory:'),
    store: await EncryptedFileVault.open(null, new StaticKeyProvider()),
    rules: TEST_RULES,
    sessionOptions: { reconcileIntervalMs: 500 },
    gameClient: { window: windows, closeTimeoutMs: 5000 },
  });
  serverId = suite.repo.upsertServer({ name: 'SMP', host: '127.0.0.1', port: server.port, version: '1.20.1' }).id;
  identityId = suite.identities.create({ label: 'Gamer', settings: { discordLinking: 'required' } }).identity.id;
  suite.repo.upsertMinecraft(identityId, { username: 'Gamer01', authType: 'offline' });
  suite.repo.createNetworkProfile(identityId, { kind: 'BIND', name: 'loop2', localBindIp: bindIp });
  suite.repo.assignServer(identityId, { serverId });
  suite.sessions.startReconciler();
}, 60_000);

afterAll(async () => {
  await suite?.shutdown();
  await server?.close();
  await fake?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}, 60_000);

const joinsOf = (name: string) => server.joins.filter((j) => j.username === name);

describe('real game client: handover mode (default)', () => {
  it('AFK session online in the lightweight runtime', async () => {
    await suite.sessions.startSession(identityId, serverId);
    await waitFor(() => state().state === 'ONLINE', 30_000, 'ONLINE');
    expect(state().runtime).toBe('lightweight');
    expect(joinsOf('Gamer01')).toHaveLength(1);
  }, 40_000);

  it('"Open game" installs the client, hands the account over and shows the window', async () => {
    const info = await suite.sessions.openGame(sid());
    expect(info.runtime).toBe('lightweight'); // AFK keeps the account online while the game is prepared
    await waitFor(() => state().runtime === 'game' && state().state === 'ONLINE', 60_000, 'game ONLINE');
    const s = state();
    expect(s.game?.status).toBe('running');
    expect(s.game?.visible).toBe(true);
    const pid = s.game!.pid!;
    expect(alive(pid)).toBe(true);
    expect(windows.calls).toContainEqual(['show', pid]);
    // exactly one more login, and the AFK client left before the game joined (never two at once)
    const joins = joinsOf('Gamer01');
    expect(joins).toHaveLength(2);
    expect(server.players().filter((p) => p === 'Gamer01')).toHaveLength(1);
    // the game went through the forwarder with the identity's bind IP; handshake host rewritten
    if (process.platform === 'linux') expect(joins[1].remote).toMatch(/127\.0\.0\.2$/);
    expect(joins[1].host).toBe('127.0.0.1');
    // launched with the official argument layout (quick play to the local forwarder)
    const gameDir = path.join(tmp, 'instances', `identity-${identityId}-server-${serverId}`);
    const launched = JSON.parse(fs.readFileSync(path.join(gameDir, 'emulator-args.json'), 'utf8')).argv as string[];
    expect(launched[launched.indexOf('--username') + 1]).toBe('Gamer01');
    expect(launched[launched.indexOf('--quickPlayMultiplayer') + 1]).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8')).toContain('pauseOnLostFocus:false');
    // the lightweight host no longer serves this session
    expect(suite.runtime.stats().hosts.reduce((a, h) => a + h.sessions, 0)).toBe(0);
  }, 90_000);

  it('reads chat from the game log and feeds the rules (link code, rewards)', async () => {
    await waitFor(() => suite.sessions.getChat(sid(), { limit: 100 }).some((l) => /You have \d+ stars/.test(l.text) && Date.parse(l.ts) > Date.now() - 20_000), 20_000, 'chat from game');
    expect(suite.linking.pendingFor(identityId)?.code).toMatch(/^[A-Z0-9]{6}$/);
    await expect(suite.sessions.sendChat(sid(), 'hi')).rejects.toThrow(/type the message in the game/);
  }, 30_000);

  it('"Open game" again only focuses the running window (no new login)', async () => {
    const before = joinsOf('Gamer01').length;
    await suite.sessions.openGame(sid());
    expect(windows.calls.at(-1)?.[0]).toBe('show');
    await new Promise((r) => setTimeout(r, 1000));
    expect(joinsOf('Gamer01').length).toBe(before);
  });

  it('"Back to AFK" closes the game and the lightweight client takes over', async () => {
    const pid = state().game!.pid!;
    await suite.sessions.closeGame(sid());
    await waitFor(() => state().runtime === 'lightweight' && state().state === 'ONLINE', 30_000, 'AFK ONLINE');
    expect(alive(pid)).toBe(false);
    expect(joinsOf('Gamer01')).toHaveLength(3);
    expect(server.players().filter((p) => p === 'Gamer01')).toHaveLength(1);
  }, 45_000);

  it('closing the game window yourself returns to AFK automatically', async () => {
    await suite.sessions.openGame(sid());
    await waitFor(() => state().runtime === 'game' && state().state === 'ONLINE', 60_000, 'game ONLINE');
    const pid = state().game!.pid!;
    process.kill(pid, 'SIGTERM'); // like clicking the window's X
    await waitFor(() => state().runtime === 'lightweight' && state().state === 'ONLINE', 30_000, 'AFK again');
    expect(state().game?.status).toBe('closed');
  }, 100_000);

  it('a game that cannot start leaves the AFK session untouched', async () => {
    suite.repo.updateIdentity(identityId, { settings: { gameClient: { version: '9.9.9' } } as any });
    const joins = joinsOf('Gamer01').length;
    await suite.sessions.openGame(sid());
    await waitFor(() => state().game?.status === 'failed', 20_000, 'game failed');
    expect(state().state).toBe('ONLINE');
    expect(state().runtime).toBe('lightweight');
    expect(state().lastError).toMatch(/Game could not be started: Unknown Minecraft version "9\.9\.9"/);
    expect(joinsOf('Gamer01').length).toBe(joins);
    suite.repo.updateIdentity(identityId, { settings: { gameClient: { version: 'auto' } } as any });
  }, 30_000);
});

describe('real game client: background mode', () => {
  it('the game itself holds the session, minimized; "Open game" restores the same connection', async () => {
    suite.repo.updateIdentity(identityId, { settings: { gameClient: { mode: 'background' } } as any });
    await suite.sessions.reconnect(sid());
    await waitFor(() => state().runtime === 'game' && state().state === 'ONLINE', 60_000, 'background game ONLINE');
    const pid = state().game!.pid!;
    expect(state().game?.visible).toBe(false);
    await waitFor(() => windows.calls.some(([c, p]) => c === 'minimize' && p === pid), 10_000, 'minimized');
    const joins = joinsOf('Gamer01').length;
    await suite.sessions.openGame(sid());
    expect(windows.calls.at(-1)).toEqual(['show', pid]);
    await suite.sessions.closeGame(sid());
    expect(windows.calls.at(-1)).toEqual(['minimize', pid]);
    await new Promise((r) => setTimeout(r, 1500));
    expect(joinsOf('Gamer01').length).toBe(joins); // same connection all along
    expect(state().game?.pid).toBe(pid);
    expect(state().state).toBe('ONLINE');
  }, 90_000);

  it('desired offline closes the game', async () => {
    const pid = state().game!.pid!;
    await suite.sessions.stopSession(sid());
    await waitFor(() => !alive(pid), 15_000, 'game process gone');
    expect(state().state).toBe('STOPPED');
    await waitFor(() => !server.players().includes('Gamer01'), 10_000, 'left server');
  }, 30_000);
});
