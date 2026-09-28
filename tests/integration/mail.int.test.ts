/**
 * LOCAL INTEGRATION: real IMAP (imapflow ↔ hoodiecrow IMAP server), real SMTP
 * (nodemailer ↔ smtp-server) against local servers.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import { createRequire } from 'node:module';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(async () => {
  imapPort = await freePort();
  imap = hoodiecrow({
    plugins: ['ID', 'IDLE', 'UNSELECT', 'ENABLE', 'SASL-IR', 'AUTH-PLAIN', 'SPECIAL-USE', 'LITERALPLUS'],
    users: {
      'real@example.com': { password: 'imap-pw' },
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
    authMethods: ['PLAIN', 'LOGIN'],
    allowInsecureAuth: true,
    hideSTARTTLS: true,
    onAuth(auth, _session, cb) {
      if (auth.password === 'imap-pw') return cb(null, { user: `${auth.username}|${auth.method}` });
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

});

afterAll(async () => {
  await new Promise((r) => imap?.close(r));
  await new Promise((r) => smtp?.close(() => r(null)));
});

/** Suite that uses the REAL IMAP source. */
async function realSuite() {
  return createTestSuite({ mailSourceFactory: undefined });
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
