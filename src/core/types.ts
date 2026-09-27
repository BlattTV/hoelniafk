/**
 * Domain model of the Hoelni Client Suite.
 *
 * IdentityProfile is the central unit. Every sub-resource carries (or is keyed by)
 * its identityId so ownership can always be verified. Secrets are never part of
 * these objects – only `credentialRef` strings pointing into the vault.
 */

export type HealthLevel = 'HEALTHY' | 'WARNING' | 'ERROR';
export type CheckStatus = 'ok' | 'warn' | 'error' | 'unknown' | 'skipped';

export interface IdentitySettings {
  autoReconnect: boolean;
  reconnectDelaySec: number;
  afk: {
    enabled: boolean;
    /** Anti-AFK action. Only for use on servers you operate. */
    action: 'none' | 'look' | 'swing' | 'jump';
    intervalSec: number;
  };
  /** Ids of chat parser rule-sets (from rules.yaml) active for this identity. */
  parsers: string[];
  discordLinking: 'required' | 'optional' | 'disabled';
  mailEnabled: boolean;
  networkMode: NetworkMode;
  /** off: ignore exit IP; warn: start but flag; block: refuse to start sessions on IP mismatch. */
  networkGuard: 'off' | 'warn' | 'block';
  /** Lightweight runtime mode: physics off for the AFK protocol client. */
  lightweight: boolean;
  /** The real Minecraft client used by "Open game". */
  gameClient: GameClientSettings;
  viewDistance: 'tiny' | 'short' | 'normal' | 'far';
  ui: { color?: string; tags: string[]; notes?: string };
}

export interface GameClientSettings {
  /**
   * takeover:   AFK runs in the lightweight client; "Open game" lets the real game take over the
   *             SAME live connection (no re-login); closing the game leaves the AFK client in place.
   * handover:   like takeover, but the account is handed over by a quick re-login (~1 s) – fallback
   *             for servers/versions where takeover does not work.
   * background: the real game client itself holds the session all the time, minimized;
   *             "Open game" only brings its window to the front (same connection, no re-login).
   */
 mode: 'takeover' | 'handover' | 'background';
  /** "auto" = server profile version, else detected by a status ping through the network profile. */
  version: string;
  loader: 'vanilla' | 'fabric';
  memoryMb: number;
}

export interface IdentityProfile {
  id: number;
  /** Display number (#07). Unique. */
  number: number;
  label: string;
  templateId: number | null;
  networkProfileId: number | null;
  settings: IdentitySettings;
  createdAt: string;
  updatedAt: string;
}

export type McAuthType = 'microsoft' | 'offline';
export type McAuthStatus = 'NONE' | 'PENDING' | 'AUTHENTICATED' | 'EXPIRED' | 'ERROR';

export interface MinecraftIdentity {
  identityId: number;
  username: string;
  uuid: string | null;
  authType: McAuthType;
  authStatus: McAuthStatus;
  /** Microsoft account e-mail used as prismarine-auth cache key (not a secret). */
  msaAccount: string | null;
  credentialRef: string | null;
  lastAuthAt: string | null;
  lastError: string | null;
}

export type MailAccountKind = 'imap' | 'microsoft' | 'google';

/** A real mailbox (connection). Can be shared by several identities via aliases. */
export interface MailAccount {
  id: number;
  label: string;
  kind: MailAccountKind;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  username: string;
  smtpHost: string | null;
  smtpPort: number | null;
  webmailUrl: string | null;
  /** If set, the mailbox is dedicated to exactly one identity. */
  exclusiveIdentityId: number | null;
  aliasProviderId: number | null;
  credentialRef: string | null;
  createdAt: string;
}

export type MailAccessStatus = 'UNKNOWN' | 'OK' | 'ERROR';

