import type { DB } from '../core/db.js';
import { normalizeSchedule, type WeekSchedule } from '../core/schedule.js';
import { nowIso } from '../core/db.js';
import { ConflictError, IsolationError, NotFoundError, ValidationError } from '../core/errors.js';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Account,
  type AccountKind,
  type DiscordIdentity,
  type IdentityProfile,
  type IdentitySettings,
  type IdentityTemplate,
  type IdentityTemplateConfig,
  type MailAccount,
  type MailIdentity,
  type MinecraftIdentity,
  type MinecraftServer,
  type NetworkProfile,
  type RewardHistoryEntry,
  type RewardState,
  type ServerAssignment,
  type ServerRewardState,
  type DesiredState,
  type Placement,
} from '../core/types.js';

type Row = Record<string, any>;

const bool = (v: unknown) => v === 1 || v === true;

function mapIdentity(r: Row): IdentityProfile {
  return {
    id: r.id,
    number: r.number,
    label: r.label,
    templateId: r.template_id,
    networkProfileId: r.network_profile_id,
    settings: mergeSettings(DEFAULT_SETTINGS, JSON.parse(r.settings_json)),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMinecraft(r: Row): MinecraftIdentity {
  return {
    identityId: r.identity_id,
    username: r.username,
    uuid: r.uuid,
    authType: r.auth_type,
    authStatus: r.auth_status,
    msaAccount: r.msa_account,
    credentialRef: r.credential_ref,
    lastAuthAt: r.last_auth_at,
    lastError: r.last_error,
  };
}

function mapMailAccount(r: Row): MailAccount {
  return {
    id: r.id,
    label: r.label,
    kind: r.kind,
    imapHost: r.imap_host,
    imapPort: r.imap_port,
    imapSecure: bool(r.imap_secure),
    username: r.username,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    webmailUrl: r.webmail_url,
    exclusiveIdentityId: r.exclusive_identity_id,
    aliasProviderId: r.alias_provider_id,
    credentialRef: r.credential_ref,
    createdAt: r.created_at,
  };
}

function mapMailIdentity(r: Row): MailIdentity {
  return {
    identityId: r.identity_id,
    mailAccountId: r.mail_account_id,
    address: r.address,
    isAlias: bool(r.is_alias),
    accessStatus: r.access_status,
    unreadCount: r.unread_count,
    lastCheckedAt: r.last_checked_at,
    lastError: r.last_error,
  };
}

function mapDiscord(r: Row): DiscordIdentity {
  return {
    identityId: r.identity_id,
    discordUserId: r.discord_user_id,
    username: r.username,
    displayName: r.display_name,
    avatar: r.avatar,
    oauthState: r.oauth_state,
    credentialRef: r.credential_ref,
    linkedToMinecraft: bool(r.linked_to_minecraft),
    linkState: r.link_state,
    lastVerifiedAt: r.last_verified_at,
    lastError: r.last_error,
  };
}

function mapNetwork(r: Row): NetworkProfile {
  return {
    id: r.id,
    identityId: r.identity_id,
    name: r.name,
    kind: r.kind,
    localBindIp: r.local_bind_ip,
    proxyHost: r.proxy_host,
    proxyPort: r.proxy_port,
    proxyUsername: r.proxy_username,
    credentialRef: r.credential_ref,
    expectedPublicIp: r.expected_public_ip,
    actualPublicIp: r.actual_public_ip,
    exitLabel: r.exit_label,
    checkStatus: r.check_status,
    lastCheckedAt: r.last_checked_at,
    lastError: r.last_error,
  };
}

function mapAssignment(r: Row): ServerAssignment {
  return {
    id: r.id,
    identityId: r.identity_id,
    serverId: r.server_id,
    enabled: bool(r.enabled),
    autoStart: bool(r.auto_start),
    networkProfileId: r.network_profile_id,
    desiredState: r.desired_state === 'ONLINE' ? 'ONLINE' : 'OFFLINE',
    schedule: r.schedule_json ? normalizeSchedule(JSON.parse(r.schedule_json)) : null,
    placement: parsePlacement(r.placement),
  };
}

function parsePlacement(v: unknown): Placement {
  if (v === 'local') return 'local';
  const m = /^agent:(\d+)$/.exec(String(v ?? ''));
  return m ? { agentId: Number(m[1]) } : 'default';
}

function mapServerReward(r: Row): ServerRewardState {
  const tri = (v: unknown) => (v === null || v === undefined ? null : v === 1);
  return {
    identityId: r.identity_id,
    serverId: r.server_id,
    stars: r.stars,
    eligible: tri(r.eligible),
    received: tri(r.received),
    waiting: tri(r.waiting),
    discordLinked: tri(r.discord_linked),
    lastChange: r.last_change,
    lastMessage: r.last_message,
  };
}

function uniqueGuard<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.includes('UNIQUE constraint failed')) {
      throw new ConflictError(`${what} is already assigned to another identity (${msg.replace(/^.*failed: /, '')})`);
    }
    throw e;
  }
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;

