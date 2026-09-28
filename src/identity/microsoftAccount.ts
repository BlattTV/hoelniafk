/**
 * ONE Microsoft sign-in per identity → Outlook mail AND Minecraft.
 *
 *   "Sign in with Microsoft" (browser, your Azure app, PKCE)
 *     consent: Outlook IMAP/SMTP + XboxLive.signin + offline_access + openid/email
 *       │
 *       ├─ refresh token → identity vault (vault://identity/<id>/microsoft) – never SQLite, never logs
 *       ├─ Outlook: mailbox for the account's own address is created and assigned to the identity;
 *       │           IMAP/SMTP tokens come from the shared grant (scope: outlook.office.com)
 *       └─ Minecraft: Xbox Live → XSTS → Minecraft token from the same grant (scope: XboxLive.signin).
 *                     If Mojang has not approved the Azure app for Minecraft yet (403), the suite
 *                     falls back to the Minecraft sign-in code for this identity automatically.
 */
import type { AuditLog } from '../core/audit.js';
import { ValidationError } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import { createLogger, registerSecret } from '../core/logger.js';
import { idTokenClaims, type OAuthManager, type TokenSet } from '../core/oauth.js';
import { nowIso } from '../core/db.js';
import type { JavaSession } from '../runtime/types.js';
import type { MailService } from '../mail/mailService.js';
import type { MinecraftAuthService, JavaTokenResult } from '../minecraft/authService.js';
import { formatUuid } from '../minecraft/authService.js';
import { minecraftFromMicrosoft, MinecraftAppNotApprovedError, defaultJsonHttp, XBOX_ENDPOINTS, type JsonHttp, type XboxEndpoints } from '../minecraft/xboxChain.js';
import { refs } from '../vault/refs.js';
import type { Vault } from '../vault/vault.js';
import type { IdentityRepository } from './repository.js';

const log = createLogger('microsoft');

export const OUTLOOK_SCOPES = ['https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send', 'offline_access'];
export const XBOX_SCOPES = ['XboxLive.signin', 'offline_access'];
const CONSENT_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'XboxLive.signin', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'];

interface StoredGrant {
  refreshToken: string;
  email: string;
  /** 'direct' = Minecraft via this grant; 'code' = Mojang has not approved the app → sign-in code flow */
  minecraft: 'direct' | 'code' | 'none';
  linkedAt: string;
}

interface CachedMc extends JavaTokenResult {
  expiresAt: number;
}

export interface MicrosoftLinkStatus {
  linked: boolean;
  email: string | null;
  minecraft: 'direct' | 'code' | 'none' | null;
  mailboxId: number | null;
}

