/** Automatic starts come one after another (random gap), a click on "Start" is never delayed. */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestSuite, waitFor } from './helpers.js';

const envBefore = process.env.HOELNI_START_SPACING;
afterEach(() => {
  process.env.HOELNI_START_SPACING = envBefore;
});

describe('start spacing', () => {
  it('reconciler starts the accounts one by one; manual start is immediate', async () => {
    delete process.env.HOELNI_START_SPACING; // the test environment switches it off – here it is on
    const t = await createTestSuite();
    const s = t.suite;
    expect(s.sessions.startSpacing()).toEqual({ min: 8, max: 25 }); // default
    expect(s.sessions.setStartSpacing(1, 1)).toEqual({ min: 1, max: 1 });
    const srv = s.repo.upsertServer({ name: 'SMP', host: 'mc.example.com', port: 25565 });
    const ids = [1, 2, 3].map((n) => {
      const id = s.identities.create({ label: `Alt${n}` }).identity.id;
      s.repo.upsertMinecraft(id, { username: `Alt0${n}`, authType: 'offline' });
      s.repo.assignServer(id, { serverId: srv.id, desiredState: 'ONLINE' });
      return id;
    });
    s.sessions.startReconciler();
    await new Promise((r) => setTimeout(r, 400));
    expect(t.bots.length).toBe(1); // the first one at once …
    await new Promise((r) => setTimeout(r, 4500));
    expect(t.bots.length).toBe(3); // … the others with a gap (reconcile tick + 1 s each)
    // "Start" of a single session waits for nothing
    const lobby = s.repo.upsertServer({ name: 'Lobby', host: 'lobby.example.com', port: 25565 });
    s.repo.assignServer(ids[0], { serverId: lobby.id });
    s.sessions.setStartSpacing(60, 60);
    const before = t.bots.length;
    const t0 = Date.now();
    await s.sessions.startSession(ids[0], lobby.id);
    await waitFor(() => t.bots.length === before + 1, 3000, 'manual start');
    expect(Date.now() - t0).toBeLessThan(3000); // not 60 s
    // "all offline": the online accounts leave one after another
    for (const b of t.bots) b.join?.();
    await waitFor(() => s.sessions.list().filter((x) => x.state === 'ONLINE').length === 4, 5000, 'all online');
    s.sessions.setStartSpacing(1, 1);
    await new Promise((r) => setTimeout(r, 1100)); // the last start is more than the gap ago
    await s.bulk.run('stopSessions', ids);
    await new Promise((r) => setTimeout(r, 400));
    const online = () => s.sessions.list().filter((x) => x.state === 'ONLINE').length;
    expect(online()).toBe(3); // the first one left at once …
    await waitFor(() => online() === 0, 8000, 'all offline one by one'); // … the others with a gap

    await s.shutdown();
  }, 20_000);
});
