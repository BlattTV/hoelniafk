import Database from 'better-sqlite3';

export type DB = Database.Database;

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
];

export function openDatabase(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    db.transaction(() => {
      db.exec(sql);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    })();
    version++;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
