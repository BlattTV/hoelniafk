/**
 * Accounts of the Hoelni backend.
 *   admin – manages accounts (web UI / CLI) and may change the backend address in the apps
 *   user  – signs in with the manager (AFK suite) and with any number of agents
 * Devices: every signed-in manager or agent gets its own token (only the SHA-256 is stored),
 * visible and revocable by the admin.
 */
import crypto from 'node:crypto';
import { nowIso } from './db.mjs';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const USERNAME = /^[A-Za-z0-9._-]{3,40}$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [kind, n, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { ...SCRYPT, N: Number(n) });
  return crypto.timingSafeEqual(got, want);
}

const mapUser = (r) => r && { id: r.id, username: r.username, role: r.role, disabled: !!r.disabled, createdAt: r.created_at, lastLoginAt: r.last_login_at };
const mapDevice = (r) =>
  r && {
    id: r.id, userId: r.user_id, username: r.username, kind: r.kind, name: r.name, info: r.info_json ? JSON.parse(r.info_json) : {},
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, lastIp: r.last_ip, revoked: !!r.revoked,
  };

export class Accounts {
  constructor(db) {
    this.db = db;
    this.failures = new Map();
  }

  audit(actor, action, detail = '', ip = null) {
    this.db.prepare('INSERT INTO audit (ts, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(nowIso(), actor ?? null, action, String(detail).slice(0, 500), ip);
  }

  auditLog(limit = 200) {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---------------------------------------------------------------- users
  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY role, username').all().map(mapUser);
  }

  getUser(id) {
    const u = mapUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)));
    if (!u) throw new HttpError(404, 'User not found');
    return u;
  }

  createUser(username, password, role = 'user') {
    if (!USERNAME.test(String(username))) throw new HttpError(400, 'Username: 3–40 characters (letters, digits, . _ -)');
    if (!['admin', 'user'].includes(role)) throw new HttpError(400, 'Role must be admin or user');
    if (String(password ?? '').length < 10) throw new HttpError(400, 'Password must have at least 10 characters');
    try {
      const r = this.db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(username, hashPassword(password), role, nowIso());
      return this.getUser(r.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, `User "${username}" already exists`);
      throw e;
    }
  }

  admins() {
    return this.listUsers().filter((u) => u.role === 'admin' && !u.disabled);
  }

  updateUser(id, { password, role, disabled }) {
    const u = this.getUser(id);
    if (password !== undefined) {
      if (String(password).length < 10) throw new HttpError(400, 'Password must have at least 10 characters');
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    }
    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) throw new HttpError(400, 'Role must be admin or user');
      if (u.role === 'admin' && role !== 'admin' && this.admins().length <= 1) throw new HttpError(400, 'The last admin must stay admin');
      this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
    }
    if (disabled !== undefined) {
      if (disabled && u.role === 'admin' && this.admins().length <= 1) throw new HttpError(400, 'The last admin cannot be disabled');
      this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, u.id);
      if (disabled) this.db.prepare('UPDATE devices SET revoked = 1 WHERE user_id = ?').run(u.id);
    }
    if (password !== undefined) this.db.prepare('UPDATE devices SET revoked = 1 WHERE user_id = ?').run(u.id);
    return this.getUser(u.id);
  }

  deleteUser(id) {
    const u = this.getUser(id);
    if (u.role === 'admin' && this.admins().length <= 1) throw new HttpError(400, 'The last admin cannot be deleted');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    return u;
  }

  authenticate(username, password, ip = '') {
    const key = `${String(username).toLowerCase()}|${ip}`;
    const f = this.failures.get(key);
    if (f && f.count >= 10 && f.until > Date.now()) throw new HttpError(429, 'Too many failed sign-ins – try again in a few minutes');
    const r = this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
    const ok = r && !r.disabled && verifyPassword(password ?? '', r.password_hash);
    if (!ok) {
      if (!r) verifyPassword('x', hashPassword('y'));
      this.failures.set(key, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 10 * 60_000 });
      throw new HttpError(401, 'Wrong username or password');
    }
    this.failures.delete(key);
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), r.id);
    return mapUser(r);
  }

  // ---------------------------------------------------------------- devices (manager / agent logins)
  registerDevice(user, kind, name, info = {}, ip = null) {
    if (!['manager', 'agent', 'remote'].includes(kind)) throw new HttpError(400, 'client must be manager, agent or remote');
    const token = crypto.randomBytes(32).toString('base64url');
    const clean = String(name ?? '').trim().slice(0, 60) || `${user.username}-${kind}`;
    const r = this.db
      .prepare('INSERT INTO devices (user_id, kind, name, token_hash, info_json, created_at, last_seen_at, last_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, kind, clean, sha256(token), JSON.stringify(info ?? {}), nowIso(), nowIso(), ip);
    return { deviceId: Number(r.lastInsertRowid), token };
  }

  deviceByToken(token) {
    if (!token) return null;
    const r = this.db
      .prepare('SELECT d.*, u.username, u.role, u.disabled FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?')
      .get(sha256(token));
    if (!r || r.revoked || r.disabled) return null;
    return { ...mapDevice(r), role: r.role };
  }

  listDevices(userId) {
    const sql = 'SELECT d.*, u.username FROM devices d JOIN users u ON u.id = d.user_id';
    const rows = userId === undefined ? this.db.prepare(`${sql} ORDER BY d.revoked, u.username, d.kind, d.name`).all() : this.db.prepare(`${sql} WHERE d.user_id = ? ORDER BY d.revoked, d.kind, d.name`).all(userId);
    return rows.map(mapDevice);
  }

  getDevice(id) {
    const d = mapDevice(this.db.prepare('SELECT d.*, u.username FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(Number(id)));
    if (!d) throw new HttpError(404, 'Device not found');
    return d;
  }

  touchDevice(id, ip, info) {
    this.db.prepare('UPDATE devices SET last_seen_at = ?, last_ip = COALESCE(?, last_ip), info_json = COALESCE(?, info_json) WHERE id = ?').run(nowIso(), ip ?? null, info ? JSON.stringify(info) : null, id);
  }

  /** Still allowed to stay connected (not revoked, account not disabled/deleted)? */
  isDeviceActive(id) {
    const r = this.db.prepare('SELECT d.revoked, u.disabled FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(Number(id));
    return !!r && !r.revoked && !r.disabled;
  }

  revokeDevice(id) {
    this.getDevice(id);
    this.db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(Number(id));
  }

  // ---------------------------------------------------------------- settings sync (encrypted blob per account)

  getSync(userId) {
    const r = this.db.prepare('SELECT version, data, updated_at, updated_by FROM sync_blobs WHERE user_id = ?').get(Number(userId));
    return r ? { version: r.version, data: Buffer.from(r.data), updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
  }

  /** Stores a new version – only on top of `expected` (the version the PC merged), else 409. */
  putSync(userId, expected, data, by) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, 'No data');
    if (data.length > SYNC_MAX_BYTES) throw new HttpError(413, `Sync data too large (max ${SYNC_MAX_BYTES / 1024 / 1024} MB)`);
    const cur = this.getSync(userId);
    if ((cur?.version ?? 0) !== Number(expected)) throw new HttpError(409, 'Sync data changed on another PC – merge and try again');
    const version = (cur?.version ?? 0) + 1;
    this.db
      .prepare('INSERT INTO sync_blobs (user_id, version, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
      .run(Number(userId), version, data, nowIso(), by ? String(by).slice(0, 120) : null);
    return { version };
  }
}

export const SYNC_MAX_BYTES = 16 * 1024 * 1024;
