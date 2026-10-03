/**
 * Settings sync between PCs: the synchronized part of this suite as one snapshot, and the merge of
 * a snapshot from another PC into this one.
 *
 *   snapshot = { v, servers, templates, mailAccounts, identities, proxies, accounts, macros }
 *              each { <syncId>: entity }  – entities reference each other by syncId, never by the
 *              local row ids (they differ per PC); secrets of an entity travel inside it
 *
 * Merge (three-way, per entity, with the hashes of the last snapshot both PCs agreed on = base):
 *   only here            → kept (and sent along) – unless the other PC deleted it since the base
 *                          and it was not changed here
 *   only there           → created here – unless it was deleted here since the base (and not
 *                          changed there)
 *   changed on one side  → that side's version
 *   changed on both      → this PC's version (it is sent right after)
 * The very first sync (no base) only ever adds: nothing on this PC is removed or overwritten.
 *
 * Not synchronized: logs, chat, mail headers, session states, check results (IPs, latency, last
 * errors), the browser profiles of the Microsoft/Discord windows and everything about this PC
 * (backend sign-in, updates, game client paths).
 */
import crypto from 'node:crypto';
import type { DB } from '../core/db.js';
import type { SecretStore } from '../vault/vault.js';

export const ENTITY_KINDS = ['servers', 'templates', 'mailAccounts', 'identities', 'proxies', 'accounts', 'macros'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export type Snapshot = { v: 1 } & Record<EntityKind, Record<string, any>>;
/** Per entity: the hash of each field as both PCs last agreed on (field-wise three-way merge). */
export type BaseHashes = Partial<Record<EntityKind, Record<string, Record<string, string>>>>;

const TABLE: Record<EntityKind, string> = {
  servers: 'servers',
  templates: 'templates',
  mailAccounts: 'mail_accounts',
  identities: 'identities',
  proxies: 'proxies',
  accounts: 'accounts',
  macros: 'macros',
};

const newSyncId = () => crypto.randomBytes(12).toString('base64url');
const json = (v: unknown): any => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return null;
  }
};

/** Canonical JSON (sorted keys) – the same entity gives the same hash on every PC. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object)
    .filter((k) => (v as any)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
    .join(',')}}`;
}
export const entityHash = (e: unknown) => crypto.createHash('sha256').update(canonical(e)).digest('base64url');

/** Hash of every field of an entity (a change of the stars does not hide a new label from another PC). */
export function fieldHashes(e: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.keys(e).filter((k) => e[k] !== undefined).sort().map((k) => [k, entityHash(e[k])]));
}

const sameFields = (a: Record<string, string>, b: Record<string, string> | undefined) => !!b && canonical(a) === canonical(b);

export function hashesOf(s: Snapshot): BaseHashes {
  const out: BaseHashes = {};
  for (const k of ENTITY_KINDS) out[k] = Object.fromEntries(Object.entries(s[k] ?? {}).map(([id, e]) => [id, fieldHashes(e)]));
  return out;
}

export function emptySnapshot(): Snapshot {
  return { v: 1, servers: {}, templates: {}, mailAccounts: {}, identities: {}, proxies: {}, accounts: {}, macros: {} };
}

/** Secrets under a vault prefix as { relativePath: value }. */
async function secretsUnder(store: SecretStore, prefix: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ref of (await store.list(prefix)).sort()) {
    const v = await store.get(ref);
    if (v !== null) out[ref.slice(prefix.length)] = v;
  }
  return out;
}

async function replaceSecrets(store: SecretStore, prefix: string, secrets: Record<string, string> | undefined): Promise<void> {
  const want = secrets ?? {};
  for (const ref of await store.list(prefix)) if (!(ref.slice(prefix.length) in want)) await store.delete(ref);
  for (const [p, v] of Object.entries(want)) {
    if (!/^[a-z0-9._/@-]{0,200}$/i.test(p) || p.includes('..')) continue;
    if ((await store.get(prefix + p)) !== v) await store.set(prefix + p, v);
  }
}

