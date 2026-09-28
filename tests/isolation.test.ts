/**
 * Privacy / isolation: an identity must never use another identity's
 *   - mailbox / mails
 *   - Discord connection
 *   - network profile
 *   - Minecraft token
 */
import { describe, expect, it } from 'vitest';
import { ConflictError, IsolationError } from '../src/core/errors.js';
import { refs } from '../src/vault/refs.js';
import { createTestSuite, tick, waitFor } from './helpers.js';

async function twoIdentities() {
  const t = await createTestSuite();
  const a = t.suite.identities.create({ label: 'Identity01' }).identity;
  const b = t.suite.identities.create({ label: 'Identity02' }).identity;
  return { ...t, a, b };
}

describe('mail isolation', () => {
  async function sharedMailbox() {
    const t = await twoIdentities();
    const box = t.suite.repo.createMailAccount({
      label: 'shared',
      kind: 'imap',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecure: true,
      username: 'real@example.com',
      smtpHost: null,
      smtpPort: null,
      webmailUrl: null,
      exclusiveIdentityId: null,
      aliasProviderId: null,
    });
    await t.suite.mail.setMailboxPassword(box.id, 'imap-secret-password');
    t.suite.repo.assignMail(t.a.id, { mailAccountId: box.id, address: 'mc01@example.com', isAlias: true });
    t.suite.repo.assignMail(t.b.id, { mailAccountId: box.id, address: 'mc02@example.com', isAlias: true });
    t.mailServer.add('real@example.com', { uid: 1, from: 'noreply@discord.com', to: 'mc01@example.com', subject: 'Verify your email', text: 'Code: AB12CD' });
    t.mailServer.add('real@example.com', { uid: 2, from: 'account-security-noreply@accountprotection.microsoft.com', to: 'mc02@example.com', subject: 'Microsoft account security code', text: 'Security code: 482913' });
    t.mailServer.add('real@example.com', { uid: 3, from: 'someone@else.org', to: 'real@example.com', subject: 'Unrelated', text: 'hi' });
    await t.suite.mail.syncMailbox(box.id);
    return { ...t, box };
  }

  it('aliases on a shared mailbox only expose mails addressed to the identity', async () => {
    const { suite, a, b } = await sharedMailbox();
    const listA = suite.mail.listForIdentity(a.id);
    const listB = suite.mail.listForIdentity(b.id);
    expect(listA.map((m) => m.uid)).toEqual([1]);
    expect(listB.map((m) => m.uid)).toEqual([2]);
    expect(suite.repo.getMailIdentity(a.id)!.unreadCount).toBe(1);
  });

  it('refuses to open a message of another identity', async () => {
    const { suite, a, b } = await sharedMailbox();
    const msgB = suite.mail.listForIdentity(b.id)[0];
    await expect(suite.mail.getMessage(a.id, msgB.id)).rejects.toBeInstanceOf(IsolationError);
    await expect(suite.mail.getAttachment(a.id, msgB.id, 0)).rejects.toBeInstanceOf(IsolationError);
    await expect(suite.mail.setSeen(a.id, msgB.id, true)).rejects.toBeInstanceOf(IsolationError);
    const own = await suite.mail.getMessage(b.id, msgB.id);
    expect(own.codes).toContain('482913');
  });

  it('unaddressed mails stay unassigned and can only be assigned to identities of the same mailbox', async () => {
    const { suite, a, box } = await sharedMailbox();
    const unassigned = suite.mail.unassigned(box.id);
    expect(unassigned.map((m) => m.uid)).toEqual([3]);
    const c = suite.identities.create({ label: 'Identity03' }).identity;
    const other = suite.repo.createMailAccount({
      label: 'other', kind: 'imap', imapHost: 'x', imapPort: 993, imapSecure: true, username: 'other@example.com',
      smtpHost: null, smtpPort: null, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: null,
    });
    suite.repo.assignMail(c.id, { mailAccountId: other.id, address: 'other@example.com' });
    expect(() => suite.mail.assignMessage(unassigned[0].id, c.id)).toThrow(IsolationError);
    suite.mail.assignMessage(unassigned[0].id, a.id);
    expect(suite.mail.listForIdentity(a.id).map((m) => m.uid).sort()).toEqual([1, 3]);
    // manual assignment survives a re-sync
    await suite.mail.syncMailbox(box.id);
    expect(suite.mail.listForIdentity(a.id).map((m) => m.uid).sort()).toEqual([1, 3]);
  });

  it('an address can only belong to one identity and exclusive mailboxes are enforced', async () => {
    const { suite, a, b, box } = await sharedMailbox();
    expect(() => suite.repo.assignMail(b.id, { mailAccountId: box.id, address: 'MC01@example.com' })).toThrow(ConflictError);
    const excl = suite.repo.createMailAccount({
      label: 'excl', kind: 'imap', imapHost: 'x', imapPort: 993, imapSecure: true, username: 'solo@example.com',
      smtpHost: null, smtpPort: null, webmailUrl: null, exclusiveIdentityId: a.id, aliasProviderId: null,
    });
    expect(() => suite.repo.assignMail(b.id, { mailAccountId: excl.id, address: 'solo@example.com' })).toThrow(IsolationError);
  });

  it('a mail addressed to two identities at once is never guessed', async () => {
    const { suite, box, mailServer } = await sharedMailbox();
    mailServer.add('real@example.com', { uid: 4, from: 'x@y.z', to: 'mc01@example.com, mc02@example.com', subject: 'both', text: '' });
    await suite.mail.syncMailbox(box.id);
    expect(suite.mail.unassigned(box.id).map((m) => m.uid)).toContain(4);
  });
});

