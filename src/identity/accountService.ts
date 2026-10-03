/**
 * Account library: Microsoft and Discord logins on their own, linked to identities by hand.
 *
 *   - Every account has its own browser profile (desktop program: Electron partition). Its login
 *     (Outlook, Discord) stays in that profile, whichever identity the account belongs to.
 *   - An account is linked to at most one identity, an identity to at most one account per kind.
 *     Linking to another identity moves the account – never two identities on one login.
 *   - Microsoft: the Minecraft token cache moves with the account (vault, encrypted): while the
 *     account is linked it lives in the identity's vault scope (sessions use it), otherwise in the
 *     account's own entry. The Discord sign-up password moves the same way.
 *
 * The identity tables keep the linked account's data (minecraft_identities.msa_account,
 * discord_identities.oauth_state/username) – everything else in the suite works unchanged.
 */
import crypto from 'node:crypto';
import type { AuditLog } from '../core/audit.js';
import { ConflictError, ValidationError } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type { Account, AccountKind } from '../core/types.js';
import type { MinecraftAuthService } from '../minecraft/authService.js';
import { refs } from '../vault/refs.js';
import type { Vault } from '../vault/vault.js';
import type { IdentityRepository } from './repository.js';

const log = createLogger('accounts');

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DISCORD_NAME = /^[a-z0-9_.]{2,32}$/i;

/** Secrets that belong to the login, not to the identity: identity vault path → account storage path. */
const MOVING_SECRETS: Record<AccountKind, string[]> = { microsoft: ['minecraft'], discord: ['discord-password'] };

