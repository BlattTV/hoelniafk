import { describe, expect, it } from 'vitest';
import { parseProxyList } from '../src/network/proxyPool.js';
import { createTestSuite } from './helpers.js';

describe('proxy list parser', () => {
  it('reads the common formats and reports bad lines without passwords', () => {
    const { proxies, errors } = parseProxyList(
      [
        '# comment',
        'socks5://alice:s3cr%40t@Proxy1.example:1080',
        'http://10.0.0.2:3128',
        '10.0.0.3:1080',
        '10.0.0.4:1080:bob:hunter2',
        'carol:pw@10.0.0.5:8080',
        'ftp://x:1',
        '10.0.0.6:99999',
        'nonsense',
      ].join('\n'),
      'SOCKS5',
    );
    expect(proxies).toEqual([
      { kind: 'SOCKS5', host: 'proxy1.example', port: 1080, username: 'alice', password: 's3cr@t' },
      { kind: 'HTTP', host: '10.0.0.2', port: 3128, username: null, password: null },
      { kind: 'SOCKS5', host: '10.0.0.3', port: 1080, username: null, password: null },
      { kind: 'SOCKS5', host: '10.0.0.4', port: 1080, username: 'bob', password: 'hunter2' },
      { kind: 'SOCKS5', host: '10.0.0.5', port: 8080, username: 'carol', password: 'pw' },
    ]);
    expect(errors.map((e) => e.line)).toEqual([7, 8, 9]);
    expect(JSON.stringify(errors)).not.toMatch(/hunter2|s3cr/);
  });
});

async function poolSuite() {
  // Exit IP per proxy host; 10.0.0.9 is dead, .3 and .4 share an exit.
  const exits: Record<string, string> = { '10.0.0.1': '198.51.100.1', '10.0.0.2': '198.51.100.2', '10.0.0.3': '198.51.100.3', '10.0.0.4': '198.51.100.3' };
  const seen: Array<{ host: string | null; password: string | null }> = [];
  const t = await createTestSuite({
    ipDetector: async (profile, secret) => {
      seen.push({ host: profile?.proxyHost ?? null, password: secret?.password ?? null });
      const ip = profile?.proxyHost ? exits[profile.proxyHost] : undefined;
      if (!ip) throw new Error('connect ECONNREFUSED');
      return ip;
    },
  });
  return { ...t, seen };
}

