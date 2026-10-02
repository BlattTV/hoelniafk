/**
 * Where a session runs, per server: each server of an identity can run on this PC or its own agent;
 * "default" follows the identity's "Run on".
 */
import { describe, expect, it } from 'vitest';
import { createTestSuite, settle, waitFor } from './helpers.js';

describe('per-server placement', () => {
  it('each server of an identity can run somewhere else; default follows the identity', async () => {
    const { suite, bots } = await createTestSuite();
    const s1 = suite.repo.upsertServer({ name: 'Lobby', host: 'lobby.example.com', version: '1.21.4' }).id;
    const s2 = suite.repo.upsertServer({ name: 'Survival', host: 'survival.example.com', version: '1.21.4' }).id;
    const id = suite.identities.create({ label: 'P' }).identity.id;
    suite.repo.upsertMinecraft(id, { username: 'Placed01', authType: 'offline' });
    suite.repo.assignServer(id, { serverId: s1 });
    suite.repo.assignServer(id, { serverId: s2 });
    expect(suite.repo.getAssignment(id, s1)?.placement).toBe('default');
    suite.repo.setPlacement(id, s2, { agentId: 42 });
    expect(suite.repo.getAssignment(id, s2)?.placement).toEqual({ agentId: 42 });
    expect(suite.sessions.agentFor(id, s1)).toBeNull();
    expect(suite.sessions.agentFor(id, s2)).toBe(42);

    await suite.sessions.startSession(id, s1);
    await suite.sessions.startSession(id, s2);
    await waitFor(() => bots.length === 1, 3000, 'session on this PC');
    expect(bots[0].spec.server.name).toBe('Lobby');
    await waitFor(() => suite.sessions.getState(`${id}:${s2}`).state === 'RECONNECTING', 3000, 'waits for its agent');
    expect(suite.sessions.getState(`${id}:${s2}`)).toMatchObject({ agentId: 42, placement: { agentId: 42 } });
    expect(suite.sessions.getState(`${id}:${s2}`).lastError).toMatch(/Agent #42 is offline/);

    // the identity's default moves only servers without their own setting
    suite.repo.updateIdentity(id, { settings: { agentId: 7 } });
    expect(suite.sessions.agentFor(id, s1)).toBe(7);
    expect(suite.sessions.agentFor(id, s2)).toBe(42);
    suite.repo.setPlacement(id, s1, 'local');
    expect(suite.sessions.agentFor(id, s1)).toBeNull();
    suite.repo.setPlacement(id, s2, 'default');
    expect(suite.sessions.agentFor(id, s2)).toBe(7);
    await settle();
  });
});