export interface MailIdentity {
  identityId: number;
  mailAccountId: number;
  address: string;
  isAlias: boolean;
  accessStatus: MailAccessStatus;
  unreadCount: number;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export type DiscordOAuthState = 'NONE' | 'PENDING' | 'CONNECTED' | 'EXPIRED' | 'ERROR';
export type LinkState = 'UNKNOWN' | 'WAITING' | 'LINKED' | 'ERROR';

export interface DiscordIdentity {
  identityId: number;
  discordUserId: string | null;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  oauthState: DiscordOAuthState;
  credentialRef: string | null;
  linkedToMinecraft: boolean;
  linkState: LinkState;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export type NetworkMode = 'DIRECT' | 'PER_ACCOUNT' | 'SHARED';
export type NetworkKind = 'DIRECT' | 'BIND' | 'SOCKS5' | 'HTTP';

export interface NetworkProfile {
  id: number;
  /** Owner. A network profile is never shared between identities. */
  identityId: number;
  name: string;
  kind: NetworkKind;
  localBindIp: string | null;
  proxyHost: string | null;
  proxyPort: number | null;
  proxyUsername: string | null;
  credentialRef: string | null;
  expectedPublicIp: string | null;
  actualPublicIp: string | null;
  exitLabel: string | null;
  checkStatus: 'UNKNOWN' | 'OK' | 'MISMATCH' | 'ERROR';
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface MinecraftServer {
  id: number;
  name: string;
  host: string;
  port: number;
  version: string | null;
}

export interface ServerAssignment {
  id: number;
  identityId: number;
  serverId: number;
  enabled: boolean;
  autoStart: boolean;
  /** Optional per-session network override. Must be owned by the same identity. */
  networkProfileId: number | null;
  /** Desired state maintained by the reconciler. */
  desiredState: DesiredState;
}

export type DesiredState = 'ONLINE' | 'OFFLINE';

export interface RewardState {
  identityId: number;
  stars: number;
  eligible: boolean;
  lastUpdate: string | null;
}

export interface RewardHistoryEntry {
  id: number;
  identityId: number;
  serverId: number | null;
  ts: string;
  kind: 'stars' | 'eligible' | 'received' | 'waiting' | 'discordLinked';
  delta: number;
  stars: number;
  reason: string;
}

/** Reward status of one identity on one server (all fields driven by chat rules). */
export interface ServerRewardState {
  identityId: number;
  serverId: number;
  stars: number;
  eligible: boolean | null;
  received: boolean | null;
  waiting: boolean | null;
  discordLinked: boolean | null;
  lastChange: string | null;
  lastMessage: string | null;
}

export interface IdentityTemplateConfig {
  settings: Partial<IdentitySettings>;
  /** Server names to assign. */
  servers: string[];
  /** Network rule for new identities (never a concrete IP or credential). */
  network: { mode: NetworkMode; kind?: NetworkKind };
}

export interface IdentityTemplate {
  id: number;
  name: string;
  config: IdentityTemplateConfig;
}

/**
 * STOPPED       not running, not desired
 * STARTING      preflight (network guard, auth)
 * CONNECTING / AUTHENTICATING / ONLINE   runtime phases
 * STOPPING      stop requested
 * RECONNECTING  desired ONLINE, waiting for the next attempt (backoff)
 * BLOCKED       desired ONLINE but the reconnect policy forbids automatic retries
 */
export type SessionState = 'STOPPED' | 'STARTING' | 'CONNECTING' | 'AUTHENTICATING' | 'ONLINE' | 'STOPPING' | 'RECONNECTING' | 'BLOCKED';

export interface SessionInfo {
  id: string;
  identityId: number;
  serverId: number;
  serverName: string;
  networkProfileId: number | null;
  desiredState: DesiredState;
  state: SessionState;
  since: string;
  lastError: string | null;
  lastEndReason: string | null;
  reconnects: number;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  onlineSince: string | null;
  /** Which client holds the session right now. */
  runtime: 'lightweight' | 'game';
  /** Live takeover state: the real game plays on the lightweight session's connection. */
  takeover: 'none' | 'launching' | 'attached';
  game: import('../runtime/types.js').GameInfo | null;
  stats: import('../runtime/types.js').SessionStats | null;
  username: string | null;
}

export interface ChatLine {
  ts: string;
  sessionId: string;
  identityId: number;
  serverId: number;
  text: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  identityId: number | null;
  action: string;
  detail: string;
}

export const DEFAULT_SETTINGS: IdentitySettings = {
  autoReconnect: true,
  reconnectDelaySec: 15,
  afk: { enabled: true, action: 'look', intervalSec: 45 },
  parsers: ['hoelni-linking', 'hoelni-rewards'],
  discordLinking: 'optional',
  mailEnabled: true,
  networkMode: 'PER_ACCOUNT',
  networkGuard: 'warn',
  lightweight: true,
  gameClient: { mode: 'takeover', version: 'auto', loader: 'vanilla', memoryMb: 2048 },
  viewDistance: 'tiny',
  ui: { tags: [] },
};

export function mergeSettings(base: IdentitySettings, patch: Partial<IdentitySettings> | undefined): IdentitySettings {
  if (!patch) return structuredClone(base);
  return {
    ...base,
    ...patch,
    afk: { ...base.afk, ...(patch.afk ?? {}) },
    gameClient: { ...DEFAULT_SETTINGS.gameClient, ...(base.gameClient ?? {}), ...(patch.gameClient ?? {}) },
    ui: { ...base.ui, ...(patch.ui ?? {}), tags: [...(patch.ui?.tags ?? base.ui.tags)] },
    parsers: [...(patch.parsers ?? base.parsers)],
  };
}
