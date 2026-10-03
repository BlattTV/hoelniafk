/** SQLite (built into Node 22.13+) for accounts and devices. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('manager', 'agent')),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    info_json TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    last_ip TEXT,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT
  );
  `,
  // v2: settings sync between the suites (managers) of one account – an encrypted blob the backend
  // cannot read (key derived from the account password on the PCs), versioned against lost updates
  `
  CREATE TABLE sync_blobs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
  `,
  // v3: the "Hoelni Control" app (phone / browser) signs in as its own kind of device
  `
  CREATE TABLE devices_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('manager', 'agent', 'remote')),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    info_json TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    last_ip TEXT,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO devices_new SELECT id, user_id, kind, name, token_hash, info_json, created_at, last_seen_at, last_ip, revoked FROM devices;
  DROP TABLE devices;
  ALTER TABLE devices_new RENAME TO devices;
  `,
];

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const orig = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/SQLite is an experimental/.test(String(w?.message ?? w)) ? undefined : orig.call(process, w, ...rest));
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = orig;
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  // The service and a CLI command (e.g. the installer's "user list") may open the database at the
  // same time: each step locks first (IMMEDIATE) and reads the version inside the lock, so a
  // migration never runs twice.
  for (;;) {
    db.exec('BEGIN IMMEDIATE');
    let v = db.prepare('SELECT version FROM schema_version').get()?.version;
    if (v === undefined) {
      db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
      v = 0;
    }
    if (v >= MIGRATIONS.length) {
      db.exec('COMMIT');
      break;
    }
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export const nowIso = () => new Date().toISOString();
