/**
 * Discord Identity Manager.
 *
 * Existing Discord accounts are connected exclusively via the official OAuth2
 * authorization-code flow (scope "identify"). The suite never automates normal
 * user accounts (no self-bots) and never creates Discord accounts itself:
 * "Create Discord Account" only opens the official sign-up page in the user's
 * browser; afterwards the user connects the new account via OAuth2.
 */
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { ConflictError, SuiteError, ValidationError } from '../core/errors.js';
import { nowIso } from '../core/db.js';
import type { OAuthManager, TokenSet } from '../core/oauth.js';
import type { DiscordIdentity } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { Vault } from '../vault/vault.js';

export const DISCORD_SIGNUP_URL = 'https://discord.com/register';
export const DISCORD_APP_URL = 'https://discord.com/app';

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export type DiscordUserFetcher = (accessToken: string) => Promise<DiscordUser>;

export const fetchDiscordUser: DiscordUserFetcher = async (accessToken) => {
  // API base overridable for local integration tests only.
  const base = process.env.HOELNI_DISCORD_API_BASE || 'https://discord.com/api/v10';
  const res = await fetch(`${base}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new SuiteError(`Discord API returned ${res.status}`, 502);
  return (await res.json()) as DiscordUser;
};

interface DiscordSecret {
  refreshToken: string;
}

export class DiscordService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly oauth: OAuthManager,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly fetchUser: DiscordUserFetcher = fetchDiscordUser,
  ) {}

  /** Step 1 of "Create Discord Account": the user registers on discord.com themselves. */
  beginSignup(identityId: number): { url: string } {
    this.repo.getIdentity(identityId);
    this.repo.upsertDiscord(identityId, { oauthState: this.repo.getDiscord(identityId)?.oauthState ?? 'NONE' });
    this.audit.record(identityId, 'Discord sign-up opened in browser');
    return { url: DISCORD_SIGNUP_URL };
  }

  /** Starts the OAuth2 connect flow for this identity. */
  async beginConnect(identityId: number): Promise<{ url: string }> {
    this.repo.getIdentity(identityId);
    const { url } = await this.oauth.begin('discord', { type: 'discord', identityId });
    this.repo.upsertDiscord(identityId, { oauthState: 'PENDING', lastError: null });
    this.bus.emit({ type: 'identity.changed', identityId });
    return { url };
  }

  /** Called by the OAuth callback with the identity bound to the (single-use) state. */
  async completeConnect(identityId: number, tokens: TokenSet): Promise<DiscordIdentity> {
    const user = await this.fetchUser(tokens.accessToken);
    const owner = this.repo.findIdentityByDiscordUser(user.id);
    if (owner !== null && owner !== identityId) {
      this.repo.upsertDiscord(identityId, { oauthState: 'ERROR', lastError: 'This Discord account is already connected to another identity' });
      this.audit.record(identityId, 'Discord connect rejected (account belongs to another identity)', { otherIdentity: owner });
      throw new ConflictError(`Discord account is already connected to identity ${owner}`);
    }
    const current = this.repo.getDiscord(identityId);
    if (current?.discordUserId && current.discordUserId !== user.id) {
      // A different Discord account replaces the old one: the link to Minecraft must be re-established.
      this.audit.record(identityId, 'Discord account replaced');
    }
    const iv = this.vault.forIdentity(identityId);
    const ref = iv.ref('discord');
    if (tokens.refreshToken) await iv.setJson(ref, { refreshToken: tokens.refreshToken } satisfies DiscordSecret);
    const replaced = current?.discordUserId && current.discordUserId !== user.id;
    const updated = this.repo.upsertDiscord(identityId, {
      discordUserId: user.id,
      username: user.username,
      displayName: user.global_name ?? user.username,
      avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null,
      oauthState: 'CONNECTED',
      credentialRef: tokens.refreshToken ? ref : current?.credentialRef ?? null,
      lastVerifiedAt: nowIso(),
      lastError: null,
      ...(replaced ? { linkedToMinecraft: false, linkState: 'UNKNOWN' as const } : {}),
    });
    this.audit.record(identityId, 'Discord connected', { discordUser: user.username });
    this.bus.emit({ type: 'identity.changed', identityId });
    return updated;
  }

  /** Re-validates the stored OAuth grant (refresh → /users/@me). */
  async verify(identityId: number): Promise<DiscordIdentity> {
    const d = this.repo.getDiscord(identityId);
    if (!d?.credentialRef) throw new ValidationError('Discord is not connected for this identity');
    const iv = this.vault.forIdentity(identityId);
    const secret = await iv.getJson<DiscordSecret>(d.credentialRef);
    if (!secret) {
      return this.repo.upsertDiscord(identityId, { oauthState: 'EXPIRED', lastError: 'Refresh token missing' });
    }
    try {
      const tokens = await this.oauth.refresh('discord', secret.refreshToken);
      if (tokens.refreshToken && tokens.refreshToken !== secret.refreshToken) await iv.setJson(d.credentialRef, { refreshToken: tokens.refreshToken });
      const user = await this.fetchUser(tokens.accessToken);
      if (d.discordUserId && user.id !== d.discordUserId) {
        throw new ConflictError('Stored grant belongs to a different Discord account');
      }
      const updated = this.repo.upsertDiscord(identityId, {
        username: user.username,
        displayName: user.global_name ?? user.username,
        oauthState: 'CONNECTED',
        lastVerifiedAt: nowIso(),
        lastError: null,
      });
      this.bus.emit({ type: 'identity.changed', identityId });
      return updated;
    } catch (e) {
      const updated = this.repo.upsertDiscord(identityId, { oauthState: 'EXPIRED', lastError: (e as Error).message.slice(0, 300) });
      this.audit.record(identityId, 'Discord OAuth verification failed');
      this.bus.emit({ type: 'identity.changed', identityId });
      return updated;
    }
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