export class SnapshotIO {
  constructor(
    private readonly db: DB,
    private readonly store: SecretStore,
    private readonly hooks: {
      /** Deletes an identity like the suite does (sessions, vault, library accounts back to the library). */
      deleteIdentity: (identityId: number) => Promise<void>;
    },
  ) {}

  // ------------------------------------------------------------------ ids

  /** Gives every synchronized row a sync id (new rows get theirs on the next export). */
  private ensureSyncIds(): void {
    for (const table of [...Object.values(TABLE), 'network_profiles']) {
      const rows = this.db.prepare(`SELECT id FROM ${table} WHERE sync_id IS NULL`).all() as Array<{ id: number }>;
      for (const r of rows) this.db.prepare(`UPDATE ${table} SET sync_id = ? WHERE id = ?`).run(newSyncId(), r.id);
    }
  }

  private sidOf(table: string, id: number | null | undefined): string | null {
    if (id === null || id === undefined) return null;
    return ((this.db.prepare(`SELECT sync_id FROM ${table} WHERE id = ?`).get(id) as any)?.sync_id as string) ?? null;
  }

  private idOf(table: string, sid: string | null | undefined): number | null {
    if (!sid) return null;
    return ((this.db.prepare(`SELECT id FROM ${table} WHERE sync_id = ?`).get(sid) as any)?.id as number) ?? null;
  }

  // ------------------------------------------------------------------ export

  async export(): Promise<Snapshot> {
    this.ensureSyncIds();
    const s = emptySnapshot();
    for (const r of this.db.prepare('SELECT * FROM servers').all() as any[]) s.servers[r.sync_id] = { name: r.name, host: r.host, port: r.port, version: r.version ?? null };
    for (const r of this.db.prepare('SELECT * FROM templates').all() as any[]) s.templates[r.sync_id] = { name: r.name, config: json(r.config_json) };
    for (const r of this.db.prepare('SELECT * FROM mail_accounts').all() as any[]) {
      s.mailAccounts[r.sync_id] = {
        label: r.label, kind: r.kind, imapHost: r.imap_host, imapPort: r.imap_port, imapSecure: !!r.imap_secure, username: r.username,
        smtpHost: r.smtp_host ?? null, smtpPort: r.smtp_port ?? null, webmailUrl: r.webmail_url ?? null,
        exclusiveIdentity: this.sidOf('identities', r.exclusive_identity_id), createdAt: r.created_at,
        secret: r.credential_ref ? await this.store.get(r.credential_ref) : null,
      };
    }
    for (const r of this.db.prepare('SELECT * FROM identities').all() as any[]) s.identities[r.sync_id] = await this.exportIdentity(r);
    for (const r of this.db.prepare('SELECT * FROM proxies').all() as any[]) {
      s.proxies[r.sync_id] = {
        kind: r.kind, host: r.host, port: r.port, username: r.username ?? null, label: r.label ?? null, expectedIp: r.expected_ip ?? null, createdAt: r.created_at,
        identity: this.sidOf('identities', r.identity_id), networkProfile: this.sidOf('network_profiles', r.network_profile_id),
        secret: r.credential_ref ? await this.store.get(r.credential_ref) : null,
      };
    }
    for (const r of this.db.prepare('SELECT * FROM accounts').all() as any[]) {
      s.accounts[r.sync_id] = {
        kind: r.kind, label: r.label, email: r.email ?? null, username: r.username ?? null, ready: !!r.ready, createdAt: r.created_at,
        identity: this.sidOf('identities', r.identity_id), secrets: await secretsUnder(this.store, `vault://app/accounts/${r.id}/`),
      };
    }
    for (const r of this.db.prepare('SELECT * FROM macros').all() as any[]) {
      const ids = (list: unknown, table: string) => (Array.isArray(list) ? list.map((id) => this.sidOf(table, Number(id))).filter((x): x is string => !!x).sort() : null);
      s.macros[r.sync_id] = {
        name: r.name, enabled: !!r.enabled, trigger: json(r.trigger_json), blocks: json(r.blocks_json), humanize: !!r.humanize, createdAt: r.created_at,
        identities: ids(json(r.identity_ids), 'identities'), servers: ids(json(r.server_ids), 'servers'),
      };
    }
    return s;
  }

