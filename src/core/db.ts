import fs from 'node:fs';
import { createRequire } from 'node:module';

/*
 * SQLite through Node's built-in `node:sqlite` – no native add-on to compile, so `npm ci`
 * works on every Windows PC without Visual Studio, and updates never need a rebuild.
 * The small wrapper below offers the subset of the better-sqlite3 API the suite uses.
 */
const require = createRequire(import.meta.url);

type SqlValue = null | number | bigint | string | Uint8Array;
interface RawStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

function loadSqlite(): { DatabaseSync: new (file: string) => RawDatabase } {
  // node:sqlite prints an "experimental" warning on Node 22 – it is stable enough for us; hide that one line.
  const orig = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite is an experimental feature/.test(msg ?? '')) return;
    return (orig as any).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite');
  } catch (e) {
    throw new Error(`This Node.js version has no built-in SQLite (node:sqlite) – install Node.js 22.13 or newer (${(e as Error).message})`);
  } finally {
    process.emitWarning = orig;
  }
}

const toNumber = (v: number | bigint) => (typeof v === 'bigint' ? Number(v) : v);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);

export class Statement {
  private readonly names: Set<string>;
  constructor(private readonly raw: RawStatement, sql: string) {
    this.names = new Set([...sql.matchAll(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  }
  /** Like better-sqlite3: extra keys in a named-parameter object are ignored. */
  private bind(params: unknown[]): SqlValue[] {
    if (params.length === 1 && isPlainObject(params[0])) {
      const o = params[0];
      const picked: Record<string, unknown> = {};
      for (const k of Object.keys(o)) if (this.names.has(k)) picked[k] = o[k];
      return [picked as unknown as SqlValue];
    }
    return params as SqlValue[];
  }
  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.run(...this.bind(params));
    return { changes: toNumber(r.changes), lastInsertRowid: toNumber(r.lastInsertRowid) };
  }
  get(...params: unknown[]): unknown {
    return this.raw.get(...this.bind(params));
  }
  all(...params: unknown[]): unknown[] {
    return this.raw.all(...this.bind(params));
  }
}

export class DB {
  readonly memory: boolean;
  private readonly raw: RawDatabase;
  private depth = 0;

  constructor(readonly name: string) {
    const { DatabaseSync } = loadSqlite();
    this.raw = new DatabaseSync(name);
    this.memory = name === ':memory:';
  }

  exec(sql: string): this {
    this.raw.exec(sql);
    return this;
  }

  prepare(sql: string): Statement {
    return new Statement(this.raw.prepare(sql), sql);
  }

  /** `PRAGMA x` – returns the rows (like better-sqlite3's db.pragma). */
  pragma(source: string): unknown[] {
    return this.raw.prepare(`PRAGMA ${source}`).all();
  }

  /** Wraps fn in a transaction (savepoints when nested); call the returned function to run it. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      const sp = `sp_${this.depth}`;
      this.raw.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn(...args);
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
    };
  }

  /** Consistent online copy of the database into a new file. */
  async backup(file: string): Promise<void> {
    fs.rmSync(file, { force: true });
    this.raw.prepare('VACUUM INTO ?').run(file);
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * SQLite schema. IMPORTANT: no column in this database ever holds a secret.
 * Credentials live in the vault; tables only store `credential_ref` strings
 * such as `vault://identity/7/mail`.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL UNIQUE,
    label TEXT NOT NULL,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    network_profile_id INTEGER,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    config_json TEXT NOT NULL
  );

  CREATE TABLE minecraft_identities (
    identity_id INTEGER PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    uuid TEXT UNIQUE,
    auth_type TEXT NOT NULL,
    auth_status TEXT NOT NULL DEFAULT 'NONE',
    msa_account TEXT UNIQUE,
    credential_ref TEXT,
    last_auth_at TEXT,
    last_error TEXT
  );

  CREATE TABLE alias_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    config_json TEXT NOT NULL,
    credential_ref TEXT
  );

  CREATE TABLE mail_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    imap_secure INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL,
    smtp_host TEXT,
    smtp_port INTEGER,
    webmail_url TEXT,
    exclusive_identity_id INTEGER REFERENCES identities(id) ON DELETE SET NULL,
    alias_provider_id INTEGER REFERENCES alias_providers(id) ON DELETE SET NULL,
    credential_ref TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE mail_identities (
    identity_id INTEGER PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
    mail_account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL UNIQUE COLLATE NOCASE,
    is_alias INTEGER NOT NULL DEFAULT 0,
    access_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_error TEXT
  );

  -- Header cache only. Bodies (and thus verification codes) are fetched on demand, never persisted.
  CREATE TABLE mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mail_account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    message_id TEXT,
    from_addr TEXT,
    from_name TEXT,
    to_json TEXT NOT NULL,
    subject TEXT,
    date TEXT,
    seen INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    identity_id INTEGER REFERENCES identities(id) ON DELETE SET NULL,
    manual_assignment INTEGER NOT NULL DEFAULT 0,
    provider_tag TEXT,
    category TEXT,
    UNIQUE (mail_account_id, uid)
  );
  CREATE INDEX idx_mail_messages_identity ON mail_messages(identity_id, date);

