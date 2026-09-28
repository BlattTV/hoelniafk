import crypto from 'node:crypto';
/**
 * Discord Identity Manager – no Discord developer app, no OAuth.
 *
 * Every identity has its own Discord login in its own window (desktop program: persistent browser
 * profile per identity). The suite never automates Discord accounts (no self-bots) and never creates
 * them itself: it opens the official sign-up / login page in the identity's window, the user fills it
 * in, then marks the account as set up (optionally with its username for the overview).
 */
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { ValidationError } from '../core/errors.js';
import { registerSecret } from '../core/logger.js';
import type { DiscordIdentity } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { Vault } from '../vault/vault.js';

export const DISCORD_SIGNUP_URL = 'https://discord.com/register';
export const DISCORD_APP_URL = 'https://discord.com/app';
export const DISCORD_LOGIN_URL = 'https://discord.com/login';

export type DiscordTarget = 'register' | 'login' | 'app';

/** Pages a Discord profile window may be opened on (everything else is refused). */
export function isDiscordUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(discord\.com|discordapp\.com|discord\.gg)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export class DiscordService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {}

  /**
   * Page for this identity's Discord profile window. The suite never fills in or submits Discord forms:
   * the user registers / signs in there; the suite only opens the right page in the right profile.
   */
  target(identityId: number, to: DiscordTarget): string {
    this.repo.getIdentity(identityId);
    if (to === 'register') return this.beginSignup(identityId).url;
    if (to === 'login') return DISCORD_LOGIN_URL;
    return DISCORD_APP_URL;
  }

  /** Sign-up helper: suggested data for the registration form (the password stays in the vault). */
  async signupKit(identityId: number, email: string | null, minecraftName: string | null): Promise<{ email: string | null; username: string; hasPassword: boolean }> {
    const iv = this.vault.forIdentity(identityId);
    const hasPassword = (await iv.get(iv.ref('discord-password'))) !== null;
    const base = (minecraftName || this.repo.getIdentity(identityId).label).toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 24) || `hoelni${identityId}`;
    return { email, username: base.length >= 2 ? base : `${base}_hoelni`, hasPassword };
  }

  /** Strong password for the Discord sign-up of this identity – generated once, kept in the vault. */
  async password(identityId: number): Promise<string> {
    const iv = this.vault.forIdentity(identityId);
    const ref = iv.ref('discord-password');
    let pw = await iv.get(ref);
    if (!pw) {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const bytes = crypto.randomBytes(20);
      pw = `${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}!7`;
      await iv.set(ref, pw);
      this.audit.record(identityId, 'Discord password generated (vault)');
    }
    registerSecret(pw);
    return pw;
  }

  /** Step 1 of "Create Discord Account": the user registers on discord.com themselves. */
  beginSignup(identityId: number): { url: string } {
    this.repo.getIdentity(identityId);
    this.repo.upsertDiscord(identityId, { oauthState: this.repo.getDiscord(identityId)?.oauthState ?? 'NONE' });
    this.audit.record(identityId, 'Discord sign-up opened in browser');
    return { url: DISCORD_SIGNUP_URL };
  }

  /** The user signed in / registered in the identity's Discord window and marks it as set up. */
  markReady(identityId: number, usernameInput?: string | null): DiscordIdentity {
    this.repo.getIdentity(identityId);
    const username = String(usernameInput ?? '').trim().replace(/^@/, '');
    if (username && !/^[a-z0-9_.]{2,32}$/i.test(username)) throw new ValidationError('Discord usernames have 2–32 letters, digits, _ or .');
    const cur = this.repo.getDiscord(identityId);
    const updated = this.repo.upsertDiscord(identityId, {
      oauthState: 'CONNECTED',
      username: username || cur?.username || null,
      displayName: username || cur?.displayName || null,
      lastError: null,
    });
    this.audit.record(identityId, 'Discord account set up', username ? { discordUser: username } : {});
    this.bus.emit({ type: 'identity.changed', identityId });
    return updated;
  }

  async disconnect(identityId: number): Promise<void> {
    const d = this.repo.getDiscord(identityId);
    if (d?.credentialRef) await this.vault.forIdentity(identityId).delete(d.credentialRef);
    this.repo.upsertDiscord(identityId, {
      discordUserId: null,
      username: null,
      displayName: null,
      avatar: null,
      oauthState: 'NONE',
      credentialRef: null,
      linkedToMinecraft: false,
      linkState: 'UNKNOWN',
      lastError: null,
    });
    this.audit.record(identityId, 'Discord disconnected');
    this.bus.emit({ type: 'identity.changed', identityId });
  }
}