  private async exportIdentity(r: any): Promise<any> {
    const id = r.id as number;
    const profiles = (this.db.prepare('SELECT * FROM network_profiles WHERE identity_id = ?').all(id) as any[])
      .map((p) => ({
        sid: p.sync_id, name: p.name, kind: p.kind, localBindIp: p.local_bind_ip ?? null, proxyHost: p.proxy_host ?? null, proxyPort: p.proxy_port ?? null,
        proxyUsername: p.proxy_username ?? null, expectedPublicIp: p.expected_public_ip ?? null, exitLabel: p.exit_label ?? null,
      }))
      .sort((a, b) => a.sid.localeCompare(b.sid));
    const mc = this.db.prepare('SELECT * FROM minecraft_identities WHERE identity_id = ?').get(id) as any;
    const dc = this.db.prepare('SELECT * FROM discord_identities WHERE identity_id = ?').get(id) as any;
    const mail = this.db.prepare('SELECT * FROM mail_identities WHERE identity_id = ?').get(id) as any;
    const rw = this.db.prepare('SELECT * FROM reward_states WHERE identity_id = ?').get(id) as any;
    const assignments = (this.db.prepare('SELECT * FROM server_assignments WHERE identity_id = ?').all(id) as any[])
      .map((a) => ({
        server: this.sidOf('servers', a.server_id), enabled: !!a.enabled, autoStart: !!a.auto_start, desired: a.desired_state,
        schedule: json(a.schedule_json), placement: a.placement ?? null, networkProfile: this.sidOf('network_profiles', a.network_profile_id),
      }))
      .filter((a) => a.server)
      .sort((a, b) => a.server!.localeCompare(b.server!));
    // secrets of the identity; network/<local profile id> → network/@<profile sync id>
    const raw = await secretsUnder(this.store, `vault://identity/${id}/`);
    const secrets: Record<string, string> = {};
    for (const [p, v] of Object.entries(raw)) {
      const m = /^network\/(\d+)$/.exec(p);
      if (m) {
        const sid = this.sidOf('network_profiles', Number(m[1]));
        if (sid) secrets[`network/@${sid}`] = v;
      } else secrets[p] = v;
    }
    return {
      number: r.number, label: r.label, template: this.sidOf('templates', r.template_id), settings: json(r.settings_json), createdAt: r.created_at,
      networkProfile: this.sidOf('network_profiles', r.network_profile_id), profiles,
      minecraft: mc ? { username: mc.username, uuid: mc.uuid ?? null, authType: mc.auth_type, authStatus: mc.auth_status, msaAccount: mc.msa_account ?? null, hasCredential: !!mc.credential_ref } : null,
      discord: dc ? { discordUserId: dc.discord_user_id ?? null, username: dc.username ?? null, displayName: dc.display_name ?? null, avatar: dc.avatar ?? null, oauthState: dc.oauth_state, linked: !!dc.linked_to_minecraft, linkState: dc.link_state, hasCredential: !!dc.credential_ref } : null,
      mail: mail ? { account: this.sidOf('mail_accounts', mail.mail_account_id), address: mail.address, isAlias: !!mail.is_alias } : null,
      rewards: rw ? { stars: rw.stars, eligible: !!rw.eligible, lastUpdate: rw.last_update ?? null } : null,
      assignments,
      secrets,
    };
  }

  // ------------------------------------------------------------------ merge

