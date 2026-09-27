import type { AuditLog } from '../core/audit.js';
import { ValidationError } from '../core/errors.js';
import type { DiscordService } from '../discord/discordService.js';
import { DISCORD_APP_URL } from '../discord/discordService.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { MailService } from '../mail/mailService.js';
import type { SessionManager } from '../minecraft/sessionManager.js';
import type { NetworkService } from '../network/networkService.js';

export const BULK_ACTIONS = [
  'checkMail',
  'verifyNetwork',
  'startSessions',
  'stopSessions',
  'reconnect',
  'verifyDiscord',
  'openDiscord',
  'openMail',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export interface BulkResult {
  identityId: number;
  ok: boolean;
  message: string;
  /** For "open" actions: the URL the UI should open in the browser. */
  url?: string;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Global operations on a selection of identities. Each identity is processed independently. */
export class BulkOperations {
  concurrency = 4;

  constructor(
    private readonly repo: IdentityRepository,
    private readonly mail: MailService,
    private readonly network: NetworkService,
    private readonly sessions: SessionManager,
    private readonly discord: DiscordService,
    private readonly audit: AuditLog,
  ) {}

  async run(action: BulkAction, identityIds: number[]): Promise<BulkResult[]> {
    if (!BULK_ACTIONS.includes(action)) throw new ValidationError(`Unknown bulk action ${action}`);
    const ids = [...new Set(identityIds.map(Number))].filter((n) => Number.isInteger(n));
    if (!ids.length) throw new ValidationError('No identities selected');
    if (['startSessions', 'stopSessions', 'reconnect'].includes(action)) {
      this.audit.record(null, `Bulk: ${action}`, { count: ids.length });
    }
    // Mailboxes shared via aliases only need one sync per mailbox.
    const syncedMailboxes = new Map<number, Promise<unknown>>();
    return pool(ids, this.concurrency, async (identityId): Promise<BulkResult> => {
      try {
        this.repo.getIdentity(identityId);
        switch (action) {
          case 'checkMail': {
            const { account } = this.mail.mailboxForIdentity(identityId);
            if (!syncedMailboxes.has(account.id)) syncedMailboxes.set(account.id, this.mail.checkIdentity(identityId));
            await syncedMailboxes.get(account.id);
            const m = this.repo.getMailIdentity(identityId)!;
            return { identityId, ok: m.accessStatus === 'OK', message: m.accessStatus === 'OK' ? `${m.unreadCount} unread` : m.lastError ?? 'error' };
          }
          case 'verifyNetwork': {
            const p = await this.network.verify(identityId);
            if (!p) return { identityId, ok: false, message: 'No network profile' };
            return { identityId, ok: p.checkStatus === 'OK', message: p.checkStatus === 'OK' ? `Exit ${p.actualPublicIp}` : p.lastError ?? p.checkStatus };
          }
          case 'startSessions': {
            const s = await this.sessions.startAll(identityId);
            return { identityId, ok: true, message: `${s.length} session(s) starting` };
          }
          case 'stopSessions':
            this.sessions.stopAll(identityId);
            return { identityId, ok: true, message: 'Stopped' };
          case 'reconnect': {
            const list = this.sessions.list(identityId);
            for (const s of list) await this.sessions.reconnect(s.id);
            return { identityId, ok: true, message: `${list.length} session(s) reconnecting` };
          }
          case 'verifyDiscord': {
            const d = await this.discord.verify(identityId);
            return { identityId, ok: d.oauthState === 'CONNECTED', message: d.oauthState };
          }
          case 'openDiscord':
            return { identityId, ok: true, message: 'Open Discord', url: DISCORD_APP_URL };
          case 'openMail': {
            const { account } = this.mail.mailboxForIdentity(identityId);
            const url = this.mail.webmailUrl(account);
            return url ? { identityId, ok: true, message: 'Open mailbox', url } : { identityId, ok: false, message: 'No webmail URL configured' };
          }
        }
      } catch (e) {
        return { identityId, ok: false, message: (e as Error).message };
      }
    });
  }
}
