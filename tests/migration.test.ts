import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB, migrate, openDatabase, SCHEMA_VERSION, schemaVersion } from '../src/core/db.js';
import { IdentityRepository } from '../src/identity/repository.js';

function v1Database(file: string) {
  const db = new DB(file);
  db.pragma('foreign_keys = ON');
  migrate(db, 1);
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO identities (number, label, settings_json, created_at, updated_at) VALUES (7, 'Identity07', '{}', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO servers (name, host, port) VALUES ('SMP', 'mc.example.com', 25565), ('Test', 'test.example.com', 25565)").run();
  db.prepare('INSERT INTO server_assignments (identity_id, server_id, enabled, auto_start) VALUES (1, 1, 1, 1), (1, 2, 1, 0)').run();
  db.prepare('INSERT INTO reward_states (identity_id, stars, eligible) VALUES (1, 24, 1)').run();
  db.prepare("INSERT INTO reward_history (identity_id, ts, delta, stars, reason) VALUES (1, ?, 24, 24, 'old')").run(ts);
  return db;
}

describe('database migrations', () => {
  it('upgrades a v1 database without data loss', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-mig-'));
    const file = path.join(dir, 'hoelni.db');
    v1Database(file).close();

    const db = openDatabase(file);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    const repo = new IdentityRepository(db);
    const [smp, test] = repo.listAssignments(1).sort((a, b) => a.serverId - b.serverId);
    // auto_start=1 becomes desired ONLINE
    expect(smp.desiredState).toBe('ONLINE');
    expect(test.desiredState).toBe('OFFLINE');
    expect(repo.getRewards(1)).toMatchObject({ stars: 24, eligible: true });
    expect(repo.rewardHistory(1)[0]).toMatchObject({ kind: 'stars', serverId: null, delta: 24 });
    expect(repo.getIdentity(1).settings.networkGuard).toBe('warn'); // new settings get defaults
    // a backup of the pre-migration file is kept
    expect(fs.readdirSync(dir).some((f) => f.startsWith('hoelni.db.pre-v2'))).toBe(true);
    db.close();
  });

  it('is idempotent', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    migrate(db);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('rolls back a failing migration step atomically', () => {
    const db = new DB(':memory:');
    migrate(db, 1);
    db.exec('CREATE TABLE session_events (x INTEGER)'); // collides with v2
    expect(() => migrate(db)).toThrow();
    expect(schemaVersion(db)).toBe(1);
    // v2 column must not exist after the rollback
    const cols = db.prepare('PRAGMA table_info(server_assignments)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'desired_state')).toBe(false);
  });

  it('v8 switches off the anti-AFK head turn (visible since physics is always on), keeps other choices', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-mig8-')), 'hoelni.db');
    const db = new DB(file);
    migrate(db, 7);
    const ts = new Date().toISOString();
    const settings = (afk: object) => JSON.stringify({ autoReconnect: true, afk });
    db.prepare('INSERT INTO identities (number, label, settings_json, created_at, updated_at) VALUES (1, ?, ?, ?, ?), (2, ?, ?, ?, ?)').run(
      'Look', settings({ enabled: true, action: 'look', intervalSec: 45 }), ts, ts,
      'Jump', settings({ enabled: true, action: 'jump', intervalSec: 30 }), ts, ts,
    );
    db.close();
    const repo = new IdentityRepository(openDatabase(file));
    expect(repo.getIdentity(1).settings.afk).toEqual({ enabled: false, action: 'none', intervalSec: 45 });
    expect(repo.getIdentity(1).settings.autoReconnect).toBe(true);
    expect(repo.getIdentity(2).settings.afk).toEqual({ enabled: true, action: 'jump', intervalSec: 30 });
  });
});
