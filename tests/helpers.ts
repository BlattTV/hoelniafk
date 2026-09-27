import { EventEmitter } from 'node:events';
import { createSuite, type SuiteDeps } from '../src/app.js';
import { openDatabase } from '../src/core/db.js';
import { parseRules } from '../src/core/rules.js';
import type { MailAccount, NetworkProfile } from '../src/core/types.js';
import type { MessageHeader, MessageSource, RawMessage } from '../src/mail/provider.js';
import type { BotLike, SessionLaunchSpec } from '../src/minecraft/sessionManager.js';
import { StaticKeyProvider } from '../src/vault/keyProviders.js';
import { EncryptedFileVault } from '../src/vault/vault.js';
import fs from 'node:fs';
import path from 'node:path';

export const TEST_RULES = parseRules(fs.readFileSync(path.resolve('config/rules.yaml'), 'utf8'));

// ------------------------------------------------------------------ fake mail server

export interface FakeMail {
  uid: number;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  seen?: boolean;
  date?: string;
}

export function rfc822(m: FakeMail): Buffer {
  const date = new Date(m.date ?? '2026-09-27T18:42:00Z').toUTCString();
  if (m.html) {
    return Buffer.from(
      [
        `From: ${m.from}`,
        `To: ${m.to}`,
        `Subject: ${m.subject}`,
        `Date: ${date}`,
        `Message-ID: <${m.uid}@test>`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        m.text,
        '--b1',
        'Content-Type: text/html; charset=utf-8',
        '',
        m.html,
        '--b1--',
        '',
      ].join('\r\n'),
    );
  }
  return Buffer.from(
    [`From: ${m.from}`, `To: ${m.to}`, `Subject: ${m.subject}`, `Date: ${date}`, `Message-ID: <${m.uid}@test>`, 'Content-Type: text/plain; charset=utf-8', '', m.text, ''].join('\r\n'),
  );
}

export class FakeMailServer {
  /** mailbox username -> messages */
  readonly boxes = new Map<string, FakeMail[]>();
  /** credentials each connection used (to verify the right secret was used) */
  readonly authLog: Array<{ mailbox: string; user: string; pass?: string; accessToken?: string }> = [];
  listCalls = 0;

  add(mailbox: string, m: FakeMail): void {
    const list = this.boxes.get(mailbox) ?? [];
    list.push(m);
    this.boxes.set(mailbox, list);
  }

  factory = (account: MailAccount, auth: () => Promise<{ user: string; pass?: string; accessToken?: string }>): MessageSource => {
    const box = () => this.boxes.get(account.username) ?? [];
    const logAuth = async () => {
      const a = await auth();
      this.authLog.push({ mailbox: account.username, ...a });
    };
    return {
      listMessages: async ({ limit }): Promise<MessageHeader[]> => {
        await logAuth();
        this.listCalls++;
        return box()
          .slice(-limit)
          .map((m) => ({
            uid: m.uid,
            messageId: `<${m.uid}@test>`,
            from: { address: m.from.replace(/^.*</, '').replace(/>.*$/, '').toLowerCase() },
            to: m.to.split(',').map((x) => x.trim().toLowerCase()),
            subject: m.subject,
            date: new Date(m.date ?? '2026-09-27T18:42:00Z').toISOString(),
            seen: !!m.seen,
            hasAttachments: false,
          }));
      },
      getMessage: async (uid): Promise<RawMessage> => {
        await logAuth();
        const m = box().find((x) => x.uid === uid);
        if (!m) throw new Error('not found');
        return { uid, source: rfc822(m) };
      },
      setSeen: async (uid, seen) => {
        const m = box().find((x) => x.uid === uid);
        if (m) m.seen = seen;
      },
      test: async () => {
        await logAuth();
        return { total: box().length, unseen: box().filter((m) => !m.seen).length };
      },
    };
  };
}

// ------------------------------------------------------------------ fake bots

export class FakeBot extends EventEmitter implements BotLike {
  readonly sent: string[] = [];
  quitCalled = false;
  constructor(readonly spec: SessionLaunchSpec) {
    super();
  }
  quit(): void {
    this.quitCalled = true;
    setImmediate(() => this.emit('end', 'quit'));
  }
  chat(message: string): void {
    this.sent.push(message);
  }
  /** Simulates a successful join. */
  join(): void {
    this.emit('login');
    this.emit('spawn');
  }
  say(text: string): void {
    this.emit('messagestr', text);
  }
}

export async function createTestSuite(overrides: Partial<SuiteDeps> = {}) {
  const store = await EncryptedFileVault.open(null, new StaticKeyProvider());
  const bots: FakeBot[] = [];
  const mailServer = new FakeMailServer();
  const ipCalls: Array<{ profile: NetworkProfile | null; password: string | null }> = [];
  const ipByProfile = new Map<number, string>();
  const oauthPosts: Array<{ url: string; form: Record<string, string> }> = [];
  const suite = createSuite({
    config: { port: 7420 },
    db: openDatabase(':memory:'),
    store,
    rules: TEST_RULES,
    botFactory: (spec) => {
      const b = new FakeBot(spec);
      bots.push(b);
      return b;
    },
    ipDetector: async (profile, secret) => {
      ipCalls.push({ profile, password: secret?.password ?? null });
      if (!profile) throw new Error('no profile');
      return ipByProfile.get(profile.id) ?? profile.expectedPublicIp ?? '203.0.113.1';
    },
    tokenFetcher: async ({ msaAccount, cacheFactory }) => {
      // Simulates prismarine-auth writing a token cache for this account.
      const cache = cacheFactory({ username: msaAccount, cacheName: 'mca' });
      await cache.setCached({ token: `mc-token-for-${msaAccount}`, obtainedOn: Date.now() });
      const n = msaAccount.replace(/\D/g, '').padStart(2, '0');
      return { id: `0000000000000000000000000000${n.padStart(4, '0')}`, name: `Player${n}` };
    },
    mailSourceFactory: mailServer.factory,
    discordUserFetcher: async (accessToken) => {
      const n = accessToken.replace(/\D/g, '');
      return { id: `90000000000000${n}`, username: `discorduser${n}`, global_name: `Discord User ${n}`, avatar: null };
    },
    oauthPost: async (url, form) => {
      oauthPosts.push({ url, form });
      const seed = form.code ?? form.refresh_token ?? '0';
      const n = seed.replace(/\D/g, '') || '0';
      return { status: 200, json: { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 } };
    },
    ...overrides,
  });
  suite.repo.setSetting('oauth.discord.clientId', 'test-discord-client');
  suite.repo.setSetting('oauth.microsoft.clientId', 'test-ms-client');
  return { suite, store, bots, mailServer, ipCalls, ipByProfile, oauthPosts };
}

export const tick = () => new Promise((r) => setImmediate(r));