describe('discord isolation', () => {
  it('setting up Discord for A never touches B, and each identity has its own sign-up password', async () => {
    const { suite, a, b } = await twoIdentities();
    suite.discord.markReady(a.id, 'player_a');
    expect(suite.repo.getDiscord(a.id)).toMatchObject({ oauthState: 'CONNECTED', username: 'player_a' });
    expect(suite.repo.getDiscord(b.id)?.oauthState ?? 'NONE').toBe('NONE');
    const pa = await suite.discord.password(a.id);
    const pb = await suite.discord.password(b.id);
    expect(pa).not.toBe(pb);
    expect(await suite.discord.password(a.id)).toBe(pa);
    expect(await suite.vault.forIdentity(a.id).get(refs.identity(a.id, 'discord-password'))).toBe(pa);
  });
});

describe('network isolation', () => {
  it('network profiles of another identity cannot be used as default or session override', async () => {
    const { suite, a, b } = await twoIdentities();
    const pb = suite.repo.createNetworkProfile(b.id, { kind: 'BIND', name: 'b', localBindIp: '10.0.0.2' });
    const server = suite.repo.upsertServer({ name: 'SMP', host: 'mc.example.com' });
    expect(() => suite.repo.updateIdentity(a.id, { networkProfileId: pb.id })).toThrow(IsolationError);
    expect(() => suite.repo.assignServer(a.id, { serverId: server.id, networkProfileId: pb.id })).toThrow(IsolationError);
    await expect(suite.network.resolve(a.id, pb.id)).rejects.toBeInstanceOf(IsolationError);
    await expect(suite.network.verify(a.id, pb.id)).rejects.toBeInstanceOf(IsolationError);
    expect(() => suite.repo.updateNetworkProfile(a.id, pb.id, { localBindIp: '10.0.0.9' })).toThrow(IsolationError);
  });

  it('proxy credentials are resolved from the owning identity only', async () => {
    const { suite, a, b, ipCalls } = await twoIdentities();
    const pa = suite.repo.createNetworkProfile(a.id, { kind: 'SOCKS5', proxyHost: 'p.example', proxyPort: 1080, proxyUsername: 'ua', expectedPublicIp: '198.51.100.1' });
    const pb = suite.repo.createNetworkProfile(b.id, { kind: 'SOCKS5', proxyHost: 'p.example', proxyPort: 1081, proxyUsername: 'ub', expectedPublicIp: '198.51.100.2' });
    await suite.network.setProxyPassword(a.id, pa.id, 'proxy-pass-A');
    await suite.network.setProxyPassword(b.id, pb.id, 'proxy-pass-B');
    await suite.network.verify(a.id);
    expect(ipCalls.at(-1)!.profile!.id).toBe(pa.id);
    expect(ipCalls.at(-1)!.password).toBe('proxy-pass-A');
    // A profile that points at another identity's vault entry is rejected.
    suite.repo.db.prepare('UPDATE network_profiles SET credential_ref = ? WHERE id = ?').run(refs.identity(b.id, 'network', pb.id), pa.id);
    await expect(suite.network.resolve(a.id)).rejects.toBeInstanceOf(IsolationError);
  });

  it('sessions use the identity\'s own profile (or its own per-session override)', async () => {
    const { suite, a, bots } = await twoIdentities();
    const main = suite.repo.createNetworkProfile(a.id, { kind: 'BIND', name: 'main', localBindIp: '10.0.0.1' });
    const alt = suite.repo.createNetworkProfile(a.id, { kind: 'BIND', name: 'alt', localBindIp: '10.0.0.11' });
    const s1 = suite.repo.upsertServer({ name: 'SMP', host: 'smp.example.com' });
    const s2 = suite.repo.upsertServer({ name: 'Event', host: 'event.example.com' });
    suite.repo.upsertMinecraft(a.id, { username: 'Player01', authType: 'offline' });
    suite.repo.assignServer(a.id, { serverId: s1.id });
    suite.repo.assignServer(a.id, { serverId: s2.id, networkProfileId: alt.id });
    await suite.sessions.startAll(a.id);
    await waitFor(() => bots.length === 2, 2000, 'two bots');
    const byServer = (sid: number) => bots.find((b) => b.spec.server.id === sid)!;
    expect(byServer(s1.id).spec.network.profile!.id).toBe(main.id);
    expect(byServer(s2.id).spec.network.profile!.id).toBe(alt.id);
    expect(bots.every((x) => x.spec.identityId === a.id)).toBe(true);
  });
});

