/**
 * LOCAL INTEGRATION: real IMAP (imapflow ↔ hoodiecrow IMAP server), real SMTP
 * (nodemailer ↔ smtp-server) and real HTTP OAuth2 (PKCE code exchange, refresh,
 * Discord /users/@me) against local servers.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultHttpPost } from '../../src/core/oauth.js';
import { fetchDiscordUser } from '../../src/discord/discordService.js';
import { createTestSuite } from '../helpers.js';

const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const msg = (from: string, to: string, subject: string, body: string, extra = '') =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@test>\r\nDate: Sun, 27 Sep 2026 18:00:00 +0000\r\n${extra}\r\n${body}\r\n`;

let imap: any;
let imapPort: number;
let smtp: SMTPServer;
let smtpPort: number;
const smtpReceived: Array<{ from: string; to: string[]; user: string; method: string; data: string }> = [];
let oauthServer: http.Server;
let oauthPort: number;
const oauthLog: Array<Record<string, string>> = [];
const challenges = new Map<string, string>(); // code -> code_challenge

beforeAll(async () => {
  imapPort = await freePort();
  imap = hoodiecrow({
    plugins: ['ID', 'IDLE', 'UNSELECT', 'ENABLE', 'SASL-IR', 'AUTH-PLAIN', 'XOAUTH2', 'SPECIAL-USE', 'LITERALPLUS'],
    users: {
      'real@example.com': { password: 'imap-pw', xoauth2: { accessToken: 'ms-access-2', sessionTimeout: 3600 } },
    },
    storage: {
      INBOX: {
        messages: [
          { raw: msg('noreply@discord.com', 'mc01@example.com', 'Verify your email', 'Hi!\r\nCode: AB12CD\r\nhttps://discord.com/verify?t=1') },
          { raw: msg('account-security-noreply@accountprotection.microsoft.com', 'mc02@example.com', 'Microsoft account security code', 'Security code: 482913') },
          { raw: msg('shop@example.org', 'real@example.com', 'Deals', 'unrelated'), flags: ['\\Seen'] },
          { raw: msg('forward@example.org', 'someone@list.example', 'Forwarded', 'via delivered-to', 'Delivered-To: mc02@example.com\r\n') },
        ],
      },
    },
  });
  await new Promise<void>((r) => imap.listen(imapPort, '127.0.0.1', () => r()));

  smtpPort = await freePort();
  smtp = new SMTPServer({
    authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
    allowInsecureAuth: true,
    hideSTARTTLS: true,
    onAuth(auth, _session, cb) {
      if (auth.method === 'XOAUTH2' ? auth.accessToken === 'ms-access-2' : auth.password === 'imap-pw') return cb(null, { user: `${auth.username}|${auth.method}` });
      cb(new Error('Invalid credentials'));
    },
    onData(stream, session, cb) {
      let data = '';
      stream.on('data', (c) => (data += c));
      stream.on('end', () => {
        const [user, method] = String(session.user).split('|');
        smtpReceived.push({ from: session.envelope.mailFrom ? (session.envelope.mailFrom as any).address : '', to: session.envelope.rcptTo.map((r) => r.address), user, method, data });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(smtpPort, '127.0.0.1', () => r()));

  // OAuth token endpoint + Discord API mock with real PKCE verification
  oauthPort = await freePort();
  oauthServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/users/@me') {
        const token = String(req.headers.authorization ?? '').replace('Bearer ', '');
        if (token !== 'discord-access-1' && token !== 'discord-access-2') return res.writeHead(401).end('{}');
        return res.end(JSON.stringify({ id: '123456789012345678', username: 'hoelni_tester', global_name: 'Hoelni Tester', avatar: null }));
      }
      if (url.pathname === '/register-code') {
        challenges.set(url.searchParams.get('code')!, url.searchParams.get('challenge')!);
        return res.end('ok');
      }
      const form = Object.fromEntries(new URLSearchParams(body));
      oauthLog.push({ path: url.pathname, ...form });
      res.setHeader('Content-Type', 'application/json');
      if (form.grant_type === 'authorization_code') {
        const expected = challenges.get(form.code);
        const actual = crypto.createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
        if (!expected || expected !== actual) return res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
        const prefix = url.pathname.includes('discord') ? 'discord' : 'ms';
        return res.end(JSON.stringify({ access_token: `${prefix}-access-1`, refresh_token: `${prefix}-refresh-1`, expires_in: 1 }));
      }
      if (form.grant_type === 'refresh_token') {
        const prefix = url.pathname.includes('discord') ? 'discord' : 'ms';
        if (form.refresh_token !== `${prefix}-refresh-1`) return res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
        return res.end(JSON.stringify({ access_token: `${prefix}-access-2`, refresh_token: `${prefix}-refresh-1`, expires_in: 3600 }));
      }
      res.writeHead(400).end(JSON.stringify({ error: 'unsupported_grant_type' }));
    });
  });
  await new Promise<void>((r) => oauthServer.listen(oauthPort, '127.0.0.1', () => r()));
  process.env.HOELNI_DISCORD_API_BASE = `http://127.0.0.1:${oauthPort}`;
});

afterAll(async () => {
  delete process.env.HOELNI_DISCORD_API_BASE;
  await new Promise((r) => imap?.close(r));
  await new Promise((r) => smtp?.close(() => r(null)));
  oauthServer?.close();
});

/** Suite that uses the REAL IMAP source, OAuth HTTP client and Discord fetcher. */
async function realSuite() {
  const t = await createTestSuite({ mailSourceFactory: undefined, oauthPost: defaultHttpPost, discordUserFetcher: fetchDiscordUser });
  return t;
}