export class MicrosoftAccountService {
  private readonly access = new Map<string, { token: string; expiresAt: number }>();
  private readonly mc = new Map<number, CachedMc>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly oauth: OAuthManager,
    private readonly mail: MailService,
    private readonly minecraftAuth: MinecraftAuthService,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly http: JsonHttp = defaultJsonHttp,
    private readonly endpoints: XboxEndpoints = XBOX_ENDPOINTS,
  ) {}

  private ref(identityId: number): string {
    return this.vault.forIdentity(identityId).ref('microsoft');
  }

  private async grant(identityId: number): Promise<StoredGrant | null> {
    return this.vault.forIdentity(identityId).getJson<StoredGrant>(this.ref(identityId));
  }

  async status(identityId: number): Promise<MicrosoftLinkStatus> {
    const g = await this.grant(identityId);
    const mailbox = g ? this.repo.listMailAccounts().find((m) => m.exclusiveIdentityId === identityId && m.kind === 'microsoft' && m.username.toLowerCase() === g.email.toLowerCase()) : undefined;
    return { linked: !!g, email: g?.email ?? null, minecraft: g?.minecraft ?? null, mailboxId: mailbox?.id ?? null };
  }

  /** Step 1: browser sign-in (one consent for Outlook + Xbox Live). */
  async begin(identityId: number, loginHint?: string): Promise<{ url: string }> {
    this.repo.getIdentity(identityId);
    const { url } = await this.oauth.begin('microsoft', { type: 'microsoft-account', identityId }, {
      scopes: CONSENT_SCOPES,
      // the code is redeemed for one resource (Outlook) – Xbox tokens come from the refresh token
      tokenScopes: ['openid', 'email', ...OUTLOOK_SCOPES],
      loginHint,
      prompt: 'select_account',
    });
    return { url };
  }

  /** Step 2 (OAuth callback): store the grant, set up Outlook, connect Minecraft. */
  async complete(identityId: number, tokens: TokenSet): Promise<{ email: string; mailboxId: number; minecraft: StoredGrant['minecraft']; username: string | null }> {
    if (!tokens.refreshToken) throw new ValidationError('Microsoft returned no refresh token (offline_access missing)');
    const claims = idTokenClaims(tokens.idToken);
    const email = String(claims.email ?? claims.preferred_username ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new ValidationError('Microsoft did not return the account e-mail address');
    registerSecret(tokens.refreshToken);
    const iv = this.vault.forIdentity(identityId);
    await iv.setJson(this.ref(identityId), { refreshToken: tokens.refreshToken, email, minecraft: 'none', linkedAt: nowIso() } satisfies StoredGrant);
    this.access.set(`${identityId}:outlook`, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    this.audit.record(identityId, 'Microsoft account connected', { account: email });

    // ---- Outlook: the account's own mailbox, dedicated to this identity
    let mailbox = this.repo.listMailAccounts().find((m) => m.kind === 'microsoft' && m.username.toLowerCase() === email && m.exclusiveIdentityId === identityId);
    if (!mailbox) {
      mailbox = this.repo.createMailAccount({
        label: `Outlook – ${email}`,
        kind: 'microsoft',
        imapHost: 'outlook.office365.com',
        imapPort: 993,
        imapSecure: true,
        username: email,
        smtpHost: 'smtp-mail.outlook.com',
        smtpPort: 587,
        webmailUrl: 'https://outlook.live.com/mail/',
        exclusiveIdentityId: identityId,
        aliasProviderId: null,
      });
    }
    await this.mail.linkMailboxToIdentityGrant(mailbox.id, identityId);
    this.repo.assignMail(identityId, { mailAccountId: mailbox.id, address: email, isAlias: false });
    void this.mail.syncMailbox(mailbox.id).catch((e) => log.warn(`First mail sync failed: ${(e as Error).message}`));

    // ---- Minecraft: same account
    const cur = this.repo.getMinecraft(identityId);
    this.repo.upsertMinecraft(identityId, {
      username: cur?.username || `Pending_${identityId}`.slice(0, 16),
      authType: 'microsoft',
      msaAccount: email,
      authStatus: 'PENDING',
      lastError: null,
    });
    const mode = await this.connectMinecraft(identityId);
    this.bus.emit({ type: 'identity.changed', identityId });
    return { email, mailboxId: mailbox.id, minecraft: mode, username: this.repo.getMinecraft(identityId)?.username ?? null };
  }

  private async connectMinecraft(identityId: number): Promise<StoredGrant['minecraft']> {
    try {
      const r = await this.minecraftDirect(identityId, true);
      await this.setMode(identityId, 'direct');
      this.repo.upsertMinecraft(identityId, {
        username: r.profile.name,
        uuid: formatUuid(r.profile.id),
        authStatus: 'AUTHENTICATED',
        credentialRef: this.ref(identityId),
        lastAuthAt: nowIso(),
        lastError: null,
      });
      this.audit.record(identityId, 'Minecraft connected via Microsoft account', { username: r.profile.name });
      return 'direct';
    } catch (e) {
      if (e instanceof MinecraftAppNotApprovedError) {
        // Fallback: the Minecraft sign-in code (Microsoft's own Minecraft login) for the same account.
        await this.setMode(identityId, 'code');
        log.info(`Identity ${identityId}: Azure app not approved for Minecraft – using the sign-in code`);
        void this.minecraftAuth.authenticate(identityId).catch(() => undefined);
        return 'code';
      }
      const msg = (e as Error).message;
      this.repo.upsertMinecraft(identityId, { authStatus: 'ERROR', lastError: msg.slice(0, 300) });
      this.audit.record(identityId, 'Minecraft via Microsoft account failed');
      return 'none';
    }
  }

  private async setMode(identityId: number, minecraft: StoredGrant['minecraft']): Promise<void> {
    const g = await this.grant(identityId);
    if (g) await this.vault.forIdentity(identityId).setJson(this.ref(identityId), { ...g, minecraft });
  }

  /** Access token for one resource from the shared grant (refresh token rotation is persisted). */
  async accessToken(identityId: number, resource: 'outlook' | 'xbox'): Promise<string> {
    const key = `${identityId}:${resource}`;
    const hit = this.access.get(key);
    if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
    const g = await this.grant(identityId);
    if (!g) throw new ValidationError('This identity is not signed in with Microsoft');
    const t = await this.oauth.refresh('microsoft', g.refreshToken, resource === 'outlook' ? OUTLOOK_SCOPES : XBOX_SCOPES);
    if (t.refreshToken && t.refreshToken !== g.refreshToken) {
      await this.vault.forIdentity(identityId).setJson(this.ref(identityId), { ...g, refreshToken: t.refreshToken });
    }
    this.access.set(key, { token: t.accessToken, expiresAt: t.expiresAt });
    return t.accessToken;
  }

  /** Minecraft session straight from the Microsoft grant (null when this identity uses the code flow). */
  async minecraftSession(identityId: number): Promise<JavaSession | null> {
    const g = await this.grant(identityId);
    if (!g || g.minecraft !== 'direct') return null;
    const r = await this.minecraftDirect(identityId, false);
    return { accessToken: r.accessToken, profile: r.profile, profileKeys: r.profileKeys };
  }

  private async minecraftDirect(identityId: number, force: boolean): Promise<CachedMc> {
    const cached = this.mc.get(identityId);
    if (!force && cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached;
    const r = await minecraftFromMicrosoft(await this.accessToken(identityId, 'xbox'), this.http, this.endpoints);
    registerSecret(r.accessToken);
    this.mc.set(identityId, r);
    return r;
  }

  async unlink(identityId: number): Promise<void> {
    await this.vault.forIdentity(identityId).delete(this.ref(identityId));
    for (const k of [...this.access.keys()]) if (k.startsWith(`${identityId}:`)) this.access.delete(k);
    this.mc.delete(identityId);
    this.audit.record(identityId, 'Microsoft account disconnected');
    this.bus.emit({ type: 'identity.changed', identityId });
  }

  /** Mailbox secret of the "linked" kind points here. */
  static mailboxSecret(identityId: number) {
    return { type: 'ms-identity' as const, identityId, ref: refs.identity(identityId, 'microsoft') };
  }
}
