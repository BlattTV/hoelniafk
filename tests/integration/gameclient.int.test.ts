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

const emulatorState = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(tmp, 'instances', `identity-${identityId}-server-${serverId}`, 'emulator-state.json'), 'utf8'));
  } catch {
    return null;
  }
};
const dist = (a: { x: number; z: number } | null, b: { x: number; z: number } | null) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity);

describe('real game client: live takeover (default) – same connection, no re-login', () => {
  it('AFK session online in the lightweight runtime', async () => {
    await suite.sessions.startSession(identityId, serverId);
    await waitFor(() => state().state === 'ONLINE', 30_000, 'ONLINE');
    expect(state().runtime).toBe('lightweight');
    expect(joinsOf('Gamer01')).toHaveLength(1);
  }, 40_000);

  it('"Open game": the game takes over the running session and is in the world', async () => {
    process.env.EMULATOR_ACTIONS = 'chat:/stars|walk:1500';
    await suite.sessions.openGame(sid());
    delete process.env.EMULATOR_ACTIONS;
    await waitFor(() => state().takeover === 'attached', 60_000, 'attached');
    await waitFor(() => emulatorState()?.spawned === true, 20_000, 'game spawned');
    const st = emulatorState();
    // no second login – the server still has the one connection of the AFK client
    expect(joinsOf('Gamer01')).toHaveLength(1);
    expect(server.players().filter((p) => p === 'Gamer01')).toHaveLength(1);
    expect(state().state).toBe('ONLINE');
    expect(state().runtime).toBe('lightweight');
    // the game is the session's player: same UUID, in the same place, world loaded
    expect(st.chunks).toBeGreaterThan(0);
    expect(st.blockBelow).not.toBeNull();
    expect(st.gameMode).toBe('survival');
    expect(st.dimension).toBe('overworld');
    await waitFor(() => emulatorState()?.health > 0, 5000, `health (${emulatorState()?.health})`);
    await waitFor(() => dist(emulatorState()?.position, server.positionOf('Gamer01')) < 1, 5000, 'game and server agree on the position');
    const pid = state().game!.pid!;
    await waitFor(() => windows.calls.some(([c, p]) => c === 'show' && p === pid), 5000, 'window shown');
    // every start step is in the session log (shows where a start that "does nothing" stops)
    await waitFor(() => suite.repo.sessionEvents({ sessionId: sid() }).some((x) => x.kind === 'game-running'), 5000, 'running logged');
    const kinds = suite.repo.sessionEvents({ sessionId: sid() }).map((x) => x.kind);
    for (const k of ['game-installing', 'game-launching', 'game-starting', 'game-running']) expect(kinds).toContain(k);
    expect(suite.repo.sessionEvents({ sessionId: sid() }).find((x) => x.kind === 'game-starting')!.detail).toMatch(new RegExp(`pid ${pid}`));
  }, 90_000);

  it('the player controls the session: chat and movement go through the same connection', async () => {
    await waitFor(() => suite.sessions.getChat(sid(), { limit: 50 }).some((l) => /You have \d+ stars/.test(l.text) && Date.parse(l.ts) > Date.now() - 30_000), 15_000, '/stars reply');
    const before = server.positionOf('Gamer01');
    await waitFor(() => dist(server.positionOf('Gamer01'), before) > 1 || dist(emulatorState()?.position, server.positionOf('Gamer01')) < 0.5, 10_000, 'moved');
    await new Promise((r) => setTimeout(r, 2500));
    const game = emulatorState().position;
    expect(dist(server.positionOf('Gamer01'), game)).toBeLessThan(0.6); // server follows the game's movement
    expect(joinsOf('Gamer01')).toHaveLength(1);
  }, 30_000);

  it('"Back to AFK" closes the game; the AFK client continues on the same connection from the new spot', async () => {
    const pid = state().game!.pid!;
    const where = server.positionOf('Gamer01');
    await suite.sessions.closeGame(sid());
    await waitFor(() => !alive(pid), 15_000, 'game closed');
    expect(state().takeover).toBe('none');
    await new Promise((r) => setTimeout(r, 2000));
    expect(state().state).toBe('ONLINE');
    expect(joinsOf('Gamer01')).toHaveLength(1); // still the very first login
    expect(server.players()).toContain('Gamer01');
    expect(dist(server.positionOf('Gamer01'), where)).toBeLessThan(0.6); // no rubber-banding back
    await suite.sessions.sendChat(sid(), '/stars'); // AFK client owns the chat again
  }, 30_000);

  it('quitting inside the game hands control back as well', async () => {
    process.env.EMULATOR_ACTIONS = 'quit';
    await suite.sessions.openGame(sid());
    delete process.env.EMULATOR_ACTIONS;
    await waitFor(() => state().takeover === 'attached', 60_000, 'attached again');
    await waitFor(() => state().takeover === 'none' && !state().game?.pid, 20_000, 'game quit → AFK');
    expect(state().state).toBe('ONLINE');
    expect(joinsOf('Gamer01')).toHaveLength(1);
  }, 90_000);
});