async function simulateAuthorize(authUrl: string, code: string): Promise<string> {
  const u = new URL(authUrl);
  await fetch(`http://127.0.0.1:${oauthPort}/register-code?code=${code}&challenge=${u.searchParams.get('code_challenge')}`);
  return u.searchParams.get('state')!;
}

describe('IMAP mailbox (password)', () => {
  it('syncs, isolates aliases, extracts codes and writes flags back to the server', async () => {
    const { suite } = await realSuite();
    const box = suite.repo.createMailAccount({
      label: 'local imap', kind: 'imap', imapHost: '127.0.0.1', imapPort: imapPort, imapSecure: false, username: 'real@example.com',
      smtpHost: '127.0.0.1', smtpPort: smtpPort, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: null,
    });
    await suite.mail.setMailboxPassword(box.id, 'imap-pw');
    const a = suite.identities.create({}).identity.id;
    const b = suite.identities.create({}).identity.id;
    suite.repo.assignMail(a, { mailAccountId: box.id, address: 'mc01@example.com', isAlias: true });
    suite.repo.assignMail(b, { mailAccountId: box.id, address: 'mc02@example.com', isAlias: true });
    const checked = await suite.mail.checkIdentity(a);
    expect(checked.accessStatus).toBe('OK');
    expect(suite.mail.listForIdentity(a).map((m) => m.subject)).toEqual(['Verify your email']);
    // Delivered-To header routes the forwarded mail to identity B
    expect(suite.mail.listForIdentity(b).map((m) => m.subject).sort()).toEqual(['Forwarded', 'Microsoft account security code']);
    expect(suite.mail.unassigned(box.id).map((m) => m.subject)).toEqual(['Deals']);

    const verify = suite.mail.listForIdentity(a)[0];
    expect(verify.provider).toBe('Discord');
    const detail = await suite.mail.getMessage(a, verify.id);
    expect(detail.codes).toContain('AB12CD');
    expect(detail.links.map((l) => l.url)).toContain('https://discord.com/verify?t=1');
    // marking as read happened on the IMAP server: a fresh sync still sees it as seen
    await suite.mail.syncMailbox(box.id);
    expect(suite.mail.listForIdentity(a)[0].seen).toBe(true);
    await suite.mail.setSeen(a, verify.id, false);
    await suite.mail.syncMailbox(box.id);
    expect(suite.mail.listForIdentity(a)[0].seen).toBe(false);
  });

  it('reports wrong credentials as access error', async () => {
    const { suite } = await realSuite();
    const box = suite.repo.createMailAccount({
      label: 'bad', kind: 'imap', imapHost: '127.0.0.1', imapPort: imapPort, imapSecure: false, username: 'real@example.com',
      smtpHost: null, smtpPort: null, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: null,
    });
    await suite.mail.setMailboxPassword(box.id, 'wrong-password');
    const id = suite.identities.create({}).identity.id;
    suite.repo.assignMail(id, { mailAccountId: box.id, address: 'real@example.com' });
    const res = await suite.mail.checkIdentity(id);
    expect(res.accessStatus).toBe('ERROR');
    expect(res.lastError).toBeTruthy();
    expect(res.lastError).not.toContain('wrong-password');
  });

  it('sends mail over SMTP with the mailbox credentials and the identity address', async () => {
    const { suite } = await realSuite();
    const box = suite.repo.createMailAccount({
      label: 'smtp', kind: 'imap', imapHost: '127.0.0.1', imapPort: imapPort, imapSecure: false, username: 'real@example.com',
      smtpHost: '127.0.0.1', smtpPort: smtpPort, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: null,
    });
    await suite.mail.setMailboxPassword(box.id, 'imap-pw');
    const id = suite.identities.create({}).identity.id;
    suite.repo.assignMail(id, { mailAccountId: box.id, address: 'mc07@example.com', isAlias: true });
    await suite.mail.sendMail(id, { to: 'admin@hoelni.example', subject: 'Test', text: 'hello from identity 7' });
    const got = smtpReceived.at(-1)!;
    expect(got).toMatchObject({ from: 'mc07@example.com', to: ['admin@hoelni.example'], user: 'real@example.com', method: 'PLAIN' });
    expect(got.data).toContain('hello from identity 7');
  });
});

