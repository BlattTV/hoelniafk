/**
 * Generic OAuth2 authorization-code flow with PKCE, used for
 *   - Microsoft / Google mailboxes (IMAP/SMTP via XOAUTH2)
 *   - Discord account connection
 *
 * The redirect goes to the suite's own loopback server (127.0.0.1). Refresh tokens
 * are handed back to the caller, which stores them in the vault – never in SQLite
 * or logs.
 */
import crypto from 'node:crypto';
import { SuiteError, ValidationError } from './errors.js';
import { registerSecret } from './logger.js';

export type OAuthProviderName = 'microsoft' | 'google' | 'discord';

export interface OAuthProviderConfig {
  clientId: string;
  /** Optional – public clients (PKCE) need none. */
  clientSecret?: string | null;
  tenant?: string;
  scopes?: string[];
  /** Optional endpoint overrides (self-hosted identity providers, local integration tests). */
  authorizeUrl?: string | null;
  tokenUrl?: string | null;
}

interface ProviderPreset {
  authorizeUrl: (cfg: OAuthProviderConfig) => string;
  tokenUrl: (cfg: OAuthProviderConfig) => string;
  defaultScopes: string[];
  extraParams?: Record<string, string>;
}

export const OAUTH_PRESETS: Record<OAuthProviderName, ProviderPreset> = {
  microsoft: {
    authorizeUrl: (c) => `https://login.microsoftonline.com/${c.tenant || 'consumers'}/oauth2/v2.0/authorize`,
    tokenUrl: (c) => `https://login.microsoftonline.com/${c.tenant || 'consumers'}/oauth2/v2.0/token`,
    defaultScopes: ['https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send', 'offline_access', 'openid', 'email'],
    extraParams: { prompt: 'select_account' },
  },
  google: {
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    defaultScopes: ['https://mail.google.com/', 'openid', 'email'],
    extraParams: { access_type: 'offline', prompt: 'consent' },
  },
  discord: {
    authorizeUrl: () => 'https://discord.com/oauth2/authorize',
    tokenUrl: () => 'https://discord.com/api/oauth2/token',
    defaultScopes: ['identify'],
    extraParams: { prompt: 'consent' },
  },
};

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string | null;
  /** OpenID Connect ID token (only when "openid" was requested) – used for the account's e-mail address. */
  idToken?: string | null;
}

/** Claims of an ID token received directly from the token endpoint (TLS) – no signature check needed. */
export function idTokenClaims(idToken: string | null | undefined): Record<string, any> {
  if (!idToken) return {};
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export type OAuthPurpose =
  | { type: 'mailbox'; mailboxId: number }
  | { type: 'discord'; identityId: number }
  /** One Microsoft sign-in for an identity: Outlook mail + Minecraft (Xbox Live). */
  | { type: 'microsoft-account'; identityId: number };

interface PendingFlow {
  provider: OAuthProviderName;
  purpose: OAuthPurpose;
  verifier: string;
  redirectUri: string;
  createdAt: number;
  /** Scope for the code redemption (one resource) when consent covered several resources. */
  tokenScopes?: string[];
}

export type HttpPost = (url: string, form: Record<string, string>) => Promise<{ status: number; json: any }>;

export const defaultHttpPost: HttpPost = async (url, form) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20000),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

const FLOW_TTL_MS = 15 * 60 * 1000;

export class OAuthManager {
  private readonly pending = new Map<string, PendingFlow>();

  constructor(
    private readonly getConfig: (p: OAuthProviderName) => Promise<OAuthProviderConfig | null>,
    private readonly redirectUri: () => string,
    private readonly post: HttpPost = defaultHttpPost,
  ) {}

  async isConfigured(provider: OAuthProviderName): Promise<boolean> {
    return !!(await this.getConfig(provider))?.clientId;
  }

  async begin(
    provider: OAuthProviderName,
    purpose: OAuthPurpose,
    opts: { loginHint?: string; scopes?: string[]; tokenScopes?: string[]; prompt?: string } = {},
  ): Promise<{ url: string; state: string }> {
    const cfg = await this.getConfig(provider);
    if (!cfg?.clientId) throw new ValidationError(`OAuth client for ${provider} is not configured (Settings → OAuth)`);
    this.gc();
    const preset = OAUTH_PRESETS[provider];
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = this.redirectUri();
    this.pending.set(state, { provider, purpose, verifier, redirectUri, createdAt: Date.now(), tokenScopes: opts.tokenScopes });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: (opts.scopes ?? (cfg.scopes?.length ? cfg.scopes : preset.defaultScopes)).join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(preset.extraParams ?? {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    });
    if (opts.loginHint && provider !== 'discord') params.set('login_hint', opts.loginHint);
    return { url: `${cfg.authorizeUrl || preset.authorizeUrl(cfg)}?${params.toString()}`, state };
  }

  /** Completes a flow started with begin(). The state value is single-use. */
  async complete(state: string, code: string): Promise<{ provider: OAuthProviderName; purpose: OAuthPurpose; tokens: TokenSet }> {
    const flow = this.pending.get(state);
    this.pending.delete(state);
    if (!flow || Date.now() - flow.createdAt > FLOW_TTL_MS) throw new SuiteError('Unknown or expired OAuth state', 400);
    const cfg = await this.getConfig(flow.provider);
    if (!cfg) throw new SuiteError('OAuth provider no longer configured', 400);
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      client_id: cfg.clientId,
      code_verifier: flow.verifier,
    };
    if (flow.tokenScopes?.length) form.scope = flow.tokenScopes.join(' ');
    if (cfg.clientSecret) form.client_secret = cfg.clientSecret;
    const tokens = await this.tokenRequest(flow.provider, cfg, form);
    return { provider: flow.provider, purpose: flow.purpose, tokens };
  }

  /** scopes: needed when the grant covers several resources (e.g. Outlook + Xbox Live) – one resource per token. */
  async refresh(provider: OAuthProviderName, refreshToken: string, scopes?: string[]): Promise<TokenSet> {
    const cfg = await this.getConfig(provider);
    if (!cfg?.clientId) throw new ValidationError(`OAuth client for ${provider} is not configured`);
    const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cfg.clientId };
    if (scopes?.length) form.scope = scopes.join(' ');
    if (cfg.clientSecret) form.client_secret = cfg.clientSecret;
    const t = await this.tokenRequest(provider, cfg, form);
    return { ...t, refreshToken: t.refreshToken ?? refreshToken };
  }

  private async tokenRequest(provider: OAuthProviderName, cfg: OAuthProviderConfig, form: Record<string, string>): Promise<TokenSet> {
    const res = await this.post(cfg.tokenUrl || OAUTH_PRESETS[provider].tokenUrl(cfg), form);
    if (res.status >= 400 || !res.json?.access_token) {
      // Only the error code is surfaced – never the request or response bodies.
      throw new SuiteError(`OAuth token request failed (${res.status}${res.json?.error ? `: ${res.json.error}` : ''})`, 502);
    }
    registerSecret(res.json.access_token);
    if (res.json.refresh_token) registerSecret(res.json.refresh_token);
    return {
      accessToken: res.json.access_token,
      refreshToken: res.json.refresh_token ?? null,
      expiresAt: Date.now() + (Number(res.json.expires_in) || 3600) * 1000,
      scope: res.json.scope ?? null,
      idToken: res.json.id_token ?? null,
    };
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > FLOW_TTL_MS) this.pending.delete(k);
  }
}
