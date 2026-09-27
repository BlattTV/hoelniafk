/**
 * Demo mode: runs the full UI with simulated Minecraft sessions, mailboxes,
 * Discord OAuth and exit-IP checks – no real accounts, servers or network
 * access are touched. Data lives in memory only.
 *
 *   npm run demo   →  http://127.0.0.1:7421
 */
import { EventEmitter } from 'node:events';
import { createSuite } from './app.js';
import { DEFAULT_CONFIG } from './config.js';
import { openDatabase } from './core/db.js';
import { createLogger } from './core/logger.js';
import type { MessageHeader, MessageSource } from './mail/provider.js';
import type { BotLike, SessionLaunchSpec } from './minecraft/sessionManager.js';
import { StaticKeyProvider } from './vault/keyProviders.js';
import { EncryptedFileVault } from './vault/vault.js';
import { buildServer } from './web/server.js';

const log = createLogger('demo');
const PORT = Number(process.env.HOELNI_PORT ?? 7421);

interface DemoMail { uid: number; from: string; to: string; subject: string; text: string; html?: string; date: string; seen: boolean }
const mailboxes = new Map<string, DemoMail[]>();
let uidSeq = 1;
const addMail = (box: string, m: Omit<DemoMail, 'uid' | 'date' | 'seen'> & { minutesAgo?: number }) => {
  const list = mailboxes.get(box) ?? [];
  list.push({ ...m, uid: uidSeq++, seen: false, date: new Date(Date.now() - (m.minutesAgo ?? 0) * 60_000).toISOString() });
  mailboxes.set(box, list);
};

function raw(m: DemoMail): Buffer {
  const head = [`From: ${m.from}`, `To: ${m.to}`, `Subject: ${m.subject}`, `Date: ${new Date(m.date).toUTCString()}`, 'MIME-Version: 1.0'];
  if (!m.html) return Buffer.from([...head, 'Content-Type: text/plain; charset=utf-8', '', m.text].join('\r\n'));
  return Buffer.from([...head, 'Content-Type: multipart/alternative; boundary="x"', '', '--x', 'Content-Type: text/plain; charset=utf-8', '', m.text, '--x', 'Content-Type: text/html; charset=utf-8', '', m.html, '--x--', ''].join('\r\n'));
}

const demoSource = (username: string): MessageSource => ({
  async listMessages({ limit }): Promise<MessageHeader[]> {
    return (mailboxes.get(username) ?? []).slice(-limit).map((m) => ({
      uid: m.uid, messageId: `<${m.uid}@demo>`, from: { address: m.from.replace(/^.*</, '').replace(/>$/, ''), name: m.from.includes('<') ? m.from.split('<')[0].trim() : undefined },
      to: m.to.split(',').map((x) => x.trim().toLowerCase()), subject: m.subject, date: m.date, seen: m.seen, hasAttachments: false,
    }));
  },
  async getMessage(uid) {
    const m = (mailboxes.get(username) ?? []).find((x) => x.uid === uid);
    if (!m) throw new Error('not found');
    return { uid, source: raw(m) };
  },
  async setSeen(uid, seen) {
    const m = (mailboxes.get(username) ?? []).find((x) => x.uid === uid);
    if (m) m.seen = seen;
  },
  async test() {
    const l = mailboxes.get(username) ?? [];
    return { total: l.length, unseen: l.filter((m) => !m.seen).length };
  },
});

class DemoBot extends EventEmitter implements BotLike {
  private timers: NodeJS.Timeout[] = [];
  constructor(spec: SessionLaunchSpec) {
    super();
    const n = spec.identityId;
    this.timers.push(setTimeout(() => { this.emit('login'); this.emit('spawn'); this.emit('messagestr', `Welcome to ${spec.server.name}, ${spec.username}!`); }, 800 + Math.random() * 1500));
    this.timers.push(setTimeout(() => this.emit('messagestr', `You have ${n * 3} stars`), 2500));
    if (n % 5 === 3) this.timers.push(setTimeout(() => this.emit('messagestr', `Link your account using code ${['ABC123', 'QX7K2M', 'LNK842'][n % 3]}`), 3500));
    this.timers.push(setInterval(() => this.emit('messagestr', `[Server] ${['Remember to vote!', 'Event starts in 10 minutes', 'Backup complete'][Math.floor(Math.random() * 3)]}`), 20_000));
  }
  quit(): void {
    this.timers.forEach((t) => clearTimeout(t));
    setImmediate(() => this.emit('end', 'quit'));
  }
  chat(message: string): void {
    setTimeout(() => {
      this.emit('messagestr', `<you> ${message}`);
      if (/^\/discord link|^\/link/i.test(message)) this.emit('messagestr', 'Discord linked successfully');
    }, 300);
  }
  antiAfk(): void {}
}