function validIp(ip: string | null | undefined, field: string): string | null {
  if (ip === null || ip === undefined || ip === '') return null;
  if (!IP_RE.test(ip.trim())) throw new ValidationError(`${field} is not a valid IP address`);
  return ip.trim();
}

export class IdentityRepository {
  constructor(readonly db: DB) {}

  // ------------------------------------------------------------ identities

  listIdentities(): IdentityProfile[] {
    return (this.db.prepare('SELECT * FROM identities ORDER BY number').all() as Row[]).map(mapIdentity);
  }

  getIdentity(id: number): IdentityProfile {
    const r = this.db.prepare('SELECT * FROM identities WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`Identity ${id} not found`);
    return mapIdentity(r);
  }

  nextNumber(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM identities').get() as { n: number };
    return r.n;
  }

  createIdentity(input: { label?: string; number?: number; templateId?: number | null; settings?: Partial<IdentitySettings> }): IdentityProfile {
    const number = input.number ?? this.nextNumber();
    const label = input.label?.trim() || `Identity${String(number).padStart(2, '0')}`;
    const settings = mergeSettings(DEFAULT_SETTINGS, input.settings);
    const ts = nowIso();
    const info = uniqueGuard(
      () =>
        this.db
          .prepare(
            'INSERT INTO identities (number, label, template_id, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(number, label, input.templateId ?? null, JSON.stringify(settings), ts, ts),
      `Identity number ${number}`,
    );
    const id = Number(info.lastInsertRowid);
    this.db.prepare('INSERT INTO reward_states (identity_id) VALUES (?)').run(id);
    return this.getIdentity(id);
  }

  updateIdentity(id: number, patch: { label?: string; settings?: Partial<IdentitySettings>; networkProfileId?: number | null }): IdentityProfile {
    const cur = this.getIdentity(id);
    const settings = patch.settings ? mergeSettings(cur.settings, patch.settings) : cur.settings;
    if (patch.networkProfileId !== undefined && patch.networkProfileId !== null) {
      this.assertNetworkOwned(patch.networkProfileId, id);
    }
    this.db
      .prepare('UPDATE identities SET label = ?, settings_json = ?, network_profile_id = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.label?.trim() || cur.label,
        JSON.stringify(settings),
        patch.networkProfileId === undefined ? cur.networkProfileId : patch.networkProfileId,
        nowIso(),
        id,
      );
    return this.getIdentity(id);
  }

  deleteIdentity(id: number): void {
    this.getIdentity(id);
    this.db.prepare('DELETE FROM identities WHERE id = ?').run(id);
  }

  touch(id: number): void {
    this.db.prepare('UPDATE identities SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  // ------------------------------------------------------------ minecraft

  getMinecraft(identityId: number): MinecraftIdentity | null {
    const r = this.db.prepare('SELECT * FROM minecraft_identities WHERE identity_id = ?').get(identityId) as Row | undefined;
    return r ? mapMinecraft(r) : null;
  }

  upsertMinecraft(identityId: number, input: Partial<Omit<MinecraftIdentity, 'identityId'>>): MinecraftIdentity {
    this.getIdentity(identityId);
    const cur = this.getMinecraft(identityId);
    const merged: MinecraftIdentity = {
      identityId,
      username: input.username ?? cur?.username ?? '',
      uuid: input.uuid !== undefined ? input.uuid : cur?.uuid ?? null,
      authType: input.authType ?? cur?.authType ?? 'microsoft',
      authStatus: input.authStatus ?? cur?.authStatus ?? 'NONE',
      msaAccount: input.msaAccount !== undefined ? input.msaAccount : cur?.msaAccount ?? null,
      credentialRef: input.credentialRef !== undefined ? input.credentialRef : cur?.credentialRef ?? null,
      lastAuthAt: input.lastAuthAt !== undefined ? input.lastAuthAt : cur?.lastAuthAt ?? null,
      lastError: input.lastError !== undefined ? input.lastError : cur?.lastError ?? null,
    };
    if (!merged.username.trim()) throw new ValidationError('Minecraft username is required');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(merged.username)) throw new ValidationError('Minecraft username must be 3-16 chars [A-Za-z0-9_]');
    uniqueGuard(
      () =>
        this.db
          .prepare(
            `INSERT INTO minecraft_identities (identity_id, username, uuid, auth_type, auth_status, msa_account, credential_ref, last_auth_at, last_error)
             VALUES (@identityId, @username, @uuid, @authType, @authStatus, @msaAccount, @credentialRef, @lastAuthAt, @lastError)
             ON CONFLICT(identity_id) DO UPDATE SET username=@username, uuid=@uuid, auth_type=@authType, auth_status=@authStatus,
               msa_account=@msaAccount, credential_ref=@credentialRef, last_auth_at=@lastAuthAt, last_error=@lastError`,
          )
          .run(merged),
      'Minecraft account',
    );
    this.touch(identityId);
    return this.getMinecraft(identityId)!;
  }

  deleteMinecraft(identityId: number): void {
    this.db.prepare('DELETE FROM minecraft_identities WHERE identity_id = ?').run(identityId);
  }

  // ------------------------------------------------------------ mail accounts (mailboxes)

  listMailAccounts(): MailAccount[] {
    return (this.db.prepare('SELECT * FROM mail_accounts ORDER BY id').all() as Row[]).map(mapMailAccount);
  }

  getMailAccount(id: number): MailAccount {
    const r = this.db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`Mailbox ${id} not found`);
    return mapMailAccount(r);
  }

  createMailAccount(input: Omit<MailAccount, 'id' | 'createdAt' | 'credentialRef'> & { credentialRef?: string | null }): MailAccount {
    if (!input.imapHost || !input.username) throw new ValidationError('IMAP host and username are required');
    const info = this.db
      .prepare(
        `INSERT INTO mail_accounts (label, kind, imap_host, imap_port, imap_secure, username, smtp_host, smtp_port, webmail_url,
          exclusive_identity_id, alias_provider_id, credential_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.label || input.username,
        input.kind,
        input.imapHost,
        input.imapPort || 993,
        input.imapSecure ? 1 : 0,
        input.username,
        input.smtpHost ?? null,
        input.smtpPort ?? null,
        input.webmailUrl ?? null,
        input.exclusiveIdentityId ?? null,
        input.aliasProviderId ?? null,
        input.credentialRef ?? null,
        nowIso(),
      );
    return this.getMailAccount(Number(info.lastInsertRowid));
  }

  updateMailAccount(id: number, patch: Partial<Omit<MailAccount, 'id' | 'createdAt'>>): MailAccount {
    const cur = this.getMailAccount(id);
    const m = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE mail_accounts SET label=?, kind=?, imap_host=?, imap_port=?, imap_secure=?, username=?, smtp_host=?, smtp_port=?,
          webmail_url=?, exclusive_identity_id=?, alias_provider_id=?, credential_ref=? WHERE id=?`,
      )
      .run(m.label, m.kind, m.imapHost, m.imapPort, m.imapSecure ? 1 : 0, m.username, m.smtpHost, m.smtpPort, m.webmailUrl,
        m.exclusiveIdentityId, m.aliasProviderId, m.credentialRef, id);
    return this.getMailAccount(id);
  }

  deleteMailAccount(id: number): void {
    this.db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ mail identities

  getMailIdentity(identityId: number): MailIdentity | null {
    const r = this.db.prepare('SELECT * FROM mail_identities WHERE identity_id = ?').get(identityId) as Row | undefined;
    return r ? mapMailIdentity(r) : null;
  }

  listMailIdentitiesForAccount(mailAccountId: number): MailIdentity[] {
    return (this.db.prepare('SELECT * FROM mail_identities WHERE mail_account_id = ?').all(mailAccountId) as Row[]).map(mapMailIdentity);
  }

  assignMail(identityId: number, input: { mailAccountId: number; address: string; isAlias?: boolean }): MailIdentity {
    this.getIdentity(identityId);
    const account = this.getMailAccount(input.mailAccountId);
    if (account.exclusiveIdentityId !== null && account.exclusiveIdentityId !== identityId) {
      throw new IsolationError(`Mailbox ${account.label} is exclusive to another identity`);
    }
    const address = input.address.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new ValidationError('Invalid e-mail address');
    uniqueGuard(
      () =>
        this.db
          .prepare(
            `INSERT INTO mail_identities (identity_id, mail_account_id, address, is_alias) VALUES (?, ?, ?, ?)
             ON CONFLICT(identity_id) DO UPDATE SET mail_account_id=excluded.mail_account_id, address=excluded.address,
               is_alias=excluded.is_alias, access_status='UNKNOWN', unread_count=0, last_checked_at=NULL, last_error=NULL`,
          )
          .run(identityId, account.id, address, input.isAlias ? 1 : 0),
      `Mail address ${address}`,
    );
    this.touch(identityId);
    return this.getMailIdentity(identityId)!;
  }

  updateMailStatus(identityId: number, patch: { accessStatus: MailIdentity['accessStatus']; unreadCount?: number; lastError?: string | null }): void {
    this.db
      .prepare(
        'UPDATE mail_identities SET access_status = ?, unread_count = COALESCE(?, unread_count), last_error = ?, last_checked_at = ? WHERE identity_id = ?',
      )
      .run(patch.accessStatus, patch.unreadCount ?? null, patch.lastError ?? null, nowIso(), identityId);
  }

  unassignMail(identityId: number): void {
    this.db.prepare('DELETE FROM mail_identities WHERE identity_id = ?').run(identityId);
  }

  // ------------------------------------------------------------ discord

  // ------------------------------------------------------------------ account library

  private toAccount(r: any): Account {
    return { id: r.id, kind: r.kind, label: r.label, email: r.email, username: r.username, partition: r.partition, ready: !!r.ready, identityId: r.identity_id, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  listAccounts(kind?: AccountKind): Account[] {
    const rows = kind ? this.db.prepare('SELECT * FROM accounts WHERE kind = ? ORDER BY id').all(kind) : this.db.prepare('SELECT * FROM accounts ORDER BY kind, id').all();
    return rows.map((r) => this.toAccount(r));
  }

  getAccount(id: number): Account {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!r) throw new NotFoundError(`Account ${id} not found`);
    return this.toAccount(r);
  }

  accountOf(identityId: number, kind: AccountKind): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE identity_id = ? AND kind = ?').get(identityId, kind);
    return r ? this.toAccount(r) : null;
  }

  accountByEmail(kind: AccountKind, email: string): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE kind = ? AND email = ?').get(kind, email);
    return r ? this.toAccount(r) : null;
  }

  accountByPartition(partition: string): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE partition = ?').get(partition);
    return r ? this.toAccount(r) : null;
  }

  createAccount(input: { kind: AccountKind; label?: string; email?: string | null; username?: string | null; partition: string; ready?: boolean }): Account {
    const ts = nowIso();
    const r = this.db
      .prepare('INSERT INTO accounts (kind, label, email, username, partition, ready, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.kind, input.label ?? '', input.email ?? null, input.username ?? null, input.partition, input.ready ? 1 : 0, ts, ts);
    return this.getAccount(Number(r.lastInsertRowid));
  }

  updateAccount(id: number, patch: Partial<Pick<Account, 'label' | 'email' | 'username' | 'ready' | 'identityId'>>): Account {
    const cur = this.getAccount(id);
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE accounts SET label = ?, email = ?, username = ?, ready = ?, identity_id = ?, updated_at = ? WHERE id = ?')
      .run(next.label, next.email, next.username, next.ready ? 1 : 0, next.identityId, nowIso(), id);
    return this.getAccount(id);
  }

  deleteAccount(id: number): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  getDiscord(identityId: number): DiscordIdentity | null {
    const r = this.db.prepare('SELECT * FROM discord_identities WHERE identity_id = ?').get(identityId) as Row | undefined;
    return r ? mapDiscord(r) : null;
  }

  upsertDiscord(identityId: number, input: Partial<Omit<DiscordIdentity, 'identityId'>>): DiscordIdentity {
    this.getIdentity(identityId);
    const cur = this.getDiscord(identityId);
    const pick = <K extends keyof DiscordIdentity>(k: K, d: DiscordIdentity[K]): DiscordIdentity[K] =>
      (input as any)[k] !== undefined ? (input as any)[k] : cur ? cur[k] : d;
    const m: DiscordIdentity = {
      identityId,
      discordUserId: pick('discordUserId', null),
      username: pick('username', null),
      displayName: pick('displayName', null),
      avatar: pick('avatar', null),
      oauthState: pick('oauthState', 'NONE'),
      credentialRef: pick('credentialRef', null),
      linkedToMinecraft: pick('linkedToMinecraft', false),
      linkState: pick('linkState', 'UNKNOWN'),
      lastVerifiedAt: pick('lastVerifiedAt', null),
      lastError: pick('lastError', null),
    };
    uniqueGuard(
      () =>
        this.db
          .prepare(
            `INSERT INTO discord_identities (identity_id, discord_user_id, username, display_name, avatar, oauth_state, credential_ref,
               linked_to_minecraft, link_state, last_verified_at, last_error)
             VALUES (@identityId, @discordUserId, @username, @displayName, @avatar, @oauthState, @credentialRef, @linked, @linkState, @lastVerifiedAt, @lastError)
             ON CONFLICT(identity_id) DO UPDATE SET discord_user_id=@discordUserId, username=@username, display_name=@displayName,
               avatar=@avatar, oauth_state=@oauthState, credential_ref=@credentialRef, linked_to_minecraft=@linked,
               link_state=@linkState, last_verified_at=@lastVerifiedAt, last_error=@lastError`,
          )
          .run({ ...m, linked: m.linkedToMinecraft ? 1 : 0 }),
      'Discord account',
    );
    this.touch(identityId);
    return this.getDiscord(identityId)!;
  }

  /** Finds which identity (if any) owns a Discord user id. */
  findIdentityByDiscordUser(discordUserId: string): number | null {
    const r = this.db.prepare('SELECT identity_id FROM discord_identities WHERE discord_user_id = ?').get(discordUserId) as Row | undefined;
    return r ? r.identity_id : null;
  }

  // ------------------------------------------------------------ network profiles

  listNetworkProfiles(identityId?: number): NetworkProfile[] {
    const rows =
      identityId === undefined
        ? (this.db.prepare('SELECT * FROM network_profiles ORDER BY identity_id, id').all() as Row[])
        : (this.db.prepare('SELECT * FROM network_profiles WHERE identity_id = ? ORDER BY id').all(identityId) as Row[]);
    return rows.map(mapNetwork);
  }

  getNetworkProfile(id: number): NetworkProfile {
    const r = this.db.prepare('SELECT * FROM network_profiles WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`Network profile ${id} not found`);
    return mapNetwork(r);
  }

  /** Returns the profile, but only if it is owned by `identityId`. */
  getNetworkProfileFor(identityId: number, profileId: number): NetworkProfile {
    const p = this.getNetworkProfile(profileId);
    if (p.identityId !== identityId) {
      throw new IsolationError(`Network profile ${profileId} belongs to identity ${p.identityId}, not ${identityId}`);
    }
    return p;
  }

  assertNetworkOwned(profileId: number, identityId: number): void {
    this.getNetworkProfileFor(identityId, profileId);
  }

  createNetworkProfile(
    identityId: number,
    input: Partial<Omit<NetworkProfile, 'id' | 'identityId'>> & { kind: NetworkProfile['kind'] },
  ): NetworkProfile {
    this.getIdentity(identityId);
    const p = this.normalizeNetwork(input);
    const info = this.db
      .prepare(
        `INSERT INTO network_profiles (identity_id, name, kind, local_bind_ip, proxy_host, proxy_port, proxy_username, credential_ref,
          expected_public_ip, exit_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(identityId, p.name ?? 'default', p.kind, p.localBindIp, p.proxyHost, p.proxyPort, p.proxyUsername, p.credentialRef ?? null,
        p.expectedPublicIp, p.exitLabel);
    const profile = this.getNetworkProfile(Number(info.lastInsertRowid));
    const identity = this.getIdentity(identityId);
    if (identity.networkProfileId === null) this.updateIdentity(identityId, { networkProfileId: profile.id });
    return profile;
  }

  private normalizeNetwork<T extends Partial<NetworkProfile>>(input: T): T {
    const out = { ...input };
    if (input.localBindIp !== undefined) out.localBindIp = validIp(input.localBindIp, 'Local bind IP');
    if (input.expectedPublicIp !== undefined) out.expectedPublicIp = validIp(input.expectedPublicIp, 'Expected public IP');
    if (input.kind && !['DIRECT', 'BIND', 'SOCKS5', 'HTTP'].includes(input.kind)) throw new ValidationError('Invalid network kind');
    if ((input.kind === 'SOCKS5' || input.kind === 'HTTP') && (!input.proxyHost || !input.proxyPort)) {
      throw new ValidationError('Proxy host and port are required for proxy profiles');
    }
    if (input.kind === 'BIND' && !out.localBindIp) throw new ValidationError('Local bind IP is required for BIND profiles');
    for (const k of ['localBindIp', 'proxyHost', 'proxyPort', 'proxyUsername', 'expectedPublicIp', 'exitLabel'] as const) {
      if ((out as any)[k] === undefined) (out as any)[k] = null;
    }
    return out;
  }

  updateNetworkProfile(identityId: number, profileId: number, patch: Partial<Omit<NetworkProfile, 'id' | 'identityId'>>): NetworkProfile {
    const cur = this.getNetworkProfileFor(identityId, profileId);
    const m = this.normalizeNetwork({ ...cur, ...patch });
    this.db
      .prepare(
        `UPDATE network_profiles SET name=?, kind=?, local_bind_ip=?, proxy_host=?, proxy_port=?, proxy_username=?, credential_ref=?,
          expected_public_ip=?, exit_label=? WHERE id=?`,
      )
      .run(m.name, m.kind, m.localBindIp, m.proxyHost, m.proxyPort, m.proxyUsername, m.credentialRef, m.expectedPublicIp, m.exitLabel, profileId);
    return this.getNetworkProfile(profileId);
  }

  recordNetworkCheck(profileId: number, result: { actualPublicIp: string | null; status: NetworkProfile['checkStatus']; error?: string | null }): NetworkProfile {
    this.db
      .prepare('UPDATE network_profiles SET actual_public_ip = ?, check_status = ?, last_error = ?, last_checked_at = ? WHERE id = ?')
      .run(result.actualPublicIp, result.status, result.error ?? null, nowIso(), profileId);
    return this.getNetworkProfile(profileId);
  }

  deleteNetworkProfile(identityId: number, profileId: number): void {
    this.getNetworkProfileFor(identityId, profileId);
    this.db.prepare('UPDATE identities SET network_profile_id = NULL WHERE network_profile_id = ?').run(profileId);
    this.db.prepare('DELETE FROM network_profiles WHERE id = ?').run(profileId);
  }

  // ------------------------------------------------------------ servers & assignments

  listServers(): MinecraftServer[] {
    return this.db.prepare('SELECT id, name, host, port, version FROM servers ORDER BY name').all() as MinecraftServer[];
  }

  getServer(id: number): MinecraftServer {
    const r = this.db.prepare('SELECT id, name, host, port, version FROM servers WHERE id = ?').get(id) as MinecraftServer | undefined;
    if (!r) throw new NotFoundError(`Server ${id} not found`);
    return r;
  }

  getServerByName(name: string): MinecraftServer | null {
    return (this.db.prepare('SELECT id, name, host, port, version FROM servers WHERE name = ? COLLATE NOCASE').get(name) as MinecraftServer) ?? null;
  }

  upsertServer(input: { id?: number; name: string; host: string; port?: number; version?: string | null }): MinecraftServer {
    if (!input.name?.trim() || !input.host?.trim()) throw new ValidationError('Server name and host are required');
    if (input.id) {
      this.db.prepare('UPDATE servers SET name=?, host=?, port=?, version=? WHERE id=?').run(input.name, input.host, input.port ?? 25565, input.version ?? null, input.id);
      return this.getServer(input.id);
    }
    const info = uniqueGuard(
      () => this.db.prepare('INSERT INTO servers (name, host, port, version) VALUES (?, ?, ?, ?)').run(input.name.trim(), input.host.trim(), input.port ?? 25565, input.version ?? null),
      `Server ${input.name}`,
    );
    return this.getServer(Number(info.lastInsertRowid));
  }

  deleteServer(id: number): void {
    this.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  }

  listAssignments(identityId?: number): ServerAssignment[] {
    const rows =
      identityId === undefined
        ? (this.db.prepare('SELECT * FROM server_assignments ORDER BY identity_id, id').all() as Row[])
        : (this.db.prepare('SELECT * FROM server_assignments WHERE identity_id = ? ORDER BY id').all(identityId) as Row[]);
    return rows.map(mapAssignment);
  }

  getAssignment(identityId: number, serverId: number): ServerAssignment | null {
    const r = this.db.prepare('SELECT * FROM server_assignments WHERE identity_id = ? AND server_id = ?').get(identityId, serverId) as Row | undefined;
    return r ? mapAssignment(r) : null;
  }

  assignServer(
    identityId: number,
    input: { serverId: number; enabled?: boolean; autoStart?: boolean; networkProfileId?: number | null; desiredState?: DesiredState },
  ): ServerAssignment {
    this.getIdentity(identityId);
    this.getServer(input.serverId);
    if (input.networkProfileId) this.assertNetworkOwned(input.networkProfileId, identityId);
    const cur = this.getAssignment(identityId, input.serverId);
    const desired = input.desiredState ?? cur?.desiredState ?? (input.autoStart ? 'ONLINE' : 'OFFLINE');
    this.db
      .prepare(
        `INSERT INTO server_assignments (identity_id, server_id, enabled, auto_start, network_profile_id, desired_state) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(identity_id, server_id) DO UPDATE SET enabled=excluded.enabled, auto_start=excluded.auto_start,
           network_profile_id=excluded.network_profile_id, desired_state=excluded.desired_state`,
      )
      .run(identityId, input.serverId, input.enabled === false ? 0 : 1, input.autoStart ? 1 : 0, input.networkProfileId ?? null, desired);
    this.touch(identityId);
    return this.getAssignment(identityId, input.serverId)!;
  }

  setDesiredState(identityId: number, serverId: number, desired: DesiredState): ServerAssignment {
    const a = this.getAssignment(identityId, serverId);
    if (!a) throw new ValidationError('Identity is not assigned to this server');
    this.db.prepare('UPDATE server_assignments SET desired_state = ? WHERE id = ?').run(desired, a.id);
    return this.getAssignment(identityId, serverId)!;
  }

  setSchedule(identityId: number, serverId: number, schedule: WeekSchedule | null): ServerAssignment {
    const a = this.getAssignment(identityId, serverId);
    if (!a) throw new ValidationError('Identity is not assigned to this server');
    this.db.prepare('UPDATE server_assignments SET schedule_json = ? WHERE id = ?').run(schedule ? JSON.stringify(normalizeSchedule(schedule)) : null, a.id);
    this.touch(identityId);
    return this.getAssignment(identityId, serverId)!;
  }

  /** Where the session of this identity on this server runs (overrides the identity's "Run on"). */
  setPlacement(identityId: number, serverId: number, placement: Placement): ServerAssignment {
    const a = this.getAssignment(identityId, serverId);
    if (!a) throw new ValidationError('Identity is not assigned to this server');
    const v = placement === 'default' ? null : placement === 'local' ? 'local' : `agent:${Math.trunc(placement.agentId)}`;
    if (v && v !== 'local' && !(placement as { agentId: number }).agentId) throw new ValidationError('Invalid agent');
    this.db.prepare('UPDATE server_assignments SET placement = ? WHERE id = ?').run(v, a.id);
    this.touch(identityId);
    return this.getAssignment(identityId, serverId)!;
  }

  unassignServer(identityId: number, serverId: number): void {
    this.db.prepare('DELETE FROM server_assignments WHERE identity_id = ? AND server_id = ?').run(identityId, serverId);
  }

  // ------------------------------------------------------------ rewards

  getRewards(identityId: number): RewardState {
    const r = this.db.prepare('SELECT * FROM reward_states WHERE identity_id = ?').get(identityId) as Row | undefined;
    if (!r) return { identityId, stars: 0, eligible: false, lastUpdate: null };
    return { identityId, stars: r.stars, eligible: bool(r.eligible), lastUpdate: r.last_update };
  }

  setRewards(identityId: number, patch: { stars?: number; eligible?: boolean }, reason: string): RewardState {
    const cur = this.getRewards(identityId);
    const stars = patch.stars ?? cur.stars;
    const eligible = patch.eligible ?? cur.eligible;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO reward_states (identity_id, stars, eligible, last_update) VALUES (?, ?, ?, ?)
         ON CONFLICT(identity_id) DO UPDATE SET stars=excluded.stars, eligible=excluded.eligible, last_update=excluded.last_update`,
      )
      .run(identityId, stars, eligible ? 1 : 0, ts);
    if (stars !== cur.stars) this.addRewardHistory(identityId, null, 'stars', stars - cur.stars, stars, reason);
    if (eligible !== cur.eligible) this.addRewardHistory(identityId, null, 'eligible', 0, stars, `${reason}: ${eligible ? 'eligible' : 'not eligible'}`);
    return this.getRewards(identityId);
  }

  addRewardHistory(identityId: number, serverId: number | null, kind: RewardHistoryEntry['kind'], delta: number, stars: number, reason: string): void {
    this.db
      .prepare('INSERT INTO reward_history (identity_id, server_id, ts, kind, delta, stars, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(identityId, serverId, nowIso(), kind, delta, stars, reason.slice(0, 300));
  }

  /** True once the star balance of this identity × server came from the scoreboard. */
  hasScoreboardHistory(identityId: number, serverId: number): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM reward_history WHERE identity_id = ? AND server_id = ? AND kind IN ('stars', 'sync') AND reason LIKE 'scoreboard:%' LIMIT 1")
      .get(identityId, serverId);
  }

  /**
   * Stars gained (and spent) over time, from the per-server history: calibrations ('sync') and manual
   * corrections do not count. `since` limits the rows read (ISO time).
   */
  starHistory(since: string): Array<{ identityId: number; serverId: number; ts: string; delta: number }> {
    return this.db
      .prepare(
        `SELECT identity_id AS identityId, server_id AS serverId, ts, delta FROM reward_history
         WHERE kind = 'stars' AND server_id IS NOT NULL AND reason <> 'manual' AND delta <> 0 AND ts >= ? ORDER BY ts`,
      )
      .all(since) as any[];
  }

  rewardHistory(identityId: number, limit = 50, serverId?: number): RewardHistoryEntry[] {
    const where = serverId === undefined ? '' : ' AND server_id = ?';
    const params: unknown[] = serverId === undefined ? [identityId, limit] : [identityId, serverId, limit];
    return this.db
      .prepare(
        `SELECT id, identity_id AS identityId, server_id AS serverId, ts, kind, delta, stars, reason FROM reward_history
         WHERE identity_id = ?${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params) as RewardHistoryEntry[];
  }

  listServerRewards(identityId?: number): ServerRewardState[] {
    const rows =
      identityId === undefined
        ? (this.db.prepare('SELECT * FROM reward_server_states').all() as Row[])
        : (this.db.prepare('SELECT * FROM reward_server_states WHERE identity_id = ?').all(identityId) as Row[]);
    return rows.map(mapServerReward);
  }

  getServerReward(identityId: number, serverId: number): ServerRewardState {
    const r = this.db.prepare('SELECT * FROM reward_server_states WHERE identity_id = ? AND server_id = ?').get(identityId, serverId) as Row | undefined;
    return r
      ? mapServerReward(r)
      : { identityId, serverId, stars: 0, eligible: null, received: null, waiting: null, discordLinked: null, lastChange: null, lastMessage: null };
  }

  saveServerReward(state: ServerRewardState): void {
    const b = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    this.db
      .prepare(
        `INSERT INTO reward_server_states (identity_id, server_id, stars, eligible, received, waiting, discord_linked, last_change, last_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(identity_id, server_id) DO UPDATE SET stars=excluded.stars, eligible=excluded.eligible, received=excluded.received,
           waiting=excluded.waiting, discord_linked=excluded.discord_linked, last_change=excluded.last_change, last_message=excluded.last_message`,
      )
      .run(state.identityId, state.serverId, state.stars, b(state.eligible), b(state.received), b(state.waiting), b(state.discordLinked), state.lastChange, state.lastMessage);
  }

  // ------------------------------------------------------------ session & chat logs

  addSessionEvent(identityId: number, serverId: number, sessionId: string, kind: string, detail = ''): void {
    this.db
      .prepare('INSERT INTO session_events (ts, identity_id, server_id, session_id, kind, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nowIso(), identityId, serverId, sessionId, kind, detail.slice(0, 500));
  }

  sessionEvents(filter: { sessionId?: string; identityId?: number; limit?: number }): Array<{ id: number; ts: string; identityId: number; serverId: number; sessionId: string; kind: string; detail: string }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.identityId !== undefined) {
      where.push('identity_id = ?');
      params.push(filter.identityId);
    }
    params.push(Math.min(filter.limit ?? 200, 2000));
    return this.db
      .prepare(
        `SELECT id, ts, identity_id AS identityId, server_id AS serverId, session_id AS sessionId, kind, detail FROM session_events
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params) as any[];
  }

  insertChat(lines: Array<{ ts: string; sessionId: string; identityId: number; serverId: number; text: string }>): void {
    if (!lines.length) return;
    const stmt = this.db.prepare('INSERT INTO chat_log (ts, session_id, identity_id, server_id, text) VALUES (?, ?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const l of lines) stmt.run(l.ts, l.sessionId, l.identityId, l.serverId, l.text);
    })();
  }

  chatLog(filter: { sessionId?: string; identityId?: number; serverId?: number; q?: string; before?: number; limit?: number }): Array<{ id: number; ts: string; sessionId: string; identityId: number; serverId: number; text: string }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.identityId !== undefined) {
      where.push('identity_id = ?');
      params.push(filter.identityId);
    }
    if (filter.serverId !== undefined) {
      where.push('server_id = ?');
      params.push(filter.serverId);
    }
    if (filter.q) {
      where.push('text LIKE ?');
      params.push(`%${filter.q}%`);
    }
    if (filter.before) {
      where.push('id < ?');
      params.push(filter.before);
    }
    params.push(Math.min(filter.limit ?? 200, 2000));
    const rows = this.db
      .prepare(
        `SELECT id, ts, session_id AS sessionId, identity_id AS identityId, server_id AS serverId, text FROM chat_log
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params) as any[];
    return rows.reverse();
  }

  /** Keeps the logs bounded (called periodically). */
  pruneLogs(keepChatPerSession = 2000, keepEventsDays = 30): void {
    this.db
      .prepare(
        `DELETE FROM chat_log WHERE id IN (
           SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn FROM chat_log) WHERE rn > ?)`,
      )
      .run(keepChatPerSession);
    this.db.prepare("DELETE FROM session_events WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)").run(`-${keepEventsDays} days`);
  }

  // ------------------------------------------------------------ templates

  listTemplates(): IdentityTemplate[] {
    return (this.db.prepare('SELECT * FROM templates ORDER BY name').all() as Row[]).map((r) => ({ id: r.id, name: r.name, config: JSON.parse(r.config_json) }));
  }

  getTemplate(id: number): IdentityTemplate {
    const r = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`Template ${id} not found`);
    return { id: r.id, name: r.name, config: JSON.parse(r.config_json) };
  }

  saveTemplate(input: { id?: number; name: string; config: IdentityTemplateConfig }): IdentityTemplate {
    if (!input.name?.trim()) throw new ValidationError('Template name is required');
    const json = JSON.stringify(input.config);
    if (/vault:\/\//.test(json)) throw new ValidationError('Templates must not contain credential references');
    if (input.id) {
      this.db.prepare('UPDATE templates SET name = ?, config_json = ? WHERE id = ?').run(input.name.trim(), json, input.id);
      return this.getTemplate(input.id);
    }
    const info = uniqueGuard(() => this.db.prepare('INSERT INTO templates (name, config_json) VALUES (?, ?)').run(input.name.trim(), json), `Template ${input.name}`);
    return this.getTemplate(Number(info.lastInsertRowid));
  }

  deleteTemplate(id: number): void {
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ app settings

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as Row | undefined;
    return r ? r.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
