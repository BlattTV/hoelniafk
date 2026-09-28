import { ImapFlow } from 'imapflow';
import type { MessageHeader, MessageSource, RawMessage } from './provider.js';

export interface ImapAuth {
  user: string;
  pass: string;
}

export interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  auth: () => Promise<ImapAuth>;
}

function hasAttachment(node: any): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return Array.isArray(node.childNodes) && node.childNodes.some(hasAttachment);
}

function parseExtraRecipients(headers: Buffer | undefined): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const line of headers.toString('utf8').split(/\r?\n/)) {
    const m = /^(delivered-to|x-original-to|x-forwarded-to|envelope-to):\s*(.+)$/i.exec(line);
    if (m) {
      for (const a of m[2].matchAll(/[^\s<>,;"]+@[^\s<>,;"]+/g)) out.push(a[0].toLowerCase());
    }
  }
  return out;
}

/**
 * IMAP message source (imapflow). A fresh connection is opened per operation
 * and closed afterwards; imapflow's logger is disabled so no protocol traffic
 * (which could contain credentials) is ever logged.
 */
export class ImapMessageSource implements MessageSource {
  constructor(private readonly settings: ImapSettings) {}

  private async withClient<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const auth = await this.settings.auth();
    const client = new ImapFlow({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      auth: { user: auth.user, pass: auth.pass },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    } as any);
    // Late socket errors (e.g. timeouts after a failed login) must never become unhandled.
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (e) {
      client.close();
      throw e;
    }
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async test(): Promise<{ total: number; unseen: number }> {
    return this.withClient(async (c) => {
      const st = await c.status('INBOX', { messages: true, unseen: true });
      return { total: (st && st.messages) || 0, unseen: (st && st.unseen) || 0 };
    });
  }

  async listMessages({ limit }: { limit: number }): Promise<MessageHeader[]> {
    return this.withClient(async (c) => {
      const exists = (c.mailbox && typeof c.mailbox === 'object' ? c.mailbox.exists : 0) || 0;
      if (!exists) return [];
      const start = Math.max(1, exists - limit + 1);
      const out: MessageHeader[] = [];
      for await (const m of c.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        headers: ['delivered-to', 'x-original-to', 'x-forwarded-to', 'envelope-to'],
      })) {
        const env: any = m.envelope ?? {};
        const to = [...(env.to ?? []), ...(env.cc ?? [])].map((a: any) => String(a.address ?? '').toLowerCase()).filter(Boolean);
        to.push(...parseExtraRecipients(m.headers as Buffer | undefined));
        out.push({
          uid: m.uid,
          messageId: env.messageId ?? null,
          from: env.from?.[0] ? { address: String(env.from[0].address ?? '').toLowerCase(), name: env.from[0].name ?? undefined } : null,
          to: [...new Set(to)],
          subject: env.subject ?? '',
          date: env.date ? new Date(env.date).toISOString() : null,
          seen: m.flags?.has('\\Seen') ?? false,
          hasAttachments: hasAttachment(m.bodyStructure),
        });
      }
      return out;
    });
  }

  async getMessage(uid: number): Promise<RawMessage> {
    return this.withClient(async (c) => {
      const m = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!m || !m.source) throw new Error(`Message ${uid} not found`);
      return { uid, source: m.source };
    });
  }

  async setSeen(uid: number, seen: boolean): Promise<void> {
    await this.withClient(async (c) => {
      if (seen) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      else await c.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    });
  }
}