  /**
   * Merges `remote` into this PC (see the file comment). Returns what happened per kind and the
   * entities that could not be applied (e.g. the same Minecraft account already used by another
   * identity here) – those are left as they are on this PC.
   */
  async merge(remote: Snapshot, base: BaseHashes): Promise<{ created: number; updated: number; deleted: number; problems: string[] }> {
    const local = await this.export();
    // rows the other PC knows (or knew) under their own id are never merged by name
    this.known = new Set(ENTITY_KINDS.flatMap((k) => [...Object.keys(remote[k] ?? {}), ...Object.keys(base[k] ?? {})]));
    const out = { created: 0, updated: 0, deleted: 0, problems: [] as string[] };
    const plan: Array<{ kind: EntityKind; sid: string; op: 'create' | 'update' | 'delete'; entity?: any }> = [];
    for (const kind of ENTITY_KINDS) {
      const L = local[kind] ?? {};
      const R = remote[kind] ?? {};
      const B = base[kind] ?? {};
      for (const sid of new Set([...Object.keys(L), ...Object.keys(R)])) {
        const l = L[sid];
        const r = R[sid];
        const b = B[sid] && typeof B[sid] === 'object' ? B[sid] : undefined;
        const lf = l === undefined ? null : fieldHashes(l);
        const rf = r === undefined ? null : fieldHashes(r);
        if (lf && rf && sameFields(lf, rf)) continue;
        if (!lf) {
          // deleted here since the base and unchanged there → stays deleted (the other PC follows)
          if (sameFields(rf!, b)) continue;
          plan.push({ kind, sid, op: 'create', entity: r });
        } else if (!rf) {
          // deleted there since the base and unchanged here → delete here
          if (sameFields(lf, b)) plan.push({ kind, sid, op: 'delete' });
        } else if (b) {
          // field by field: what changed only there is taken over, what changed here stays
          const merged: any = { ...l };
          let changed = false;
          for (const f of new Set([...Object.keys(lf), ...Object.keys(rf)])) {
            if (lf[f] === rf[f] || lf[f] !== b[f]) continue;
            if (r[f] === undefined) delete merged[f];
            else merged[f] = r[f];
            changed = true;
          }
          if (changed) plan.push({ kind, sid, op: 'update', entity: merged });
        }
        // no base (first sync of an entity both PCs have): this PC's version wins and is sent along
      }
    }
    // creates/updates in dependency order, deletes in reverse order
    for (const kind of ENTITY_KINDS) {
      for (const p of plan.filter((x) => x.kind === kind && x.op !== 'delete')) {
        try {
          if (await this.apply(kind, p.sid, p.entity)) out[p.op === 'create' ? 'created' : 'updated']++;
        } catch (e) {
          out.problems.push(`${kind} ${describe(kind, p.entity)}: ${(e as Error).message}`);
        }
      }
    }
    for (const kind of [...ENTITY_KINDS].reverse()) {
      for (const p of plan.filter((x) => x.kind === kind && x.op === 'delete')) {
        try {
          await this.remove(kind, p.sid);
          out.deleted++;
        } catch (e) {
          out.problems.push(`${kind} ${describe(kind, local[kind][p.sid])}: ${(e as Error).message}`);
        }
      }
    }
    return out;
  }

  private async remove(kind: EntityKind, sid: string): Promise<void> {
    const id = this.idOf(TABLE[kind], sid);
    if (id === null) return;
    if (kind === 'identities') return this.hooks.deleteIdentity(id);
    const row = this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as any;
    this.db.prepare(`DELETE FROM ${TABLE[kind]} WHERE id = ?`).run(id);
    if (row?.credential_ref) await this.store.delete(row.credential_ref);
    if (kind === 'accounts') await this.store.deletePrefix(`vault://app/accounts/${id}/`);
  }

