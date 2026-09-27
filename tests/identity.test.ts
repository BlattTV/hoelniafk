import { describe, expect, it, vi } from 'vitest';
import { createTestSuite, tick } from './helpers.js';

async function fullIdentity() {
  const t = await createTestSuite();
  const { suite } = t;
  const smp = suite.repo.upsertServer({ name: 'SMP', host: 'smp.example.com' });
  const id = suite.identities.create({ label: 'Identity07', settings: { discordLinking: 'required' } }).identity.id;
  // Phase C – mail
  const box = suite.repo.createMailAccount({
    label: 'Mail 07', kind: 'imap', imapHost: 'imap.example.com', imapPort: 993, imapSecure: true, username: 'mail07@example.com',
    smtpHost: null, smtpPort: null, webmailUrl: 'https://mail.example.com', exclusiveIdentityId: id, aliasProviderId: null,
  });
  await suite.mail.setMailboxPassword(box.id, 'pw');
  suite.repo.assignMail(id, { mailAccountId: box.id, address: 'mail07@example.com' });
  t.mailServer.add('mail07@example.com', { uid: 1, from: 'noreply@discord.com', to: 'mail07@example.com', subject: 'Verify your email', text: 'hi' });
  await suite.mail.checkIdentity(id);
  // Phase B – minecraft
  suite.repo.upsertMinecraft(id, { username: 'Player07', authType: 'microsoft', msaAccount: 'acc07@example.com' });
  await suite.auth.authenticate(id);
  // Phase D – discord
  const { url } = await suite.discord.beginConnect(id);
  const r = await suite.oauth.complete(new URL(url).searchParams.get('state')!, 'code-7');
  await suite.discord.completeConnect(id, r.tokens);
  // Phase E – network
  suite.repo.createNetworkProfile(id, { kind: 'BIND', localBindIp: '10.0.0.7', expectedPublicIp: '203.0.113.7' });
  await suite.network.verify(id);
  // Server + session
  suite.repo.assignServer(id, { serverId: smp.id, autoStart: true });
  await suite.sessions.start(id, smp.id);
  return { ...t, id, smp, box };
}

describe('Phase F – one complete identity', () => {
  it('turns fully green once linking is confirmed in chat', async () => {
    const { suite, id, bots } = await fullIdentity();
    expect(suite.identities.health(id).ready).toBe(false);
    bots[0].join();
    let h = suite.identities.health(id);
    expect(h.milestone.find((m) => m.label === 'Discord Link')!.ok).toBe(false);
    expect(h.level).toBe('ERROR'); // linking is "required"

    bots[0].say('Link your account using code ABC123');
    expect(suite.linking.pendingFor(id)!.code).toBe('ABC123');
    expect(suite.identities.dashboard()[0].discord.pendingLinkCode).toBe('ABC123');
    expect(suite.repo.getDiscord(id)!.linkState).toBe('WAITING');

    bots[0].say('Discord linked successfully');
    h = suite.identities.health(id);
    expect(suite.repo.getDiscord(id)!.linkedToMinecraft).toBe(true);
    expect(h.milestone).toEqual([
      { label: 'Minecraft', ok: true, target: 'minecraft' },
      { label: 'Mail', ok: true, target: 'mail' },
      { label: 'Discord', ok: true, target: 'discord' },
      { label: 'Discord Link', ok: true, target: 'discord' },
      { label: 'Exit IP', ok: true, target: 'network' },
      { label: 'Session', ok: true, target: 'sessions' },
    ]);
    expect(h.level).toBe('HEALTHY');
    expect(h.ready).toBe(true);
  });

  it('flags an exit IP mismatch as an error pointing at the network section', async () => {
    const { suite, id, ipByProfile } = await fullIdentity();
    const p = suite.repo.listNetworkProfiles(id)[0];
    ipByProfile.set(p.id, '198.51.100.99');
    await suite.network.verify(id);
    const check = suite.identities.health(id).checks.find((c) => c.key === 'expectedIp')!;
    expect(check).toMatchObject({ status: 'error', target: 'network' });
    expect(suite.audit.list().some((e) => e.action === 'Network IP changed')).toBe(true);
  });

  it('tracks rewards from chat', async () => {
    const { suite, id, bots } = await fullIdentity();
    bots[0].join();
    bots[0].say('You have 20 stars');
    bots[0].say('You received 4 stars');
    expect(suite.repo.getRewards(id).stars).toBe(24);
    expect(suite.repo.rewardHistory(id).map((h) => h.delta)).toEqual([4, 20]);
  });
});