describe('OAuth2 (local identity provider, real HTTP + PKCE)', () => {
  it('connects a Microsoft mailbox and uses XOAUTH2 for IMAP and SMTP with refreshed tokens', async () => {
    const { suite } = await realSuite();
    suite.repo.setSetting('oauth.microsoft.tokenUrl', `http://127.0.0.1:${oauthPort}/ms/token`);
    const box = suite.repo.createMailAccount({
      label: 'outlook', kind: 'microsoft', imapHost: '127.0.0.1', imapPort: imapPort, imapSecure: false, username: 'real@example.com',
      smtpHost: '127.0.0.1', smtpPort: smtpPort, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: null,
    });
    const { url } = await suite.oauth.begin('microsoft', { type: 'mailbox', mailboxId: box.id }, { loginHint: 'real@example.com' });
    expect(new URL(url).searchParams.get('login_hint')).toBe('real@example.com');
    const state = await simulateAuthorize(url, 'ms-code-1');
    const done = await suite.oauth.complete(state, 'ms-code-1');
    await suite.mail.storeMailboxOAuth(box.id, done.provider, done.tokens);
    const secret = await suite.vault.store.get(`vault://mailbox/${box.id}`);
    expect(JSON.parse(secret!)).toMatchObject({ type: 'oauth', provider: 'microsoft', refreshToken: 'ms-refresh-1' });
    // expires_in=1 → the next IMAP connection refreshes the token first
    await new Promise((r) => setTimeout(r, 1100));
    const id = suite.identities.create({}).identity.id;
    suite.repo.assignMail(id, { mailAccountId: box.id, address: 'mc01@example.com', isAlias: true });
    expect((await suite.mail.checkIdentity(id)).accessStatus).toBe('OK');
    expect(oauthLog.some((l) => l.grant_type === 'refresh_token' && l.refresh_token === 'ms-refresh-1')).toBe(true);
    await suite.mail.sendMail(id, { to: 'x@example.com', subject: 'oauth smtp', text: 'via xoauth2' });
    expect(smtpReceived.at(-1)!.method).toBe('XOAUTH2');
  });

  it('rejects a code exchange with a wrong PKCE verifier', async () => {
    const { suite } = await realSuite();
    suite.repo.setSetting('oauth.discord.tokenUrl', `http://127.0.0.1:${oauthPort}/discord/token`);
    const id = suite.identities.create({}).identity.id;
    const { url } = await suite.discord.beginConnect(id);
    const u = new URL(url);
    await fetch(`http://127.0.0.1:${oauthPort}/register-code?code=discord-code-x&challenge=not-the-real-challenge`);
    await expect(suite.oauth.complete(u.searchParams.get('state')!, 'discord-code-x')).rejects.toThrow(/invalid_grant/);
  });

  it('connects a Discord account end-to-end over HTTP and verifies it via refresh', async () => {
    const { suite } = await realSuite();
    suite.repo.setSetting('oauth.discord.tokenUrl', `http://127.0.0.1:${oauthPort}/discord/token`);
    const id = suite.identities.create({}).identity.id;
    const { url } = await suite.discord.beginConnect(id);
    expect(new URL(url).searchParams.get('scope')).toBe('identify');
    const state = await simulateAuthorize(url, 'discord-code-1');
    const done = await suite.oauth.complete(state, 'discord-code-1');
    const d = await suite.discord.completeConnect(id, done.tokens);
    expect(d).toMatchObject({ discordUserId: '123456789012345678', username: 'hoelni_tester', oauthState: 'CONNECTED' });
    const again = await suite.discord.verify(id); // refresh_token grant + /users/@me with the new token
    expect(again.oauthState).toBe('CONNECTED');
    expect(oauthLog.some((l) => l.path.includes('discord') && l.grant_type === 'refresh_token')).toBe(true);
    // a revoked grant is detected
    oauthLog.length = 0;
    const secretRef = suite.repo.getDiscord(id)!.credentialRef!;
    await suite.vault.forIdentity(id).setJson(secretRef, { refreshToken: 'revoked' });
    expect((await suite.discord.verify(id)).oauthState).toBe('EXPIRED');
  });
});