  CREATE TABLE discord_identities (
    identity_id INTEGER PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
    discord_user_id TEXT UNIQUE,
    username TEXT,
    display_name TEXT,
    avatar TEXT,
    oauth_state TEXT NOT NULL DEFAULT 'NONE',
    credential_ref TEXT,
    linked_to_minecraft INTEGER NOT NULL DEFAULT 0,
    link_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    last_verified_at TEXT,
    last_error TEXT
  );

  CREATE TABLE network_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    local_bind_ip TEXT,
    proxy_host TEXT,
    proxy_port INTEGER,
    proxy_username TEXT,
    credential_ref TEXT,
    expected_public_ip TEXT,
    actual_public_ip TEXT,
    exit_label TEXT,
    check_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    last_checked_at TEXT,
    last_error TEXT
  );

  CREATE TABLE servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 25565,
    version TEXT
  );

  CREATE TABLE server_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_start INTEGER NOT NULL DEFAULT 0,
    network_profile_id INTEGER REFERENCES network_profiles(id) ON DELETE SET NULL,
    UNIQUE (identity_id, server_id)
  );

  CREATE TABLE reward_states (
    identity_id INTEGER PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
    stars INTEGER NOT NULL DEFAULT 0,
    eligible INTEGER NOT NULL DEFAULT 0,
    last_update TEXT
  );

  CREATE TABLE reward_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    delta INTEGER NOT NULL,
    stars INTEGER NOT NULL,
    reason TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    identity_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts);

  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: desired-state sessions, session/chat logs, per-server rewards
  `
  ALTER TABLE server_assignments ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'OFFLINE';
  UPDATE server_assignments SET desired_state = 'ONLINE' WHERE auto_start = 1;

  CREATE TABLE session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    identity_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_session_events ON session_events(session_id, id);

  CREATE TABLE chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id TEXT NOT NULL,
    identity_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX idx_chat_log_session ON chat_log(session_id, id);
  CREATE INDEX idx_chat_log_ts ON chat_log(id);

  CREATE TABLE reward_server_states (
    identity_id INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    stars INTEGER NOT NULL DEFAULT 0,
    eligible INTEGER,
    received INTEGER,
    waiting INTEGER,
    discord_linked INTEGER,
    last_change TEXT,
    last_message TEXT,
    PRIMARY KEY (identity_id, server_id)
  );

  ALTER TABLE reward_history ADD COLUMN server_id INTEGER;
  ALTER TABLE reward_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'stars';
  `,
  // v3: weekly online schedules per session
  `
  ALTER TABLE server_assignments ADD COLUMN schedule_json TEXT;
  `,
  // v4: proxy pool
  `
  CREATE TABLE proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('SOCKS5', 'HTTP')),
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT,
    credential_ref TEXT,
    label TEXT,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    exit_ip TEXT,
    latency_ms INTEGER,
    last_checked_at TEXT,
    last_error TEXT,
    identity_id INTEGER REFERENCES identities(id) ON DELETE SET NULL,
    network_profile_id INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (kind, host, port, username)
  );
  `,
  // v5: macro builder
  `
  CREATE TABLE macros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_json TEXT NOT NULL,
    blocks_json TEXT NOT NULL,
    humanize INTEGER NOT NULL DEFAULT 1,
    identity_ids TEXT,
    server_ids TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // v6: account library – Microsoft / Discord accounts on their own, linked to identities by hand.
  // Existing logins become library entries with their previous browser profiles (still signed in).
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('microsoft', 'discord')),
    label TEXT NOT NULL DEFAULT '',
    email TEXT,
    username TEXT,
    partition TEXT NOT NULL UNIQUE,
    ready INTEGER NOT NULL DEFAULT 0,
    identity_id INTEGER REFERENCES identities(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX accounts_identity ON accounts(kind, identity_id) WHERE identity_id IS NOT NULL;
  CREATE UNIQUE INDEX accounts_email ON accounts(kind, email) WHERE email IS NOT NULL;
  INSERT INTO accounts (kind, label, email, username, partition, ready, identity_id, created_at, updated_at)
    SELECT 'microsoft', '', msa_account, CASE WHEN substr(username, 1, 8) = 'Pending_' THEN NULL ELSE username END,
           'persist:hoelni-ms-' || identity_id, CASE WHEN auth_status = 'AUTHENTICATED' THEN 1 ELSE 0 END, identity_id,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM minecraft_identities WHERE auth_type = 'microsoft' AND msa_account IS NOT NULL;
  INSERT INTO accounts (kind, label, email, username, partition, ready, identity_id, created_at, updated_at)
    SELECT 'discord', '', NULL, username, 'persist:hoelni-discord-' || identity_id, 1, identity_id,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM discord_identities WHERE oauth_state = 'CONNECTED';
  `,
  // v7: where a session runs, per server (NULL = like the identity, 'local' = this PC, 'agent:<id>')
  `
  ALTER TABLE server_assignments ADD COLUMN placement TEXT;
  `,
  // v8: the anti-AFK head turn was on by default but never reached the server (physics was off). Now
  // that physics is always on it is visible – switched off where it was set, nobody chose it on purpose.
  `
  UPDATE identities SET settings_json = json_set(settings_json, '$.afk.enabled', json('false'), '$.afk.action', 'none')
    WHERE json_extract(settings_json, '$.afk.action') = 'look';
  UPDATE templates SET config_json = json_set(config_json, '$.settings.afk.enabled', json('false'), '$.settings.afk.action', 'none')
    WHERE json_extract(config_json, '$.settings.afk.action') = 'look';
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file: string): DB {
  const db = new DB(file);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  backupBeforeMigration(db, file);
  migrate(db);
  return db;
}

/** Copies the database file before pending migrations touch an existing database. */
function backupBeforeMigration(db: DB, file: string): void {
  if (file === ':memory:') return;
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  if (!hasTable) return;
  const current = schemaVersion(db);
  if (current === 0 || current >= MIGRATIONS.length) return;
  db.pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(file, `${file}.pre-v${current + 1}.bak`);
}

export function migrate(db: DB, upTo = MIGRATIONS.length): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < upTo) {
    const sql = MIGRATIONS[version];
    db.transaction(() => {
      db.exec(sql);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    })();
    version++;
  }
}

export function schemaVersion(db: DB): number {
  return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
}

export function nowIso(): string {
  return new Date().toISOString();
}