async function main() {
  const store = await EncryptedFileVault.open(null, new StaticKeyProvider());
  const suite = createSuite({
    config: { ...DEFAULT_CONFIG, port: PORT, automation: { ...DEFAULT_CONFIG.automation, mailCheckMinutes: 0, networkCheckMinutes: 0, discordVerifyHours: 0 } },
    db: openDatabase(':memory:'),
    store,
    botFactory: (spec) => new DemoBot(spec),
    ipDetector: async (profile) => {
      await new Promise((r) => setTimeout(r, 300));
      if (!profile) throw new Error('no profile');
      if (profile.expectedPublicIp && profile.id % 7 === 5) return '198.51.100.250';
      return profile.expectedPublicIp ?? `203.0.113.${profile.id}`;
    },
    tokenFetcher: async ({ msaAccount, cacheFactory }) => {
      await cacheFactory({ username: msaAccount, cacheName: 'mca' }).setCached({ token: 'demo', obtainedOn: Date.now() });
      const n = msaAccount.replace(/\D/g, '').padStart(2, '0');
      return { id: `d3m0000000000000000000000000${n.padStart(4, '0')}`.replace(/[^0-9a-f]/g, '0'), name: `Player${n}` };
    },
    mailSourceFactory: (account) => demoSource(account.username),
    discordUserFetcher: async (token) => {
      const n = token.replace(/\D/g, '') || '1';
      return { id: `81000000000000${n}`, username: `hoelni_${n}`, global_name: `Hoelni ${n}`, avatar: null };
    },
    oauthPost: async (_url, form) => {
      const n = (form.code ?? form.refresh_token ?? '1').replace(/\D/g, '') || '1';
      return { status: 200, json: { access_token: `demo-access-${n}`, refresh_token: `demo-refresh-${n}`, expires_in: 3600 } };
    },
  });
  suite.repo.setSetting('oauth.discord.clientId', 'demo-client');

  // ---------------------------------------------------------------- seed
  const servers = ['SMP', 'Event', 'Test'].map((name, i) => suite.repo.upsertServer({ name, host: `${name.toLowerCase()}.hoelni.local`, port: 25565 + i }));
  const tpl = suite.repo.saveTemplate({
    name: 'Default AFK Identity',
    config: { settings: { autoReconnect: true, mailEnabled: true, discordLinking: 'required' }, servers: ['SMP', 'Event', 'Test'], network: { mode: 'PER_ACCOUNT', kind: 'BIND' } },
  });
  suite.repo.saveTemplate({ name: 'Event only', config: { settings: { discordLinking: 'optional' }, servers: ['Event'], network: { mode: 'SHARED' } } });
  const provider = await suite.mail.createAliasProvider({ kind: 'plus', label: 'Plus addressing', config: { baseAddress: 'afk@hoelni.local' } });
  const shared = suite.repo.createMailAccount({
    label: 'AFK shared mailbox', kind: 'imap', imapHost: 'imap.hoelni.local', imapPort: 993, imapSecure: true, username: 'afk@hoelni.local',
    smtpHost: null, smtpPort: null, webmailUrl: 'https://mail.hoelni.local', exclusiveIdentityId: null, aliasProviderId: provider.id,
  });
  await suite.mail.setMailboxPassword(shared.id, 'demo-password');

  for (let n = 1; n <= 15; n++) {
    const nn = String(n).padStart(2, '0');
    const { identity } = suite.identities.create({ label: `Identity${nn}`, templateId: tpl.id });
    const id = identity.id;
    const address = `afk+mc${nn}@hoelni.local`;
    suite.repo.assignMail(id, { mailAccountId: shared.id, address, isAlias: true });
    if (n !== 12) {
      suite.repo.upsertMinecraft(id, { username: `Player${nn}`, authType: 'microsoft', msaAccount: `mc${nn}@outlook.example` });
      await suite.auth.authenticate(id);
    }
    if (n % 5 !== 3 && n !== 9) {
      const { url } = await suite.discord.beginConnect(id);
      const r = await suite.oauth.complete(new URL(url).searchParams.get('state')!, `code-${n}`);
      await suite.discord.completeConnect(id, r.tokens);
      if (n !== 4) suite.linking.setManual(id, 'LINKED');
    }
    suite.repo.createNetworkProfile(id, { kind: 'BIND', name: 'exit', localBindIp: `10.10.0.${n}`, expectedPublicIp: `203.0.113.${10 + n}`, exitLabel: `IP #${nn}` });
    if (n <= 12) await suite.network.verify(id);
    addMail('afk@hoelni.local', { from: 'Discord <noreply@discord.com>', to: address, subject: 'Verify your email address', text: `Hey Player${nn},\n\nplease verify your email: https://discord.com/verify?token=demo${n}\n\nCode: DV${nn}X7`, html: `<h2 style="color:#5865F2">Verify your email</h2><p>Hey Player${nn}, please <a href="https://discord.com/verify?token=demo${n}">verify your email</a>.</p><p>Code: <b>DV${nn}X7</b></p><img src="https://tracker.example/pixel.png">`, minutesAgo: 60 * n });
    if (n % 3 === 0) addMail('afk@hoelni.local', { from: 'Microsoft account team <account-security-noreply@accountprotection.microsoft.com>', to: address, subject: 'Microsoft account security code', text: `Please use the following security code for the Microsoft account mc${nn}@outlook.example.\n\nSecurity code: ${400000 + n * 1111}`, minutesAgo: n * 7 });
    if (n % 4 === 0) addMail('afk@hoelni.local', { from: 'Hoelni <system@hoelni.de>', to: address, subject: 'Account linked', text: 'Your Minecraft account was linked. Code: HL' + nn, minutesAgo: n * 3 });
  }
  addMail('afk@hoelni.local', { from: 'newsletter@shop.example', to: 'afk@hoelni.local', subject: 'Weekly deals', text: 'Not addressed to any alias – shows up as unassigned.' });
  await suite.mail.syncMailbox(shared.id);
  for (const i of suite.repo.listIdentities().slice(0, 10)) await suite.sessions.startAll(i.id);

  const { app } = await buildServer(suite);
  await app.listen({ host: '127.0.0.1', port: PORT });
  log.info(`Demo running on http://127.0.0.1:${PORT} – simulated data only`);
}

main().catch((e) => {
  log.error('Demo failed:', e);
  process.exit(1);
});