describe('minecraft token isolation', () => {
  it('tokens are stored per identity and never visible to another identity\'s cache', async () => {
    const { suite, a, b, store } = await twoIdentities();
    suite.repo.upsertMinecraft(a.id, { username: 'Player01', authType: 'microsoft', msaAccount: 'acc01@example.com' });
    suite.repo.upsertMinecraft(b.id, { username: 'Player02', authType: 'microsoft', msaAccount: 'acc02@example.com' });
    await suite.auth.authenticate(a.id);
    await suite.auth.authenticate(b.id);
    expect(await store.list()).toEqual([refs.identity(a.id, 'minecraft'), refs.identity(b.id, 'minecraft')]);

    const cacheB = suite.auth.cacheFactoryFor(b.id)({ username: 'acc02@example.com', cacheName: 'mca' });
    expect((await cacheB.getCached()).token).toBe('mc-token-for-acc02@example.com');

    // A scoped vault refuses cross-identity reads even with a hand-made ref.
    await expect(suite.vault.forIdentity(b.id).get(refs.identity(a.id, 'minecraft'))).rejects.toBeInstanceOf(IsolationError);
  });

  it('a running session only ever receives the Minecraft token of its own identity', async () => {
    const { suite, a, b, bots } = await twoIdentities();
    for (const [id, n] of [[a.id, '01'], [b.id, '02']] as const) {
      suite.repo.upsertMinecraft(id, { username: `Player${n}`, authType: 'microsoft', msaAccount: `acc${n}@example.com` });
      await suite.auth.authenticate(id);
    }
    const server = suite.repo.upsertServer({ name: 'SMP', host: 'smp.example.com' });
    suite.repo.assignServer(a.id, { serverId: server.id });
    suite.repo.assignServer(b.id, { serverId: server.id });
    await suite.sessions.start(a.id, server.id);
    await suite.sessions.start(b.id, server.id);
    await waitFor(() => bots.length === 2 && bots.every((x) => x.javaSession), 2000, 'java sessions');
    const botA = bots.find((x) => x.spec.identityId === a.id)!;
    const botB = bots.find((x) => x.spec.identityId === b.id)!;
    expect(botA.spec.username).toBe('acc01@example.com');
    expect(botA.javaSession!.accessToken).toBe('mc-token-for-acc01@example.com');
    expect(botB.javaSession!.accessToken).toBe('mc-token-for-acc02@example.com');
    expect(botA.javaSession!.profile.name).toBe('Player01');
  });

  it('the same Minecraft account (UUID) cannot belong to two identities', async () => {
    const { suite, a, b } = await twoIdentities();
    suite.repo.upsertMinecraft(a.id, { username: 'Player01', authType: 'microsoft', msaAccount: 'acc01@example.com' });
    await suite.auth.authenticate(a.id);
    expect(() => suite.repo.upsertMinecraft(b.id, { username: 'Player01', authType: 'microsoft', msaAccount: 'acc01@example.com' })).toThrow(ConflictError);
  });

  it('refuses to silently switch the account behind an identity', async () => {
    const { suite, a } = await twoIdentities();
    suite.repo.upsertMinecraft(a.id, { username: 'Player01', authType: 'microsoft', msaAccount: 'acc01@example.com' });
    await suite.auth.authenticate(a.id);
    suite.repo.upsertMinecraft(a.id, { msaAccount: 'acc05@example.com' });
    await expect(suite.auth.authenticate(a.id)).rejects.toThrow(/refusing to mix accounts/);
  });
});

describe('deleting an identity', () => {
  it('purges only its own secrets', async () => {
    const { suite, a, b, store } = await twoIdentities();
    for (const [id, n] of [[a.id, '01'], [b.id, '02']] as const) {
      suite.repo.upsertMinecraft(id, { username: `Player${n}`, authType: 'microsoft', msaAccount: `acc${n}@example.com` });
      await suite.auth.authenticate(id);
    }
    await suite.identities.delete(a.id);
    await tick();
    expect(await store.list()).toEqual([refs.identity(b.id, 'minecraft')]);
  });
});

describe('concurrency', () => {
  it('parallel checks of one shared mailbox use a single IMAP sync', async () => {
    const { suite, mailServer } = await createTestSuite();
    const box = suite.repo.createMailAccount({
      label: 'shared', kind: 'imap', imapHost: 'x', imapPort: 993, imapSecure: true, username: 'real@example.com',
      smtpHost: null, smtpPort: null, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: null,
    });
    await suite.mail.setMailboxPassword(box.id, 'pw');
    const ids = [1, 2, 3, 4].map((n) => {
      const id = suite.identities.create({}).identity.id;
      suite.repo.assignMail(id, { mailAccountId: box.id, address: `mc0${n}@example.com`, isAlias: true });
      return id;
    });
    await Promise.all(ids.map((id) => suite.mail.checkIdentity(id)));
    expect(mailServer.listCalls).toBe(1);
  });
});