describe('proxy pool', () => {
  it('imports without storing passwords in SQLite, deduplicates and tests every proxy', async () => {
    const { suite, seen } = await poolSuite();
    const r = await suite.proxies.import('10.0.0.1:1080:u1:pw-one\n10.0.0.2:1080:u2:pw-two\n10.0.0.3:1080\n10.0.0.4:1080\n10.0.0.9:1080\n10.0.0.1:1080:u1:pw-one', { label: 'batch A' });
    expect(r).toMatchObject({ added: 5, duplicates: 1, errors: [] });
    const dump = JSON.stringify(suite.db.prepare('SELECT * FROM proxies').all());
    expect(dump).not.toMatch(/pw-one|pw-two/);
    expect(JSON.stringify(suite.proxies.list())).not.toMatch(/pw-one|pw-two/);

    const res = await suite.proxies.testAll();
    expect(res).toEqual({ ok: 4, error: 1 });
    const list = suite.proxies.list();
    expect(list.find((p) => p.host === '10.0.0.9')).toMatchObject({ status: 'ERROR', exitIp: null });
    expect(list.find((p) => p.host === '10.0.0.1')).toMatchObject({ status: 'OK', exitIp: '198.51.100.1', hasPassword: true });
    expect(list.find((p) => p.host === '10.0.0.3')!.sameExitAs).toEqual([list.find((p) => p.host === '10.0.0.4')!.id]);
    // The stored password was used for the test.
    expect(seen.find((s) => s.host === '10.0.0.1')?.password).toBe('pw-one');
    await suite.shutdown();
  });

  it('auto-assigns one proxy per identity with distinct exit IPs; credentials move into the identity scope', async () => {
    const { suite, store } = await poolSuite();
    await suite.proxies.import('10.0.0.1:1080:u1:pw-one\n10.0.0.2:1080\n10.0.0.3:1080\n10.0.0.4:1080\n10.0.0.9:1080');
    await suite.proxies.testAll();
    const ids = [1, 2, 3, 4].map((n) => suite.identities.create({ label: `Id${n}` }).identity.id);
    const r = await suite.proxies.autoAssign();
    // 3 distinct working exits (.3/.4 share one) → the 4th identity is skipped.
    expect(r.assigned).toHaveLength(3);
    expect(r.skipped).toEqual([{ identityId: ids[3], reason: expect.stringMatching(/No free, tested proxy/) }]);
    const exitsUsed = suite.proxies.list().filter((p) => p.identityId).map((p) => p.exitIp);
    expect(new Set(exitsUsed).size).toBe(3);

    // The identity with the authenticated proxy resolves its own profile + secret.
    const withAuth = suite.proxies.list().find((p) => p.host === '10.0.0.1')!;
    const net = await suite.network.resolve(withAuth.identityId!);
    expect(net.profile).toMatchObject({ kind: 'SOCKS5', proxyHost: '10.0.0.1', proxyPort: 1080, proxyUsername: 'u1', expectedPublicIp: '198.51.100.1' });
    expect(net.secret?.password).toBe('pw-one');
    expect(net.profile!.credentialRef).toMatch(new RegExp(`^vault://identity/${withAuth.identityId}/`));

    // Assigning again is idempotent; a proxy used by someone else cannot be taken.
    expect((await suite.proxies.assign(withAuth.identityId!)).id).toBe(withAuth.id);
    await expect(suite.proxies.assign(ids[3], withAuth.id)).rejects.toThrow(/already used/);

    // Release: the identity's pool profile and its copied secret are gone.
    await suite.proxies.release(withAuth.id);
    expect(suite.repo.getIdentity(withAuth.identityId!).networkProfileId).toBeNull();
    expect(await suite.vault.forIdentity(withAuth.identityId!).list()).not.toContain(net.profile!.credentialRef);
    expect(suite.proxies.list().find((p) => p.id === withAuth.id)!.identityId).toBeNull();

    // Remove deletes the pool secret too.
    await suite.proxies.remove(withAuth.id);
    expect(await store.list('vault://app/proxy/')).toEqual([]);
    const audit = JSON.stringify(suite.audit.list({ limit: 200 }));
    expect(audit).not.toMatch(/pw-one/);
    await suite.shutdown();
  });
});

describe('backend connection proxy', () => {
  it('is kept in the vault, shown only masked, and migrated out of SQLite', async () => {
    const { suite } = await createTestSuite();
    await suite.backend.setProxy('socks5://me:top-secret-pw@proxy.example:1080');
    expect(suite.backend.status().proxy).toBe('socks5://me:•••@proxy.example:1080');
    expect(JSON.stringify(suite.db.prepare('SELECT * FROM app_settings').all())).not.toMatch(/top-secret-pw/);
    await suite.backend.setProxy('');
    expect(suite.backend.status().proxy).toBe('');
    await suite.shutdown();

    // An older version stored the URL in SQLite: moved into the vault on start.
    const t2 = await createTestSuite();
    t2.suite.repo.setSetting('backend.proxy', 'http://u:legacy-pw@p.example:3128');
    const { BackendLink } = await import('../src/relay/backendLink.js');
    const link = new BackendLink(t2.suite.repo, t2.suite.vault, t2.suite.audit, t2.suite.bus, null);
    await link.agentList();
    expect(link.status().proxy).toBe('http://u:•••@p.example:3128');
    expect(t2.suite.repo.getSetting('backend.proxy')).toBe('');
    link.shutdown();
    await t2.suite.shutdown();
  });
});
