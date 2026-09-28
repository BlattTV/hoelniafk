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
  let v = db.prepare('SELECT version FROM schema_version').get()?.version;
  if (v === undefined) {
    db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    v = 0;
  }
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
    db.exec('COMMIT');
    v++;
  }
  return db;
}

export const nowIso = () => new Date().toISOString();
