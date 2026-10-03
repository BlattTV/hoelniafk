/** Per server "Direct (own IP)": no proxy for this server, without changing the identity's default network. */
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/web/server.js';
import { createTestSuite } from './helpers.js';

describe('direct connection per server', () => {
  it('uses one direct profile of the identity, keeps the default network and leaves other servers alone', async () => {
    const t = await createTestSuite();
    const s = t.suite;
    const { app } = await buildServer(s, { apiToken: 'tok' });
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
      app.inject({ method, url, payload: payload as any, headers: { 'x-hoelni-token': 'tok', host: `127.0.0.1:${s.config.port}` } });
    const id = s.identities.create({ label: 'Alt' }).identity.id;
    const proxy = s.repo.createNetworkProfile(id, { kind: 'SOCKS5', name: 'Exit-01', proxyHost: '203.0.113.6', proxyPort: 1080 });
    expect(s.repo.getIdentity(id).networkProfileId).toBe(proxy.id); // identity default: the proxy
    const hugo = s.repo.upsertServer({ name: 'Hugo', host: 'hugosmp.net', port: 25565 });
    const hoelni = s.repo.upsertServer({ name: 'Hoelni', host: 'hoelni.de', port: 25570 });
    s.repo.assignServer(id, { serverId: hugo.id });
    s.repo.assignServer(id, { serverId: hoelni.id });
    const r = await call('POST', `/api/identities/${id}/servers/${hoelni.id}/direct`);
    expect(r.statusCode).toBe(200);
    const direct = s.repo.listNetworkProfiles(id).find((p) => p.kind === 'DIRECT')!;
    expect(s.repo.getAssignment(id, hoelni.id)!.networkProfileId).toBe(direct.id);
    expect(s.repo.getAssignment(id, hugo.id)!.networkProfileId).toBeNull(); // Hugo still uses the default (proxy)
    expect(s.repo.getIdentity(id).networkProfileId).toBe(proxy.id);
    // again: the same profile, no second one
    await call('POST', `/api/identities/${id}/servers/${hugo.id}/direct`);
    expect(s.repo.listNetworkProfiles(id).filter((p) => p.kind === 'DIRECT')).toHaveLength(1);
    // not assigned → refused
    const lobby = s.repo.upsertServer({ name: 'Lobby', host: 'lobby.example', port: 25565 });
    expect((await call('POST', `/api/identities/${id}/servers/${lobby.id}/direct`)).statusCode).toBe(400);
    // an identity without a default network keeps none
    const other = s.identities.create({ label: 'Other' }).identity.id;
    s.repo.assignServer(other, { serverId: hugo.id });
    await call('POST', `/api/identities/${other}/servers/${hugo.id}/direct`);
    expect(s.repo.getIdentity(other).networkProfileId).toBeNull();
    await app.close();
    await s.shutdown();
  });
});