describe('templates and clone', () => {
  it('creates identities from a template', async () => {
    const { suite } = await createTestSuite();
    for (const name of ['SMP', 'Event', 'Test']) suite.repo.upsertServer({ name, host: `${name.toLowerCase()}.example.com` });
    const t = suite.repo.saveTemplate({
      name: 'Default AFK Identity',
      config: {
        settings: { autoReconnect: true, mailEnabled: true, discordLinking: 'required' },
        servers: ['SMP', 'Event', 'Test', 'Missing'],
        network: { mode: 'PER_ACCOUNT' },
      },
    });
    const { identity, warnings } = suite.identities.create({ templateId: t.id });
    expect(identity.settings.discordLinking).toBe('required');
    expect(identity.settings.networkMode).toBe('PER_ACCOUNT');
    expect(suite.repo.listAssignments(identity.id)).toHaveLength(3);
    expect(warnings[0]).toMatch(/Missing/);
  });

  it('templates cannot carry credential references', async () => {
    const { suite } = await createTestSuite();
    expect(() =>
      suite.repo.saveTemplate({ name: 'x', config: { settings: { ui: { tags: ['vault://identity/1/mail'] } }, servers: [], network: { mode: 'DIRECT' } } }),
    ).toThrow(/credential/);
  });

  it('clones an identity without any secrets or accounts', async () => {
    const { suite, id, store } = await fullIdentity();
    suite.repo.updateIdentity(id, { settings: { afk: { enabled: true, action: 'jump', intervalSec: 30 }, parsers: ['hoelni-linking'], ui: { tags: ['afk'], color: '#ff0' } } });
    const before = await store.list();
    const clone = suite.identities.clone(id, 'Identity08');
    expect(clone.settings.afk.action).toBe('jump');
    expect(clone.settings.parsers).toEqual(['hoelni-linking']);
    expect(clone.settings.ui.tags).toEqual(['afk']);
    expect(suite.repo.listAssignments(clone.id).map((a) => a.serverId)).toEqual(suite.repo.listAssignments(id).map((a) => a.serverId));
    expect(suite.repo.getMinecraft(clone.id)).toBeNull();
    expect(suite.repo.getMailIdentity(clone.id)).toBeNull();
    expect(suite.repo.getDiscord(clone.id)).toBeNull();
    expect(suite.repo.listNetworkProfiles(clone.id)).toEqual([]);
    expect(await suite.vault.forIdentity(clone.id).list()).toEqual([]);
    expect(await store.list()).toEqual(before);
    const cloneHealth = suite.identities.health(clone.id);
    expect(cloneHealth.checks.find((c) => c.key === 'minecraftAuth')!.status).toBe('error');
  });

  it('saves an identity as template without secrets', async () => {
    const { suite, id } = await fullIdentity();
    const t = suite.identities.saveAsTemplate(id, 'From 07');
    expect(t.config.servers).toEqual(['SMP']);
    expect(JSON.stringify(t.config)).not.toMatch(/vault:|10\.0\.0\.7|203\.0\.113/);
  });
});

describe('sessions', () => {
  it('auto-reconnects after a disconnect and can be stopped', async () => {
    vi.useFakeTimers();
    try {
      const { suite, id, smp, bots } = await fullIdentity();
      bots[0].join();
      bots[0].emit('end', 'socketClosed');
      expect(suite.sessions.list(id)[0].state).toBe('RECONNECTING');
      await vi.advanceTimersByTimeAsync(16_000);
      expect(bots).toHaveLength(2);
      bots[1].join();
      expect(suite.sessions.list(id)[0].state).toBe('ONLINE');
      suite.sessions.stop(`${id}:${smp.id}`);
      await vi.runAllTimersAsync();
      expect(suite.sessions.list(id)[0].state).toBe('STOPPED');
      expect(bots).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports several servers per identity at the same time', async () => {
    const { suite, id, bots } = await fullIdentity();
    const ev = suite.repo.upsertServer({ name: 'Event', host: 'event.example.com' });
    suite.repo.assignServer(id, { serverId: ev.id });
    await suite.sessions.startAll(id);
    bots.forEach((b) => b.join());
    expect(suite.sessions.list(id).map((s) => s.state)).toEqual(['ONLINE', 'ONLINE']);
    expect(suite.identities.health(id).checks.find((c) => c.key === 'sessions')!.detail).toBe('2/2 online');
  });
});

describe('bulk operations', () => {
  it('checks a shared mailbox only once for several identities', async () => {
    const { suite, mailServer } = await createTestSuite();
    const box = suite.repo.createMailAccount({
      label: 'shared', kind: 'imap', imapHost: 'imap.example.com', imapPort: 993, imapSecure: true, username: 'real@example.com',
      smtpHost: null, smtpPort: null, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: null,
    });
    await suite.mail.setMailboxPassword(box.id, 'pw');
    const ids = [1, 2, 3].map((n) => {
      const i = suite.identities.create({}).identity;
      suite.repo.assignMail(i.id, { mailAccountId: box.id, address: `mc0${n}@example.com`, isAlias: true });
      return i.id;
    });
    const res = await suite.bulk.run('checkMail', ids);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(mailServer.listCalls).toBe(1);
    const open = await suite.bulk.run('openMail', ids);
    expect(open[0]).toMatchObject({ ok: false });
    await tick();
  });
});
