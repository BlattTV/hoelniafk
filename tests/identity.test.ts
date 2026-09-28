import { describe, expect, it } from 'vitest';
import { createTestSuite, settle, tick, waitFor } from './helpers.js';

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
  suite.discord.markReady(id, 'discorduser7');
  // Phase E – network
  suite.repo.createNetworkProfile(id, { kind: 'BIND', localBindIp: '10.0.0.7', expectedPublicIp: '203.0.113.7' });
  await suite.network.verify(id);
  // Server + session
  suite.repo.assignServer(id, { serverId: smp.id, autoStart: true });
  await suite.sessions.start(id, smp.id);
  await waitFor(() => t.bots.length === 1, 2000, 'bot');
  return { ...t, id, smp, box };
}

describe('Phase F – one complete identity', () => {
  it('turns fully green once linking is confirmed in chat', async () => {
    const { suite, id, bots } = await fullIdentity();
    expect(suite.identities.health(id).ready).toBe(false);
    bots[0].join();
    await settle();
    let h = suite.identities.health(id);
    expect(h.milestone.find((m) => m.label === 'Discord Link')!.ok).toBe(false);
    expect(h.level).toBe('ERROR'); // linking is "required"

    bots[0].say('Link your account using code ABC123');
    await settle();
    expect(suite.linking.pendingFor(id)!.code).toBe('ABC123');
    expect(suite.identities.dashboard()[0].discord.pendingLinkCode).toBe('ABC123');
    expect(suite.repo.getDiscord(id)!.linkState).toBe('WAITING');

    bots[0].say('Discord linked successfully');
    await settle();
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

  it('tracks rewards per server from configurable chat rules', async () => {
    const { suite, id, bots, smp } = await fullIdentity();
    bots[0].join();
    bots[0].say('You have 20 stars');
    bots[0].say('You received 4 stars');
    bots[0].say('You are eligible for rewards');
    bots[0].say('Reward pending – please wait');
    await settle();
    let st = suite.repo.getServerReward(id, smp.id);
    expect(st).toMatchObject({ stars: 24, eligible: true, waiting: true, received: null });
    bots[0].say('Reward received!');
    bots[0].say('Discord linked successfully');
    await settle();
    st = suite.repo.getServerReward(id, smp.id);
    expect(st).toMatchObject({ received: true, waiting: false, discordLinked: true });
    expect(st.lastMessage).toBe('Discord linked successfully');
    expect(suite.repo.getRewards(id)).toMatchObject({ stars: 24, eligible: true });
    const hist = suite.repo.rewardHistory(id, 50, smp.id);
    expect(hist.filter((h) => h.kind === 'stars').map((h) => h.delta)).toEqual([4, 20]);
    expect(hist.map((h) => h.kind)).toEqual(expect.arrayContaining(['eligible', 'waiting', 'received', 'discordLinked']));
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
  it('keeps a desired-online session online (reconnect after disconnect) and stops on request', async () => {
    const { suite, id, smp, bots } = await fullIdentity();
    const sid = `${id}:${smp.id}`;
    bots[0].join();
    await settle();
    expect(suite.sessions.getState(sid).state).toBe('ONLINE');
    bots[0].emit('end', 'socketClosed');
    await settle();
    expect(suite.sessions.getState(sid).state).toBe('RECONNECTING');
    await waitFor(() => bots.length === 2, 3000, 'reconnect');
    bots[1].join();
    await settle();
    expect(suite.sessions.getState(sid)).toMatchObject({ state: 'ONLINE', reconnects: 1, desiredState: 'ONLINE' });
    await suite.sessions.stopSession(sid);
    expect(suite.sessions.getState(sid)).toMatchObject({ state: 'STOPPED', desiredState: 'OFFLINE' });
    await new Promise((r) => setTimeout(r, 400));
    expect(bots).toHaveLength(2);
  });

  it('blocks automatic reconnects when the kick reason matches a block rule', async () => {
    const { suite, id, smp, bots } = await fullIdentity();
    const sid = `${id}:${smp.id}`;
    bots[0].join();
    bots[0].emit('kicked', '{"text":"You are banned from this server"}');
    bots[0].emit('end', 'kicked');
    await settle();
    const st = suite.sessions.getState(sid);
    expect(st.state).toBe('BLOCKED');
    expect(st.lastError).toMatch(/banned/);
    await new Promise((r) => setTimeout(r, 300));
    expect(bots).toHaveLength(1);
    // explicit user action overrides the block
    await suite.sessions.startSession(id, smp.id);
    await waitFor(() => bots.length === 2);
  });

  it('supports several servers per identity at the same time', async () => {
    const { suite, id, bots } = await fullIdentity();
    const ev = suite.repo.upsertServer({ name: 'Event', host: 'event.example.com' });
    suite.repo.assignServer(id, { serverId: ev.id });
    await suite.sessions.startAll(id);
    await waitFor(() => bots.length === 2);
    bots.forEach((b) => b.join());
    await settle();
    expect(suite.sessions.list(id).map((s) => s.state)).toEqual(['ONLINE', 'ONLINE']);
    expect(suite.identities.health(id).checks.find((c) => c.key === 'sessions')!.detail).toBe('2/2 online');
  });

  it('restores desired sessions through the reconciler and isolates a crashed runtime host', async () => {
    const { suite, id, smp, bots } = await fullIdentity();
    bots[0].join();
    await settle();
    const sid = `${id}:${smp.id}`;
    (suite.runtime as any).crashHostOf(sid);
    await settle();
    expect(suite.sessions.getState(sid).state).toBe('RECONNECTING');
    expect(suite.sessions.getState(sid).lastEndReason).toBe('runtimeCrash');
    await waitFor(() => bots.length === 2, 3000, 'restart after crash');
    bots[1].join();
    await settle();
    expect(suite.sessions.getState(sid).state).toBe('ONLINE');
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

describe('session restore after restart', () => {
  it('brings desired sessions back online when the suite starts again', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { openDatabase } = await import('../src/core/db.js');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-restore-')), 'hoelni.db');
    const first = await createTestSuite({ db: openDatabase(file) });
    const srv = first.suite.repo.upsertServer({ name: 'SMP', host: 'smp.example.com' });
    const id = first.suite.identities.create({}).identity.id;
    first.suite.repo.upsertMinecraft(id, { username: 'Player01', authType: 'offline' });
    first.suite.repo.assignServer(id, { serverId: srv.id });
    await first.suite.sessions.startSession(id, srv.id);
    await waitFor(() => first.bots.length === 1);
    first.bots[0].join();
    await settle();
    await first.suite.shutdown(); // desired state stays ONLINE

    const second = await createTestSuite({ db: openDatabase(file) });
    second.suite.sessions.startReconciler();
    await waitFor(() => second.bots.length === 1, 3000, 'restored session');
    second.bots[0].join();
    await settle();
    expect(second.suite.sessions.getState(`${id}:${srv.id}`).state).toBe('ONLINE');
    await second.suite.shutdown();
  });
});
