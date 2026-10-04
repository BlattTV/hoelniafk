/** After a server restart the thrown-out accounts rejoin spread over a window, never all at once. */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestSuite, waitFor } from './helpers.js';

const envBefore = process.env.HOELNI_REJOIN_SPACING;
afterEach(() => {
  process.env.HOELNI_REJOIN_SPACING = envBefore;
});

async function online(n: number) {
  const t = await createTestSuite();
  const s = t.suite;
  const srv = s.repo.upsertServer({ name: 'SMP', host: 'mc.example.com', port: 25565 });
  for (let i = 1; i <= n; i++) {
    const id = s.identities.create({ label: `Alt${i}` }).identity.id;
    s.repo.upsertMinecraft(id, { username: `Alt0${i}`, authType: 'offline' });
    s.repo.assignServer(id, { serverId: srv.id, desiredState: 'ONLINE' });
  }
  s.sessions.startReconciler();
  await waitFor(() => t.bots.length === n, 5000, 'bots started');
  for (const b of t.bots) b.join();
  await waitFor(() => s.sessions.list().filter((x) => x.state === 'ONLINE').length === n, 5000, 'all online');
  return t;
}

const kick = (b: { emit(e: string, ...a: unknown[]): unknown }, reason: string) => {
  b.emit('kicked', reason);
  b.emit('end', 'socketClosed');
};

describe('rejoin spacing after a server restart', () => {
  it('several accounts dropped together rejoin one by one in the window', async () => {
    process.env.HOELNI_REJOIN_SPACING = '0.02-0.07'; // 1.2–4.2 s instead of 4–15 min
    const t = await online(3);
    const s = t.suite;
    expect(s.sessions.rejoinSpacing()).toEqual({ min: 0.02, max: 0.07 });
    const bots = [...t.bots];
    const joins: number[] = [];
    const t0 = Date.now();
    for (const b of bots) kick(b, 'Connection reset');
    const count = () => t.bots.length - bots.length;
    const watch = setInterval(() => {
      while (joins.length < count()) joins.push(Date.now() - t0);
    }, 20);
    await new Promise((r) => setTimeout(r, 1000));
    expect(count()).toBe(0); // nobody back right away, not even the first one (normal backoff would be 50 ms)
    expect(s.sessions.list().every((x) => x.state === 'RECONNECTING' && /Server restart – rejoins at/.test(x.lastError ?? ''))).toBe(true);
    await waitFor(() => count() === 3, 8000, 'all rejoined');
    clearInterval(watch);
    while (joins.length < count()) joins.push(Date.now() - t0);
    for (const j of joins) expect(j).toBeGreaterThanOrEqual(1100);
    // spread over the window, not one after another at the same moment
    const sorted = [...joins].sort((a, b) => a - b);
    expect(sorted[2] - sorted[0]).toBeGreaterThan(400);
    await s.shutdown();
  }, 20_000);

  it('a restart kick message alone starts a wave; a single drop without it reconnects normally; 0 = off', async () => {
    process.env.HOELNI_REJOIN_SPACING = '0.02-0.03';
    const t = await online(2);
    const s = t.suite;
    const n0 = t.bots.length;
    kick(t.bots[0], 'Connection reset'); // one account alone: normal fast reconnect
    await waitFor(() => t.bots.length === n0 + 1, 3000, 'normal reconnect');
    t.bots[t.bots.length - 1].join();
    await s.shutdown();

    const t2 = await online(1);
    const n1 = t2.bots.length;
    kick(t2.bots[0], 'Server closed');
    await new Promise((r) => setTimeout(r, 800));
    expect(t2.bots.length).toBe(n1); // waits for its slot (1.2–1.8 s)
    await waitFor(() => t2.bots.length === n1 + 1, 4000, 'rejoined in its slot');
    await t2.suite.shutdown();

    process.env.HOELNI_REJOIN_SPACING = '0';
    const t3 = await online(2);
    const n2 = t3.bots.length;
    kick(t3.bots[0], 'Connection reset');
    kick(t3.bots[1], 'Connection reset');
    // off: two drops together reconnect with the normal (here very short) backoff
    await waitFor(() => t3.bots.length === n2 + 2, 3000, 'normal reconnect when off');
    expect(t3.suite.repo.sessionEvents({ limit: 50 }).some((e: any) => e.kind === 'rejoin-wait')).toBe(false);
    await t3.suite.shutdown();
  }, 20_000);
});
