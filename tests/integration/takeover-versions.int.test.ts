/**
 * LOCAL INTEGRATION: live takeover across protocol generations.
 *   1.20.1  – classic login (registry codec inside "join game")          (gameclient.int.test.ts)
 *   1.20.2  – configuration phase, one registry codec packet
 *   1.21.1  – configuration phase, per-registry packets + known packs, chunk batches
 * The replay must bring a vanilla-behaving client (mineflayer as emulator) into
 * the world on the running session's connection without a second login.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSuite, type Suite } from '../../src/app.js';
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

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => undefined);
}, 60_000);

describe.each(['1.20.2', '1.21.1'])('live takeover on Minecraft %s', (version) => {
  let server: LocalServer;
  let fake: FakeMojang;
  let suite: Suite;
  let tmp: string;
  let sid = '';

  it('AFK session online', async () => {
    server = await startLocalServer({ port: await freePort(), version, starIntervalSec: 0 });
    fake = await startFakeMojang({ version });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hoelni-takeover-${version}-`));
    suite = createSuite({
      config: { ...DEFAULT_CONFIG, dataDir: tmp, runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process' }, client: { ...DEFAULT_CONFIG.client, mirrors: fake.mirrors } },
      db: openDatabase(':memory:'),
      store: await EncryptedFileVault.open(null, new StaticKeyProvider()),
      rules: TEST_RULES,
      sessionOptions: { reconcileIntervalMs: 500 },
    });
    cleanups.push(async () => {
      await suite.shutdown();
      await server.close();
      await fake.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    const serverId = suite.repo.upsertServer({ name: 'S', host: '127.0.0.1', port: server.port, version }).id;
    const identityId = suite.identities.create({ label: 'V' }).identity.id;
    suite.repo.upsertMinecraft(identityId, { username: 'Taker', authType: 'offline' });
    suite.repo.assignServer(identityId, { serverId });
    sid = `${identityId}:${serverId}`;
    await suite.sessions.startSession(identityId, serverId);
    await waitFor(() => suite.sessions.getState(sid).state === 'ONLINE', 40_000, 'ONLINE');
  }, 60_000);

  it('the game takes over the same connection and enters the world', async () => {
    await suite.sessions.openGame(sid);
    await waitFor(() => suite.sessions.getState(sid).takeover === 'attached', 60_000, 'attached');
    const stateFile = path.join(tmp, 'instances', fs.readdirSync(path.join(tmp, 'instances'))[0], 'emulator-state.json');
    const read = () => {
      try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch {
        return null;
      }
    };
    await waitFor(() => read()?.spawned === true && read()?.chunks > 0, 20_000, 'spawned with chunks');
    const st = read();
    expect(st.blockBelow).not.toBeNull();
    expect(st.dimension).toMatch(/overworld/);
    expect(server.joins.filter((j) => j.username === 'Taker')).toHaveLength(1);
    await waitFor(() => {
      const p = server.positionOf('Taker');
      const g = read()?.position;
      return !!p && !!g && Math.hypot(g.x - p.x, g.z - p.z) < 1 && Math.abs(g.y - p.y) < 1.5;
    }, 5000, 'game stands where the session stands');
  }, 90_000);

  it('Back to AFK keeps the session', async () => {
    const pid = suite.sessions.getState(sid).game!.pid!;
    await suite.sessions.closeGame(sid);
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 15_000, 'game closed');
    await new Promise((r) => setTimeout(r, 1500));
    expect(suite.sessions.getState(sid).state).toBe('ONLINE');
    expect(server.joins.filter((j) => j.username === 'Taker')).toHaveLength(1);
    expect(server.players()).toContain('Taker');
  }, 30_000);
});
