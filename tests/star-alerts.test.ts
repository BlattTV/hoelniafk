/** Abnormal star earning raises an alert (and the Control app turns it into a notification). */
import { describe, expect, it } from 'vitest';
import { StarAlerts, type OnlineSession } from '../src/minecraft/starAlerts.js';
import { createTestSuite } from './helpers.js';

const MIN = 60_000;
const H = 60 * MIN;

describe('star alerts', () => {
  it('stall, spike and drop compared with the account\'s usual pace; no repeats; settings; test alert', async () => {
    const t = await createTestSuite();
    const s = t.suite;
    const repo = s.repo;
    const srv = repo.upsertServer({ name: 'HugoSMP', host: 'hugosmp.net', port: 25565 });
    const other = repo.upsertServer({ name: 'Lobby', host: 'lobby.example.com', port: 25565 });
    repo.setServerTrackStars(other.id, false);
    const a = s.identities.create({ label: 'A' }).identity.id;
    const b = s.identities.create({ label: 'B' }).identity.id;
    const now = Date.parse('2026-10-04T12:00:00Z');
    const add = (id: number, server: number, at: number, delta: number) =>
      s.db.prepare("INSERT INTO reward_history (identity_id, server_id, ts, kind, delta, stars, reason) VALUES (?, ?, ?, 'stars', ?, 0, 'scoreboard: x')").run(id, server, new Date(at).toISOString(), delta);
    // both earn one star every 10 minutes for two days, until 3 hours ago
    for (let at = now - 50 * H; at <= now - 3 * H; at += 10 * MIN) {
      add(a, srv.id, at, 1);
      add(b, srv.id, at, 1);
    }
    // B keeps earning, and much more in the last hour (usual hour: 6)
    for (let at = now - 3 * H + 10 * MIN; at < now - H; at += 10 * MIN) add(b, srv.id, at, 1);
    for (let i = 0; i < 25; i++) add(b, srv.id, now - 50 * MIN + i * MIN, 1);
    let sessions: OnlineSession[] = [
      { identityId: a, serverId: srv.id, serverName: 'HugoSMP', state: 'ONLINE', onlineSince: new Date(now - 5 * H).toISOString() },
      { identityId: b, serverId: srv.id, serverName: 'HugoSMP', state: 'ONLINE', onlineSince: new Date(now - 5 * H).toISOString() },
      { identityId: a, serverId: other.id, serverName: 'Lobby', state: 'ONLINE', onlineSince: new Date(now - 5 * H).toISOString() },
    ];
    const raised: string[] = [];
    const alerts = new StarAlerts(repo, () => sessions, (id) => (id === a ? 'Alpha' : 'Beta'), (x) => raised.push(`${x.kind}:${x.name}`));
    const first = alerts.check(now);
    expect(first.map((x) => `${x.kind}:${x.name}`).sort()).toEqual(['spike:Beta', 'stall:Alpha']);
    expect(first.find((x) => x.kind === 'stall')!.textDe).toMatch(/seit 180 Min\. online ohne Stern \(sonst etwa alle 10 Min\./);
    expect(first.find((x) => x.kind === 'spike')!.text).toMatch(/^25 stars in the last hour \(usually about 6\)/);
    expect(raised).toHaveLength(2);
    // not repeated while it lasts
    expect(alerts.check(now + 5 * MIN)).toEqual([]);
    // just online for a short time: no stall (A reconnected 20 min ago)
    sessions = [{ ...sessions[0], onlineSince: new Date(now - 20 * MIN).toISOString() }];
    expect(alerts.check(now + 10 * MIN)).toEqual([]);
    // drop: lost 15 stars
    add(a, srv.id, now + 11 * MIN, -15);
    expect(alerts.check(now + 12 * MIN).map((x) => x.kind)).toEqual(['drop']);
    // an account without history yet is never "abnormal"
    const c = s.identities.create({ label: 'C' }).identity.id;
    sessions = [{ identityId: c, serverId: srv.id, serverName: 'HugoSMP', state: 'ONLINE', onlineSince: new Date(now - 10 * H).toISOString() }];
    expect(alerts.check(now + 13 * MIN)).toEqual([]);
    // stored newest first, settings, off switch, test alert
    expect(alerts.list()).toHaveLength(3);
    expect(alerts.list()[0].kind).toBe('drop');
    expect(alerts.setSettings({ enabled: false, stallFactor: 100 })).toMatchObject({ enabled: false, stallFactor: 20 });
    sessions = [{ identityId: a, serverId: srv.id, serverName: 'HugoSMP', state: 'ONLINE', onlineSince: new Date(now - 10 * H).toISOString() }];
    expect(alerts.check(now + 24 * H)).toEqual([]);
    expect(alerts.test().textDe).toMatch(/Testbenachrichtigung/);
    await s.shutdown();
  });

  it('is served to the phone: summary lists the alerts of the last 24 h; API for settings and test', async () => {
    const t = await createTestSuite();
    const { buildServer } = await import('../src/web/server.js');
    const { app } = await buildServer(t.suite as any, { apiToken: 'tok' });
    const call = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as any, url, payload: payload as any, headers: { host: '127.0.0.1:7420', 'x-hoelni-token': 'tok' } });
    const r1 = await call('POST', '/api/stars/alerts/test');
    expect(r1.statusCode).toBe(200);
    const sum = (await call('GET', '/api/summary')).json();
    expect(sum.starAlerts).toHaveLength(1);
    expect(sum.starAlerts[0]).toMatchObject({ kind: 'test', id: r1.json().id });
    const put = await call('PUT', '/api/stars/alerts/settings', { dropMin: 0 });
    expect(put.json().dropMin).toBe(0);
    expect((await call('GET', '/api/stars/alerts')).json().settings.dropMin).toBe(0);
    await app.close();
    await t.suite.shutdown();
  });
});