export class AccountService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly auth: MinecraftAuthService,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {}

  /**
   * Accounts that came to this PC through the settings sync: their window (browser profile) is new
   * here, so they still need one sign-in on this PC. Kept per PC (app setting), never synchronized.
   */
  loginPending(id: number): boolean {
    return this.repo.getSetting(`login.pending.${id}`) === '1';
  }

  /** Moved to a new PC: every account in use goes on the "sign in on this PC" list. Returns how many. */
  markAllLoginPending(): number {
    let n = 0;
    for (const a of this.repo.listAccounts()) {
      if (!a.ready && a.identityId === null) continue;
      this.repo.setSetting(`login.pending.${a.id}`, '1');
      n++;
    }
    return n;
  }

  /** The user signed in to this account's window on this PC (or does not need it here). */
  loginDone(id: number): void {
    this.repo.setSetting(`login.pending.${id}`, '');
  }

  list(kind?: AccountKind): Array<Account & { identityLabel: string | null; minecraftStatus: string | null; loginPending: boolean }> {
    return this.repo.listAccounts(kind).map((a) => {
      let identityLabel: string | null = null;
      let minecraftStatus: string | null = null;
      if (a.identityId !== null) {
        try {
          identityLabel = this.repo.getIdentity(a.identityId).label;
        } catch {
          /* identity gone */
        }
        if (a.kind === 'microsoft') minecraftStatus = this.repo.getMinecraft(a.identityId)?.authStatus ?? null;
      }
      return { ...a, identityLabel, minecraftStatus, loginPending: this.loginPending(a.id) };
    });
  }

  get(id: number): Account {
    return this.repo.getAccount(id);
  }

  private newPartition(kind: AccountKind): string {
    return `persist:hoelni-${kind === 'microsoft' ? 'ms' : 'discord'}-acc-${crypto.randomBytes(6).toString('hex')}`;
  }

  private normEmail(input: unknown): string {
    const email = String(input ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) throw new ValidationError('Enter the e-mail address of the Microsoft account');
    return email;
  }

  /** Adds an account to the library (not linked yet). Sign-in happens in its own window. */
  create(input: { kind: AccountKind; label?: string; email?: string | null; username?: string | null }): Account {
    if (input.kind !== 'microsoft' && input.kind !== 'discord') throw new ValidationError('kind must be microsoft or discord');
    const label = String(input.label ?? '').trim().slice(0, 60);
    let email: string | null = null;
    if (input.kind === 'microsoft') {
      email = this.normEmail(input.email);
      if (this.repo.accountByEmail('microsoft', email)) throw new ConflictError(`${email} is already in the library`);
    }
    const username = this.cleanUsername(input.kind, input.username);
    const account = this.repo.createAccount({ kind: input.kind, label, email, username, partition: this.newPartition(input.kind) });
    this.audit.record(null, `${input.kind === 'microsoft' ? 'Microsoft' : 'Discord'} account added to the library`, email ? { account: email } : {});
    this.changed(null);
    return account;
  }

  private cleanUsername(kind: AccountKind, input: unknown): string | null {
    const name = String(input ?? '').trim().replace(/^@/, '');
    if (!name) return null;
    if (kind === 'discord' && !DISCORD_NAME.test(name)) throw new ValidationError('Discord usernames have 2–32 letters, digits, _ or .');
    return name.slice(0, 40);
  }

  update(id: number, patch: { label?: string; username?: string | null; ready?: boolean }): Account {
    const a = this.repo.getAccount(id);
    const next = this.repo.updateAccount(id, {
      ...(patch.label !== undefined ? { label: String(patch.label).trim().slice(0, 60) } : {}),
      ...(patch.username !== undefined ? { username: this.cleanUsername(a.kind, patch.username) } : {}),
      ...(patch.ready !== undefined ? { ready: !!patch.ready } : {}),
    });
    if (a.kind === 'discord' && next.identityId !== null) {
      this.repo.upsertDiscord(next.identityId, { username: next.username, displayName: next.username, ...(next.ready ? { oauthState: 'CONNECTED' as const } : {}) });
    }
    this.changed(next.identityId);
    return next;
  }

  /**
   * Account of an identity – created (and linked) if it has none yet. Keeps the identity's former
   * browser profile, so logins made before the library existed are still there.
   */
  ensureFor(identityId: number, kind: AccountKind, email?: string): Account {
    this.repo.getIdentity(identityId);
    const cur = this.repo.accountOf(identityId, kind);
    if (cur) return cur;
    let mail: string | null = null;
    if (kind === 'microsoft') {
      mail = email ? this.normEmail(email) : this.repo.getMinecraft(identityId)?.msaAccount ?? null;
      if (!mail) throw new ValidationError('Enter the Microsoft e-mail of this identity first');
      const existing = this.repo.accountByEmail('microsoft', mail);
      if (existing) {
        if (existing.identityId !== null) throw new ConflictError(`${mail} belongs to another identity – link it from the account library`);
        return this.repo.updateAccount(existing.id, { identityId });
      }
    }
    const legacy = `persist:hoelni-${kind === 'microsoft' ? 'ms' : 'discord'}-${identityId}`;
    const partition = this.repo.accountByPartition(legacy) ? this.newPartition(kind) : legacy;
    const d = kind === 'discord' ? this.repo.getDiscord(identityId) : null;
    const created = this.repo.createAccount({ kind, email: mail, partition, username: d?.username ?? null, ready: d?.oauthState === 'CONNECTED' });
    return this.repo.updateAccount(created.id, { identityId });
  }

  /** Links the account to the identity (null = unlink). Moves it from a previous identity. */
  async link(accountId: number, identityId: number | null): Promise<Account> {
    let a = this.repo.getAccount(accountId);
    if (identityId === null) return this.unlink(accountId);
    this.repo.getIdentity(identityId);
    if (a.identityId === identityId) return a;
    if (a.identityId !== null) await this.unlink(a.id);
    const other = this.repo.accountOf(identityId, a.kind);
    if (other) await this.unlink(other.id);
    a = this.repo.getAccount(accountId); // unlinking remembered its Minecraft name

    await this.moveSecrets(a, 'toIdentity', identityId);
    this.repo.updateAccount(a.id, { identityId });
    if (a.kind === 'microsoft') {
      const cur = this.repo.getMinecraft(identityId);
      const hasTokens = (await this.vault.forIdentity(identityId).get(this.vault.forIdentity(identityId).ref('minecraft'))) !== null;
      this.repo.upsertMinecraft(identityId, {
        username: a.username || cur?.username || `Pending_${identityId}`.slice(0, 16),
        authType: 'microsoft',
        msaAccount: a.email,
        uuid: null,
        authStatus: hasTokens ? 'PENDING' : 'NONE',
        lastError: null,
      });
      // With a saved login the Minecraft sign-in just works again (no code needed).
      if (hasTokens) void this.auth.authenticate(identityId).catch((e) => log.warn(`Sign-in after linking failed: ${(e as Error).message}`));
    } else {
      this.repo.upsertDiscord(identityId, { oauthState: a.ready ? 'CONNECTED' : 'NONE', username: a.username, displayName: a.username, lastError: null });
    }
    this.audit.record(identityId, `${a.kind === 'microsoft' ? 'Microsoft' : 'Discord'} account linked`, a.email ? { account: a.email } : a.username ? { account: a.username } : {});
    this.changed(identityId);
    return this.repo.getAccount(a.id);
  }

  /** Detaches the account from its identity; the account (and its login) stays in the library. */
  async unlink(accountId: number): Promise<Account> {
    const a = this.repo.getAccount(accountId);
    const identityId = a.identityId;
    if (identityId === null) return a;
    if (a.kind === 'microsoft') {
      const mc = this.repo.getMinecraft(identityId);
      if (mc?.username && !mc.username.startsWith('Pending_')) this.repo.updateAccount(a.id, { username: mc.username, ready: mc.authStatus === 'AUTHENTICATED' || a.ready });
      await this.moveSecrets(a, 'toAccount', identityId);
      if (mc) this.repo.upsertMinecraft(identityId, { msaAccount: null, uuid: null, authStatus: 'NONE', credentialRef: null, lastError: null });
    } else {
      await this.moveSecrets(a, 'toAccount', identityId);
      if (this.repo.getDiscord(identityId)) this.repo.upsertDiscord(identityId, { oauthState: 'NONE', username: null, displayName: null, credentialRef: null, lastError: null });
    }
    this.repo.updateAccount(a.id, { identityId: null });
    this.audit.record(identityId, `${a.kind === 'microsoft' ? 'Microsoft' : 'Discord'} account unlinked (stays in the library)`);
    this.changed(identityId);
    return this.repo.getAccount(a.id);
  }

  /** Removes the account from the library (its stored secrets too). */
  async remove(accountId: number): Promise<void> {
    const a = await this.unlink(accountId);
    for (const p of MOVING_SECRETS[a.kind]) await this.vault.store.delete(refs.app(`accounts/${a.id}/${p}`));
    this.repo.deleteAccount(a.id);
    this.audit.record(null, `${a.kind === 'microsoft' ? 'Microsoft' : 'Discord'} account removed from the library`, a.email ? { account: a.email } : {});
    this.changed(null);
  }

  /** Before an identity is deleted: its accounts go back to the library (with their logins). */
  async releaseIdentity(identityId: number): Promise<void> {
    for (const kind of ['microsoft', 'discord'] as const) {
      const a = this.repo.accountOf(identityId, kind);
      if (a) await this.unlink(a.id);
    }
  }

  private async moveSecrets(a: Account, direction: 'toIdentity' | 'toAccount', identityId: number): Promise<void> {
    const iv = this.vault.forIdentity(identityId);
    for (const p of MOVING_SECRETS[a.kind]) {
      const own = refs.app(`accounts/${a.id}/${p}`);
      const inIdentity = iv.ref(p);
      if (direction === 'toIdentity') {
        const v = await this.vault.store.get(own);
        if (v === null) continue;
        await iv.set(inIdentity, v);
        await this.vault.store.delete(own);
      } else {
        const v = await iv.get(inIdentity);
        if (v === null) continue;
        await this.vault.store.set(own, v);
        await iv.delete(inIdentity);
      }
    }
  }

  /** Page for the account's window (the desktop program opens it in the account's browser profile). */
  target(accountId: number, to: string): string {
    const a = this.repo.getAccount(accountId);
    if (a.kind === 'microsoft') {
      if (to === 'outlook') return 'https://outlook.live.com/mail/0/';
      if (to === 'login') return 'https://login.live.com/';
      if (to === 'link') {
        const code = a.identityId !== null ? this.auth.pendingDeviceCode(a.identityId) : null;
        return code ? `https://www.microsoft.com/link?otc=${encodeURIComponent(code.userCode)}` : 'https://www.microsoft.com/link';
      }
      throw new ValidationError('Unknown Microsoft page');
    }
    if (to === 'register') return 'https://discord.com/register';
    if (to === 'login') return 'https://discord.com/login';
    if (to === 'app') return 'https://discord.com/app';
    throw new ValidationError('Unknown Discord page');
  }

  /** What the desktop program needs to open the account's window. */
  window(accountId: number): { id: number; kind: AccountKind; partition: string; title: string; identityId: number | null } {
    const a = this.repo.getAccount(accountId);
    let who = a.label || a.email || (a.username ? `@${a.username}` : `#${a.id}`);
    if (a.identityId !== null) {
      try {
        who = `${this.repo.getIdentity(a.identityId).label} · ${who}`;
      } catch {
        /* identity gone */
      }
    }
    return { id: a.id, kind: a.kind, partition: a.partition, title: `${a.kind === 'microsoft' ? 'Microsoft' : 'Discord'} – ${who}`, identityId: a.identityId };
  }

  private changed(identityId: number | null): void {
    this.bus.emit({ type: 'accounts.changed', data: null });
    if (identityId !== null) this.bus.emit({ type: 'identity.changed', identityId });
  }
}
