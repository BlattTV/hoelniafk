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
  'openDiscord',
  'openMail',
  'refreshMinecraftAuth',
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
    private readonly auth?: { authenticate(identityId: number): Promise<{ authStatus: string; lastError: string | null }> },
  ) {}

  /** `serverIds` limits session actions to these servers (default: all assignments). */
  async run(action: BulkAction, identityIds: number[], opts: { serverIds?: number[] } = {}): Promise<BulkResult[]> {
    if (!BULK_ACTIONS.includes(action)) throw new ValidationError(`Unknown bulk action ${action}`);
    const ids = [...new Set(identityIds.map(Number))].filter((n) => Number.isInteger(n));
    if (!ids.length) throw new ValidationError('No identities selected');
    if (['startSessions', 'stopSessions', 'reconnect'].includes(action)) {
      this.audit.record(null, `Bulk: ${action}`, { count: ids.length });
    }
    if (action === 'startSessions') {
      // "All online": the accounts join spread over minutes, not all at once
      const out: BulkResult[] = [];
      const targets: Array<{ identityId: number; serverId: number }> = [];
      for (const identityId of ids) {
        try {
          this.repo.getIdentity(identityId);
          const list = this.repo.listAssignments(identityId).filter((a) => a.enabled && (!opts.serverIds || opts.serverIds.includes(a.serverId)));
          targets.push(...list.map((a) => ({ identityId, serverId: a.serverId })));
          out.push({ identityId, ok: list.length > 0, message: list.length ? `${list.length} session(s) set online` : 'No enabled assignments' });
        } catch (e) {
          out.push({ identityId, ok: false, message: (e as Error).message });
        }
      }
      this.sessions.setOnlineSpread(targets);
      return out;
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
          case 'stopSessions': {
            // desired OFFLINE – the reconciler lets online accounts leave one after another (start spacing)
            const targets = this.repo.listAssignments(identityId).filter((a) => !opts.serverIds || opts.serverIds.includes(a.serverId));
            for (const a of targets) this.sessions.setDesired(identityId, a.serverId, 'OFFLINE');
            return { identityId, ok: true, message: `${targets.length} session(s) set offline` };
          }
          case 'reconnect': {
            const list = this.sessions.list(identityId).filter((s) => !opts.serverIds || opts.serverIds.includes(s.serverId));
            for (const s of list) await this.sessions.reconnect(s.id);
            return { identityId, ok: true, message: `${list.length} session(s) reconnecting` };
          }
          case 'refreshMinecraftAuth': {
            if (!this.auth) return { identityId, ok: false, message: 'Not available' };
            const mc = await this.auth.authenticate(identityId);
            return { identityId, ok: mc.authStatus === 'AUTHENTICATED', message: mc.authStatus === 'AUTHENTICATED' ? 'Token valid' : mc.lastError ?? mc.authStatus };
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