  /** Creates or updates one entity from the other PC. Returns false when nothing was applied. */
  private async apply(kind: EntityKind, sid: string, e: any): Promise<boolean> {
    if (!e || typeof e !== 'object') return false;
    const now = new Date().toISOString();
    const db = this.db;
    switch (kind) {
      case 'servers': {
        const id = this.idOf('servers', sid) ?? this.adopt('servers', 'name = ?', [e.name], sid);
        if (id === null) db.prepare('INSERT INTO servers (name, host, port, version, sync_id) VALUES (?, ?, ?, ?, ?)').run(this.freeName('servers', e.name), e.host, e.port, e.version ?? null, sid);
        else db.prepare('UPDATE servers SET name = ?, host = ?, port = ?, version = ? WHERE id = ?').run(this.freeName('servers', e.name, id), e.host, e.port, e.version ?? null, id);
        return true;
      }
      case 'templates': {
        const id = this.idOf('templates', sid) ?? this.adopt('templates', 'name = ?', [e.name], sid);
        if (id === null) db.prepare('INSERT INTO templates (name, config_json, sync_id) VALUES (?, ?, ?)').run(this.freeName('templates', e.name), JSON.stringify(e.config ?? {}), sid);
        else db.prepare('UPDATE templates SET name = ?, config_json = ? WHERE id = ?').run(this.freeName('templates', e.name, id), JSON.stringify(e.config ?? {}), id);
        return true;
      }
      case 'mailAccounts': {
        let id = this.idOf('mail_accounts', sid);
        const vals = [e.label, e.kind, e.imapHost, e.imapPort, e.imapSecure ? 1 : 0, e.username, e.smtpHost, e.smtpPort, e.webmailUrl, this.idOf('identities', e.exclusiveIdentity)];
        if (id === null) id = db.prepare('INSERT INTO mail_accounts (label, kind, imap_host, imap_port, imap_secure, username, smtp_host, smtp_port, webmail_url, exclusive_identity_id, created_at, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, e.createdAt ?? now, sid).lastInsertRowid;
        else db.prepare('UPDATE mail_accounts SET label = ?, kind = ?, imap_host = ?, imap_port = ?, imap_secure = ?, username = ?, smtp_host = ?, smtp_port = ?, webmail_url = ?, exclusive_identity_id = ? WHERE id = ?').run(...vals, id);
        const ref = `vault://mailbox/${id}`;
        if (e.secret) await this.store.set(ref, e.secret);
        else await this.store.delete(ref);
        db.prepare('UPDATE mail_accounts SET credential_ref = ? WHERE id = ?').run(e.secret ? ref : null, id);
        return true;
      }
      case 'identities':
        return this.applyIdentity(sid, e);
      case 'proxies': {
        let id = this.idOf('proxies', sid) ?? this.adopt('proxies', 'kind = ? AND host = ? AND port = ? AND username IS ?', [e.kind, e.host, e.port, e.username ?? null], sid);
        const vals = [e.kind, e.host, e.port, e.username ?? null, e.label ?? null, this.idOf('identities', e.identity), this.idOf('network_profiles', e.networkProfile)];
        if (id === null) id = db.prepare('INSERT INTO proxies (kind, host, port, username, label, identity_id, network_profile_id, created_at, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, e.createdAt ?? now, sid).lastInsertRowid;
        else db.prepare('UPDATE proxies SET kind = ?, host = ?, port = ?, username = ?, label = ?, identity_id = ?, network_profile_id = ? WHERE id = ?').run(...vals, id);
        const ref = `vault://app/proxy/${id}`;
        if (e.secret) await this.store.set(ref, e.secret);
        else await this.store.delete(ref);
        db.prepare('UPDATE proxies SET credential_ref = ?, expected_ip = ? WHERE id = ?').run(e.secret ? ref : null, e.expectedIp ?? null, id);
        return true;
      }
      case 'accounts': {
        let id = this.idOf('accounts', sid) ?? (e.email ? this.adopt('accounts', 'kind = ? AND email = ?', [e.kind, e.email], sid) : null);
        let identityId = this.idOf('identities', e.identity);
        // one Microsoft / Discord account per identity: an identity here that already has another one keeps it
        if (identityId !== null && db.prepare('SELECT 1 FROM accounts WHERE kind = ? AND identity_id = ? AND id IS NOT ?').get(e.kind, identityId, id)) identityId = null;
        if (id === null) {
          // the browser profile (window login) belongs to this PC: a new account gets its own
          const partition = `persist:hoelni-${e.kind === 'microsoft' ? 'ms' : 'discord'}-acc-${crypto.randomBytes(6).toString('hex')}`;
          id = db.prepare('INSERT INTO accounts (kind, label, email, username, partition, ready, identity_id, created_at, updated_at, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(e.kind, e.label ?? '', e.email ?? null, e.username ?? null, partition, e.ready ? 1 : 0, identityId, e.createdAt ?? now, now, sid).lastInsertRowid;
          // its window (browser profile) is new on this PC: one sign-in here is still needed
          if (e.ready || identityId !== null) db.prepare("INSERT INTO app_settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run(`login.pending.${id}`);
        } else db.prepare('UPDATE accounts SET kind = ?, label = ?, email = ?, username = ?, ready = ?, identity_id = ?, updated_at = ? WHERE id = ?').run(e.kind, e.label ?? '', e.email ?? null, e.username ?? null, e.ready ? 1 : 0, identityId, now, id);
        await replaceSecrets(this.store, `vault://app/accounts/${id}/`, e.secrets);
        return true;
      }
      case 'macros': {
        const ids = (list: unknown, table: string) => (Array.isArray(list) ? JSON.stringify(list.map((s) => this.idOf(table, String(s))).filter((x) => x !== null)) : null);
        const vals = [e.name, e.enabled ? 1 : 0, JSON.stringify(e.trigger), JSON.stringify(e.blocks), e.humanize ? 1 : 0, ids(e.identities, 'identities'), ids(e.servers, 'servers')];
        const id = this.idOf('macros', sid);
        if (id === null) db.prepare('INSERT INTO macros (name, enabled, trigger_json, blocks_json, humanize, identity_ids, server_ids, created_at, updated_at, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, e.createdAt ?? now, now, sid);
        else db.prepare('UPDATE macros SET name = ?, enabled = ?, trigger_json = ?, blocks_json = ?, humanize = ?, identity_ids = ?, server_ids = ?, updated_at = ? WHERE id = ?').run(...vals, now, id);
        return true;
      }
    }
  }

  private async applyIdentity(sid: string, e: any): Promise<boolean> {
    const db = this.db;
    const now = new Date().toISOString();
    let id = this.idOf('identities', sid);
    // Minecraft account already used by another identity here (set up on both PCs on their own):
    // the identities stay separate – this one is not taken over (reported)
    const clash = (col: string, v: unknown) => (v ? (db.prepare(`SELECT identity_id FROM minecraft_identities WHERE ${col} = ? AND identity_id IS NOT ?`).get(v, id) as any)?.identity_id : undefined);
    const other = clash('msa_account', e.minecraft?.msaAccount) ?? clash('uuid', e.minecraft?.uuid);
    if (other !== undefined) throw new Error(`the Minecraft account is already used by identity #${String((db.prepare('SELECT number FROM identities WHERE id = ?').get(other) as any)?.number ?? other).padStart(2, '0')} on this PC`);
    const tx = db.transaction(() => {
      const templateId = this.idOf('templates', e.template);
      if (id === null) {
        const number = this.freeNumber(e.number);
        id = db.prepare('INSERT INTO identities (number, label, template_id, settings_json, created_at, updated_at, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(number, e.label, templateId, JSON.stringify(e.settings ?? {}), e.createdAt ?? now, now, sid).lastInsertRowid;
      } else {
        // a number taken by another identity here: this one keeps its number (no ping-pong between PCs)
        const taken = db.prepare('SELECT 1 FROM identities WHERE number = ? AND id IS NOT ?').get(e.number, id);
        db.prepare('UPDATE identities SET number = CASE WHEN ? THEN number ELSE ? END, label = ?, template_id = ?, settings_json = ?, updated_at = ? WHERE id = ?').run(taken ? 1 : 0, e.number, e.label, templateId, JSON.stringify(e.settings ?? {}), now, id);
      }
      const iid = id as number;
      // network profiles (by sync id)
      const keep = new Set<string>((e.profiles ?? []).map((p: any) => p.sid));
      for (const p of db.prepare('SELECT id, sync_id FROM network_profiles WHERE identity_id = ?').all(iid) as any[]) if (!keep.has(p.sync_id)) db.prepare('DELETE FROM network_profiles WHERE id = ?').run(p.id);
      for (const p of e.profiles ?? []) {
        const pid = this.idOf('network_profiles', p.sid);
        const vals = [p.name, p.kind, p.localBindIp, p.proxyHost, p.proxyPort, p.proxyUsername, p.expectedPublicIp, p.exitLabel];
        if (pid === null) db.prepare('INSERT INTO network_profiles (identity_id, name, kind, local_bind_ip, proxy_host, proxy_port, proxy_username, expected_public_ip, exit_label, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(iid, ...vals, p.sid);
        else db.prepare('UPDATE network_profiles SET identity_id = ?, name = ?, kind = ?, local_bind_ip = ?, proxy_host = ?, proxy_port = ?, proxy_username = ?, expected_public_ip = ?, exit_label = ? WHERE id = ?').run(iid, ...vals, pid);
      }
      for (const p of db.prepare('SELECT id FROM network_profiles WHERE identity_id = ?').all(iid) as any[]) db.prepare('UPDATE network_profiles SET credential_ref = ? WHERE id = ?').run(`vault://identity/${iid}/network/${p.id}`, p.id);
      db.prepare('UPDATE identities SET network_profile_id = ? WHERE id = ?').run(this.idOf('network_profiles', e.networkProfile), iid);
      // Minecraft / Discord / rewards
      if (e.minecraft) {
        const m = e.minecraft;
        db.prepare(
          `INSERT INTO minecraft_identities (identity_id, username, uuid, auth_type, auth_status, msa_account, credential_ref) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET username = excluded.username, uuid = excluded.uuid, auth_type = excluded.auth_type, auth_status = excluded.auth_status, msa_account = excluded.msa_account, credential_ref = excluded.credential_ref`,
        ).run(iid, m.username, m.uuid, m.authType, m.authStatus ?? 'NONE', m.msaAccount, m.hasCredential ? `vault://identity/${iid}/minecraft` : null);
      } else db.prepare('DELETE FROM minecraft_identities WHERE identity_id = ?').run(iid);
      if (e.discord) {
        const d = e.discord;
        db.prepare(
          `INSERT INTO discord_identities (identity_id, discord_user_id, username, display_name, avatar, oauth_state, credential_ref, linked_to_minecraft, link_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET discord_user_id = excluded.discord_user_id, username = excluded.username, display_name = excluded.display_name, avatar = excluded.avatar, oauth_state = excluded.oauth_state, credential_ref = excluded.credential_ref, linked_to_minecraft = excluded.linked_to_minecraft, link_state = excluded.link_state`,
        ).run(iid, d.discordUserId, d.username, d.displayName, d.avatar, d.oauthState, d.hasCredential ? `vault://identity/${iid}/discord` : null, d.linked ? 1 : 0, d.linkState);
      } else db.prepare('DELETE FROM discord_identities WHERE identity_id = ?').run(iid);
      if (e.rewards) {
        db.prepare('INSERT INTO reward_states (identity_id, stars, eligible, last_update) VALUES (?, ?, ?, ?) ON CONFLICT(identity_id) DO UPDATE SET stars = excluded.stars, eligible = excluded.eligible, last_update = excluded.last_update').run(iid, e.rewards.stars, e.rewards.eligible ? 1 : 0, e.rewards.lastUpdate);
      }
      // mail
      const mailAccount = this.idOf('mail_accounts', e.mail?.account);
      if (e.mail && mailAccount !== null) {
        db.prepare(
          `INSERT INTO mail_identities (identity_id, mail_account_id, address, is_alias) VALUES (?, ?, ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET mail_account_id = excluded.mail_account_id, address = excluded.address, is_alias = excluded.is_alias`,
        ).run(iid, mailAccount, e.mail.address, e.mail.isAlias ? 1 : 0);
      } else if (!e.mail) db.prepare('DELETE FROM mail_identities WHERE identity_id = ?').run(iid);
      // server assignments (by server sync id)
      const servers = new Set<number>();
      for (const a of e.assignments ?? []) {
        const serverId = this.idOf('servers', a.server);
        if (serverId === null) continue;
        servers.add(serverId);
        db.prepare(
          `INSERT INTO server_assignments (identity_id, server_id, enabled, auto_start, network_profile_id, desired_state, schedule_json, placement) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(identity_id, server_id) DO UPDATE SET enabled = excluded.enabled, auto_start = excluded.auto_start, network_profile_id = excluded.network_profile_id, desired_state = excluded.desired_state, schedule_json = excluded.schedule_json, placement = excluded.placement`,
        ).run(iid, serverId, a.enabled ? 1 : 0, a.autoStart ? 1 : 0, this.idOf('network_profiles', a.networkProfile), a.desired === 'ONLINE' ? 'ONLINE' : 'OFFLINE', a.schedule ? JSON.stringify(a.schedule) : null, a.placement ?? null);
      }
      for (const a of db.prepare('SELECT server_id FROM server_assignments WHERE identity_id = ?').all(iid) as any[]) if (!servers.has(a.server_id)) db.prepare('DELETE FROM server_assignments WHERE identity_id = ? AND server_id = ?').run(iid, a.server_id);
    });
    tx();
    // secrets (network/@<profile sync id> → network/<local profile id>)
    const iid = id as unknown as number;
    const secrets: Record<string, string> = {};
    for (const [p, v] of Object.entries((e.secrets ?? {}) as Record<string, string>)) {
      const m = /^network\/@(.+)$/.exec(p);
      if (m) {
        const pid = this.idOf('network_profiles', m[1]);
        if (pid !== null) secrets[`network/${pid}`] = v;
      } else secrets[p] = v;
    }
    await replaceSecrets(this.store, `vault://identity/${iid}/`, secrets);
    return true;
  }

  private known = new Set<string>();

  /** A row with the same natural key that the other PC does not know yet becomes the same entity. */
  private adopt(table: string, where: string, params: unknown[], sid: string): number | null {
    const row = this.db.prepare(`SELECT id, sync_id FROM ${table} WHERE ${where}`).get(...params) as any;
    if (!row || (row.sync_id && this.known.has(row.sync_id))) return null;
    this.db.prepare(`UPDATE ${table} SET sync_id = ? WHERE id = ?`).run(sid, row.id);
    return row.id;
  }

  private freeName(table: string, name: string, selfId: number | null = null): string {
    let n = name;
    for (let i = 2; this.db.prepare(`SELECT 1 FROM ${table} WHERE name = ? AND id IS NOT ?`).get(n, selfId); i++) n = `${name} (${i})`;
    return n;
  }

  private freeNumber(want: number): number {
    if (!this.db.prepare('SELECT 1 FROM identities WHERE number = ?').get(want)) return want;
    return ((this.db.prepare('SELECT MAX(number) AS n FROM identities').get() as any)?.n ?? 0) + 1;
  }
}

function describe(kind: EntityKind, e: any): string {
  if (!e) return '?';
  if (kind === 'identities') return `#${String(e.number).padStart(2, '0')} ${e.label ?? ''}`.trim();
  return String(e.name ?? e.label ?? e.email ?? e.host ?? '');
}
