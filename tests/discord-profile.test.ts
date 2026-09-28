/**
 * Discord per identity: pages open in the identity's own profile (desktop window), the sign-up
 * helper keeps the generated password in the vault, the Microsoft window opens the Minecraft
 * confirmation page (code filled in) or Outlook. The suite never submits Discord forms (only redirects to Discord pages).
 */
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/web/server.js';
import { createTestSuite } from './helpers.js';

async function setup() {
  const t = await createTestSuite();
  const { app, apiToken } = await buildServer(t.suite, { apiToken: 'tok-1' });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:7420' } });
  const post = (url: string) => app.inject({ method: 'POST', url, payload: {}, headers: { host: '127.0.0.1:7420', 'x-hoelni-token': apiToken } });
  const id = t.suite.identities.create({ label: 'Disc01' }).identity.id;
  const box = t.suite.repo.createMailAccount({
    label: 'Mail', kind: 'imap', imapHost: 'imap.example.com', imapPort: 993, imapSecure: true, username: 'disc01@example.com',
    smtpHost: null, smtpPort: null, webmailUrl: null, exclusiveIdentityId: id, aliasProviderId: null,
  });
  await t.suite.mail.setMailboxPassword(box.id, 'pw');
  t.suite.repo.assignMail(id, { mailAccountId: box.id, address: 'disc01@example.com' });
  t.suite.repo.upsertMinecraft(id, { username: 'DiscPlayer', authType: 'offline' });
  return { ...t, app, get, post, id };
}

describe('Discord profile per identity', () => {
  it('redirects only to Discord pages and needs the API token', async () => {
    const { get, id, suite } = await setup();
    expect((await get(`/api/identities/${id}/discord/open?to=register`)).statusCode).toBe(401);
    const reg = await get(`/api/identities/${id}/discord/open?to=register&token=tok-1`);
    expect(reg.statusCode).toBe(302);
    expect(reg.headers.location).toBe('https://discord.com/register');
    expect(reg.headers['referrer-policy']).toBe('no-referrer');
    expect((await get(`/api/identities/${id}/discord/open?to=app&token=tok-1`)).headers.location).toBe('https://discord.com/app');
    expect((await get(`/api/identities/${id}/discord/open?to=evil&token=tok-1`)).statusCode).toBe(400);
    expect((await get(`/api/identities/${id}/discord/open?to=connect&token=tok-1`)).statusCode).toBe(400);
    expect((await get(`/api/identities/${id}/discord/open?to=verify&token=tok-1`)).statusCode).toBe(400);
  });

  it('Microsoft window: confirmation page with the code filled in, then Outlook – only Microsoft pages', async () => {
    const t = await setup();
    const mid = t.suite.identities.create({ label: 'Ms01' }).identity.id;
    let release!: () => void;
    const confirmed = new Promise<void>((r) => (release = r));
    (t.suite.auth as any).fetcher = async ({ onDeviceCode }: any) => {
      onDeviceCode({ userCode: 'AB12CD34', verificationUri: 'https://www.microsoft.com/link', expiresIn: 900 });
      await confirmed;
      return { profile: { id: '0000000000000000000000000000ab01', name: 'MsPlayer' }, accessToken: 'tok', profileKeys: null };
    };
    const bad = await t.app.inject({ method: 'POST', url: `/api/identities/${mid}/microsoft/connect`, payload: { email: 'nope' }, headers: { host: '127.0.0.1:7420', 'x-hoelni-token': 'tok-1' } });
    expect(bad.statusCode).toBe(400);
    const r = (await t.app.inject({ method: 'POST', url: `/api/identities/${mid}/microsoft/connect`, payload: { email: 'Ms01@Outlook.com' }, headers: { host: '127.0.0.1:7420', 'x-hoelni-token': 'tok-1' } })).json();
    expect(r).toMatchObject({ email: 'ms01@outlook.com', deviceCode: { userCode: 'AB12CD34' }, authStatus: 'PENDING' });
    expect((await t.get(`/api/identities/${mid}/microsoft/open?to=link`)).statusCode).toBe(401);
    const link = await t.get(`/api/identities/${mid}/microsoft/open?to=link&token=tok-1`);
    expect(link.statusCode).toBe(302);
    expect(link.headers.location).toBe('https://www.microsoft.com/link?otc=AB12CD34');
    release();
    await new Promise((res) => setTimeout(res, 50));
    expect(t.suite.repo.getMinecraft(mid)).toMatchObject({ username: 'MsPlayer', authStatus: 'AUTHENTICATED', msaAccount: 'ms01@outlook.com' });
    expect((await t.get(`/api/identities/${mid}/microsoft/open?to=outlook&token=tok-1`)).headers.location).toBe('https://outlook.live.com/mail/0/');
    expect((await t.get(`/api/identities/${mid}/microsoft/open?to=evil&token=tok-1`)).statusCode).toBe(400);
    // the Discord sign-up helper uses the Microsoft address when there is no IMAP mailbox
    expect((await t.get(`/api/identities/${mid}/discord/signup-kit?token=tok-1`)).json().email).toBe('ms01@outlook.com');
  });

  it('sign-up helper: suggested name, password generated once and kept in the vault', async () => {
    const { get, post, id, suite, store } = await setup();
    const kit = (await get(`/api/identities/${id}/discord/signup-kit?token=tok-1`)).json();
    expect(kit).toEqual({ email: 'disc01@example.com', username: 'discplayer', hasPassword: false });
    const p1 = (await post(`/api/identities/${id}/discord/password`)).json().password;
    const p2 = (await post(`/api/identities/${id}/discord/password`)).json().password;
    expect(p1).toMatch(/^[A-Za-z0-9]{20}!7$/);
    expect(p2).toBe(p1); // generated once
    expect(await store.list(`vault://identity/${id}/`)).toContain(`vault://identity/${id}/discord-password`);
    const leak = JSON.stringify(suite.db.prepare('SELECT * FROM app_settings').all()) + JSON.stringify(suite.audit.list({ limit: 50 }));
    expect(leak).not.toContain(p1);
    expect(suite.audit.list({ identityId: id, limit: 10 }).map((e) => e.action)).toContain('Discord password copied');
    // overview for the Discord page
    const all = (await get('/api/discord?token=tok-1')).json();
    expect(all.find((r: any) => r.identityId === id)).toMatchObject({ label: 'Disc01', email: 'disc01@example.com', minecraft: 'DiscPlayer' });
  });
});
