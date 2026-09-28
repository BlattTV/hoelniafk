/**
 * Expired Minecraft session ("Invalid session", "Failed to verify username"): the suite renews the
 * token in the background and reconnects at once – no launcher restart, no manual step.
 * Only when renewing does not help twice in a row, the session is blocked.
 */
import { describe, expect, it } from 'vitest';
import { createTestSuite, settle, waitFor } from './helpers.js';

async function setup() {
  const fetches: Array<{ forceRefresh: boolean }> = [];
  const t = await createTestSuite({
    tokenFetcher: async ({ msaAccount, forceRefresh }) => {
      fetches.push({ forceRefresh: !!forceRefresh });
      return { profile: { id: '00000000000000000000000000000042', name: 'Renew42' }, accessToken: `mc-token-${fetches.length}`, profileKeys: null };
    },
  });
  const { suite } = t;
  const srv = suite.repo.upsertServer({ name: 'SMP', host: 'smp.example.com' });
  const id = suite.identities.create({ label: 'Renew' }).identity.id;
  suite.repo.upsertMinecraft(id, { username: 'Renew42', authType: 'microsoft', msaAccount: 'renew@example.com' });
  await suite.auth.authenticate(id);
  suite.repo.assignServer(id, { serverId: srv.id });
  await suite.sessions.startSession(id, srv.id);
  await waitFor(() => t.bots.length === 1, 2000, 'bot');
  t.bots[0].join();
  await settle();
  return { ...t, id, sid: `${id}:${srv.id}`, fetches };
}

const kick = (bot: any, reason: string) => {
  bot.emit('kicked', reason);
  bot.emit('end', 'socketClosed');
};

describe('expired session renewal', () => {
  it('renews the token in the background and reconnects immediately', async () => {
    const { suite, bots, sid, fetches, id } = await setup();
    expect(suite.sessions.getState(sid).state).toBe('ONLINE');
    const before = fetches.length;
    kick(bots[0], 'Invalid session (Try restarting your game and the launcher)');
    await waitFor(() => fetches.some((f, i) => i >= before && f.forceRefresh), 3000, 'forced token refresh');
    suite.sessions.startReconciler();
    await waitFor(() => bots.length === 2, 5000, 'reconnected right away');
    bots[1].join();
    await settle();
    expect(suite.sessions.getState(sid).state).toBe('ONLINE');
    expect(suite.repo.sessionEvents({ sessionId: sid }).some((e) => e.kind === 'renew')).toBe(true);
    expect(suite.audit.list({ identityId: id, limit: 20 }).map((e) => e.action)).toContain('Session renewed automatically');
    await suite.shutdown();
  });

  it('blocks only when renewing does not help (third expiry in a row)', async () => {
    const { suite, bots, sid } = await setup();
    suite.sessions.startReconciler();
    for (let i = 0; i < 3; i++) {
      kick(bots[i], 'Failed to verify username!');
      if (i < 2) {
        await waitFor(() => bots.length === i + 2, 5000, `reconnect ${i + 1}`);
        // the connection fails again before it becomes stable
      }
    }
    await waitFor(() => suite.sessions.getState(sid).state === 'BLOCKED', 5000, 'BLOCKED');
    expect(suite.sessions.getState(sid).lastError).toMatch(/renewal did not help/);
    await suite.shutdown();
  });
});