describe('real game client: handover mode (re-login fallback)', () => {
  it('switch to handover mode', async () => {
    suite.repo.updateIdentity(identityId, { settings: { gameClient: { mode: 'handover' } } as any });
    expect(state().state).toBe('ONLINE');
    expect(state().runtime).toBe('lightweight');
  });

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

describe('real game client: live takeover fails → the game signs in on its own', () => {
  it('a game dropped right after joining with an error is reopened with its own login (handover)', async () => {
    suite.repo.updateIdentity(identityId, { settings: { gameClient: { mode: 'takeover' } } as any });
    await suite.sessions.startSession(identityId, serverId);
    await waitFor(() => state().state === 'ONLINE' && state().runtime === 'lightweight', 60_000, 'AFK ONLINE');
    process.env.EMULATOR_ACTIONS = 'fail';
    await suite.sessions.openGame(sid());
    await waitFor(() => state().takeover === 'attached', 60_000, 'attached');
    delete process.env.EMULATOR_ACTIONS;
    await waitFor(() => suite.repo.sessionEvents({ sessionId: sid() }).some((x) => x.kind === 'game-takeover-failed' && /Network Protocol Error/.test(x.detail)), 20_000, 'takeover failure recorded');
    expect(suite.repo.sessionEvents({ sessionId: sid() }).some((x) => x.kind === 'game-detached' && /Network Protocol Error/.test(x.detail))).toBe(true);
    // the game comes back with its own login and holds the session
    await waitFor(() => state().runtime === 'game' && state().state === 'ONLINE' && !!state().game?.pid, 90_000, 'game signed in on its own');
    expect(server.players().filter((p) => p === 'Gamer01')).toHaveLength(1);
    // back to AFK works as usual
    await suite.sessions.closeGame(sid());
    await waitFor(() => state().runtime === 'lightweight' && state().state === 'ONLINE', 60_000, 'AFK again');
  }, 240_000);
  it('a game that cannot even enter the session (error screen before joining) is reopened with its own login', async () => {
    // new session record → takeover is tried again
    await suite.sessions.stopSession(sid());
    await waitFor(() => state().state === 'STOPPED', 30_000, 'stopped');
    await suite.sessions.startSession(identityId, serverId);
    await waitFor(() => state().state === 'ONLINE' && state().runtime === 'lightweight', 60_000, 'AFK ONLINE');
    const t0 = Date.now();
    const gameDir = path.join(tmp, 'instances', `identity-${identityId}-server-${serverId}`);
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'reject-once.txt'), "Internal Exception: io.netty.handler.codec.DecoderException: Failed to decode packet 'clientbound/minecraft:cookie_request'");
    await suite.sessions.openGame(sid());
    await waitFor(() => suite.repo.sessionEvents({ sessionId: sid() }).some((x) => x.kind === 'game-takeover-failed' && Date.parse(x.ts) >= t0 - 1000), 30_000, 'failure noticed quickly (no 5 min wait)');
    await waitFor(() => state().runtime === 'game' && state().state === 'ONLINE' && !!state().game?.pid, 90_000, 'game signed in on its own');
    await suite.sessions.closeGame(sid());
    await waitFor(() => state().runtime === 'lightweight' && state().state === 'ONLINE', 60_000, 'AFK again');
  }, 240_000);
});

describe('real game client: "Open game – stable" (own login, whatever the mode)', () => {
  it('in takeover mode the stable method signs the game in on its own; closing it returns to AFK', async () => {
    suite.repo.updateIdentity(identityId, { settings: { gameClient: { mode: 'takeover' } } as any });
    await waitFor(() => state().runtime === 'lightweight' && state().state === 'ONLINE', 60_000, 'AFK ONLINE');
    const joins = joinsOf('Gamer01').length;
    await suite.sessions.openGame(sid(), { method: 'stable' });
    await waitFor(() => state().runtime === 'game' && state().state === 'ONLINE' && !!state().game?.pid, 90_000, 'game signed in on its own');
    expect(state().takeover).toBe('none'); // nothing relayed – the game has its own connection
    expect(joinsOf('Gamer01').length).toBe(joins + 1);
    expect(server.players().filter((p) => p === 'Gamer01')).toHaveLength(1); // never two logins at once
    expect(suite.repo.sessionEvents({ sessionId: sid() }).some((x) => x.kind === 'game-stable')).toBe(true);
    process.kill(state().game!.pid!, 'SIGTERM'); // the player closes the window
    await waitFor(() => state().runtime === 'lightweight' && state().state === 'ONLINE', 30_000, 'AFK again');
    expect(server.players().filter((p) => p === 'Gamer01')).toHaveLength(1);
  }, 200_000);
});
