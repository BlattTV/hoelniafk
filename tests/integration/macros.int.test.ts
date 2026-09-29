/**
 * LOCAL INTEGRATION: macro builder against a real server – the macro runs in the runtime host next
 * to the real mineflayer session (process mode). Trigger "session online" → command + walking; a
 * macro added while the session runs is delivered live and started via the API path.
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

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

let mc: LocalServer;
let suite: Suite;
let sid = '';

beforeAll(async () => {
  mc = await startLocalServer({ port: await freePort(), version: '1.20.1' });
  suite = createSuite({
    config: { ...DEFAULT_CONFIG, runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process' } },
    db: openDatabase(':memory:'),
    store: await EncryptedFileVault.open(null, new StaticKeyProvider()),
    rules: TEST_RULES,
    gameClient: null,
    sessionOptions: { reconcileIntervalMs: 300 },
  });
  const serverId = suite.repo.upsertServer({ name: 'S', host: '127.0.0.1', port: mc.port, version: '1.20.1' }).id;
  const id = suite.identities.create({ label: 'Macro' }).identity.id;
  suite.repo.upsertMinecraft(id, { username: 'Macro01', authType: 'offline' });
  suite.repo.assignServer(id, { serverId });
  sid = `${id}:${serverId}`;
  suite.macros.save({
    name: 'On join: link + walk',
    trigger: { type: 'spawn' },
    blocks: [
      { type: 'wait', seconds: 1 },
      { type: 'command', text: 'link' },
      { type: 'look', yaw: 0, pitch: 0 },
      { type: 'move', dir: 'forward', seconds: 1.5 },
    ],
  });
  suite.sessions.startReconciler();
  await suite.sessions.startSession(id, serverId);
}, 60_000);

afterAll(async () => {
  await suite?.shutdown();
  await mc?.close();
}, 30_000);

describe('macro builder on a real session', () => {
  it('"when online" macro sends the command and walks (server sees it)', async () => {
    await waitFor(() => suite.sessions.getState(sid).state === 'ONLINE', 30_000, 'ONLINE');
    await waitFor(() => !!mc.positionOf('Macro01'), 5000, 'position');
    const start = mc.positionOf('Macro01')!;
    await waitFor(() => mc.linked.has('Macro01'), 10_000, 'command reached the server');
    await waitFor(() => {
      const p = mc.positionOf('Macro01');
      return !!p && Math.hypot(p.x - start.x, p.z - start.z) > 1;
    }, 10_000, 'walked');
    await waitFor(() => suite.macros.recent().some((l) => l.status === 'finished'), 10_000, 'finished');
  }, 40_000);

  it('a macro created while online is delivered live and can be started manually', async () => {
    const m = suite.macros.save({ name: 'Stars', trigger: { type: 'manual' }, blocks: [{ type: 'command', text: 'stars' }] });
    await new Promise((r) => setTimeout(r, 300));
    const answers = () => suite.sessions.getChat(sid, { limit: 200 }).filter((l) => /You have \d+ stars/.test(l.text)).length;
    const before = answers();
    suite.macros.run(m.id, sid);
    await waitFor(() => suite.macros.recent().some((l) => l.macroId === m.id && l.status === 'finished'), 10_000, 'macro finished');
    await waitFor(() => answers() > before, 10_000, 'server answered the macro command');
  }, 20_000);

  it('variables, "repeat until" and placeholders work on the real session (the server sees the commands)', async () => {
    const m = suite.macros.save({
      name: 'Counter',
      trigger: { type: 'manual' },
      blocks: [
        { type: 'setVar', name: 'n', value: 0 },
        { type: 'repeatUntil', cond: { type: 'varCompare', name: 'n', op: '>=', value: 2 }, body: [{ type: 'changeVar', name: 'n', by: 1 }, { type: 'command', text: 'stars' }, { type: 'waitRandom', min: 0.2, max: 0.4 }] },
        { type: 'log', text: 'done after {n} rounds at y={y}' },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    const answers = () => suite.sessions.getChat(sid, { limit: 200 }).filter((l) => /You have \d+ stars/.test(l.text)).length;
    const before = answers();
    suite.macros.run(m.id, sid);
    await waitFor(() => suite.macros.recent().some((l) => l.macroId === m.id && l.status === 'finished'), 15_000, 'macro finished');
    await waitFor(() => answers() >= before + 2, 10_000, 'two commands answered');
    const note = suite.macros.recent().find((l) => l.macroId === m.id && l.status === 'log');
    expect(note?.message).toMatch(/^done after 2 rounds at y=-?\d+$/);
  }, 30_000);
});
