/**
 * Demo mode – runs the complete suite against LOCAL test infrastructure:
 *
 *   REAL:       mineflayer sessions in supervised runtime hosts, desired-state
 *               reconciler, real game client (Open game), chat/link/reward rules,
 *               source-IP binding (127.0.0.x on Linux)
 *   LOCAL:      three flying-squid Minecraft servers (offline mode) with Hoelni-like messages
 *   SIMULATED:  mailbox contents, Discord OAuth, public-IP answers (no external services)
 *
 *   npm run demo   →  http://127.0.0.1:7421
 */
import { createSuite } from './app.js';
import { DEFAULT_CONFIG } from './config.js';
import { openDatabase } from './core/db.js';
import { createLogger } from './core/logger.js';
import type { MessageHeader, MessageSource } from './mail/provider.js';
import { startLocalServer, type LocalServer } from './testserver/localServer.js';
import { StaticKeyProvider } from './vault/keyProviders.js';
import { EncryptedFileVault } from './vault/vault.js';
import { buildServer } from './web/server.js';

const log = createLogger('demo');
const PORT = Number(process.env.HOELNI_PORT ?? 7421);
const IDENTITIES = Number(process.env.HOELNI_DEMO_IDENTITIES ?? 15);
const MC_BASE_PORT = Number(process.env.HOELNI_DEMO_MC_PORT ?? 25601);

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

async function main() {
  const servers: LocalServer[] = [];
  const names = ['SMP', 'Event', 'Test'];
  for (let i = 0; i < names.length; i++) {
    servers.push(await startLocalServer({ port: MC_BASE_PORT + i, version: '1.20.1', starIntervalSec: i === 0 ? 30 : 0, motd: `Hoelni ${names[i]} (local)` }));
  }
  log.info(`Local Minecraft servers: ${servers.map((s, i) => `${names[i]}=127.0.0.1:${s.port}`).join(', ')}`);

  const store = await EncryptedFileVault.open(null, new StaticKeyProvider());
  const suite = createSuite({
    config: {
      ...DEFAULT_CONFIG,
      port: PORT,
      automation: { ...DEFAULT_CONFIG.automation, mailCheckMinutes: 0, networkCheckMinutes: 0, discordVerifyHours: 0, tokenRefreshHours: 0, restoreSessions: true },
      runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process', sessionsPerHost: 10 },
    },
    db: openDatabase(':memory:'),
    store,
    // SIMULATED public IP answers (no internet access needed): profile 5 shows a mismatch.
    ipDetector: async (profile) => {
      await new Promise((r) => setTimeout(r, 200));
      if (!profile) throw new Error('no profile');
      if (profile.expectedPublicIp && profile.id === 5) return '198.51.100.250';
      return profile.expectedPublicIp ?? `203.0.113.${profile.id}`;
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
  const srv = names.map((name, i) => suite.repo.upsertServer({ name, host: '127.0.0.1', port: servers[i].port, version: '1.20.1' }));
  const tpl = suite.repo.saveTemplate({
    name: 'Default AFK Identity',
    config: { settings: { autoReconnect: true, mailEnabled: true, discordLinking: 'required' }, servers: ['SMP', 'Event', 'Test'], network: { mode: 'PER_ACCOUNT', kind: 'BIND' } },
  });
  suite.repo.saveTemplate({ name: 'Event only', config: { settings: { discordLinking: 'optional' }, servers: ['Event'], network: { mode: 'SHARED' } } });
  const provider = await suite.mail.createAliasProvider({ kind: 'plus', label: 'Plus addressing', config: { baseAddress: 'afk@hoelni.local' } });
  const shared = suite.repo.createMailAccount({
    label: 'AFK shared mailbox (simulated)', kind: 'imap', imapHost: 'imap.hoelni.local', imapPort: 993, imapSecure: true, username: 'afk@hoelni.local',
    smtpHost: null, smtpPort: null, webmailUrl: null, exclusiveIdentityId: null, aliasProviderId: provider.id,
  });
  await suite.mail.setMailboxPassword(shared.id, 'demo-password');

  const linux = process.platform === 'linux';
  for (let n = 1; n <= IDENTITIES; n++) {
    const nn = String(n).padStart(2, '0');
    const { identity } = suite.identities.create({ label: `Identity${nn}`, templateId: tpl.id, settings: { networkGuard: 'warn' } });
    const id = identity.id;
    const address = `afk+mc${nn}@hoelni.local`;
    suite.repo.assignMail(id, { mailAccountId: shared.id, address, isAlias: true });
    suite.repo.upsertMinecraft(id, { username: `Player${nn}`, authType: 'offline' });
    await suite.auth.authenticate(id);
    if (n % 5 !== 3 && n !== 9) {
      const { url } = await suite.discord.beginConnect(id);
      const r = await suite.oauth.complete(new URL(url).searchParams.get('state')!, `code-${n}`);
      await suite.discord.completeConnect(id, r.tokens);
    }
    suite.repo.createNetworkProfile(id, {
      kind: 'BIND',
      name: 'exit',
      localBindIp: linux ? `127.0.0.${10 + n}` : '127.0.0.1',
      expectedPublicIp: `203.0.113.${10 + n}`,
      exitLabel: `IP #${nn}`,
    });
    if (n <= 12) await suite.network.verify(id);
    // desired state: first 10 identities online on SMP, first 4 also on Event
    if (n <= 10) suite.repo.setDesiredState(id, srv[0].id, 'ONLINE');
    if (n <= 4) suite.repo.setDesiredState(id, srv[1].id, 'ONLINE');
    addMail('afk@hoelni.local', { from: 'Discord <noreply@discord.com>', to: address, subject: 'Verify your email address', text: `Hey Player${nn},\n\nplease verify your email: https://discord.com/verify?token=demo${n}\n\nCode: DV${nn}X7`, html: `<h2 style="color:#5865F2">Verify your email</h2><p>Hey Player${nn}, please <a href="https://discord.com/verify?token=demo${n}">verify your email</a>.</p><p>Code: <b>DV${nn}X7</b></p><img src="https://tracker.example/pixel.png">`, minutesAgo: 60 * n });
    if (n % 3 === 0) addMail('afk@hoelni.local', { from: 'Microsoft account team <account-security-noreply@accountprotection.microsoft.com>', to: address, subject: 'Microsoft account security code', text: `Security code: ${400000 + n * 1111}`, minutesAgo: n * 7 });
  }
  addMail('afk@hoelni.local', { from: 'newsletter@shop.example', to: 'afk@hoelni.local', subject: 'Weekly deals', text: 'Not addressed to any alias – shows up as unassigned.' });
  await suite.mail.syncMailbox(shared.id);

  const { app } = await buildServer(suite);
  await app.listen({ host: '127.0.0.1', port: PORT });
  suite.startAutomation();
  log.info(`Demo running on http://127.0.0.1:${PORT}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close().catch(() => undefined);
    await suite.shutdown().catch(() => undefined);
    for (const s of servers) await s.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  log.error('Demo failed:', e);
  process.exit(1);
});
