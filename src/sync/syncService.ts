/**
 * Settings sync between the suites (PCs) of one backend account.
 *
 *   PC A ──PUT /api/sync (encrypted snapshot, version n+1)──▶ backend ──relay {t:'sync'}──▶ PC B
 *   PC B ──GET /api/sync──▶ merge (snapshot.ts) ──▶ PUT if PC B had changes of its own
 *
 * Encryption: the snapshot (incl. Minecraft logins, proxy and Discord passwords) is encrypted on the
 * PC with a random data key (AES-256-GCM). The data key travels with the snapshot, encrypted with a
 * key derived from the account password (scrypt) – the backend stores only ciphertext and never
 * sees the password-derived key. Each PC keeps the data key in its own vault after the first sign-in.
 * After a password change, the next sign-in on a PC that has the data key re-encrypts it.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { SuiteError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { IdentityRepository } from '../identity/repository.js';
import { requestJson } from '../agent/transport.js';
import type { BackendLink } from '../relay/backendLink.js';
import { refs } from '../vault/refs.js';
import type { Vault } from '../vault/vault.js';
import { canonical, ENTITY_KINDS, hashesOf, type BaseHashes, type Snapshot, type SnapshotIO } from './snapshot.js';

const log = createLogger('sync');
const KEY_REF = refs.app('sync-key');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface Wrap {
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}
interface Blob {
  v: 1;
  wrap: Wrap;
  iv: string;
  tag: string;
  ct: string;
}

const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');

function kek(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password.normalize('NFC'), salt, 32, SCRYPT);
}

export function wrapKey(dataKey: Buffer, password: string): Wrap {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kek(password, salt), iv);
  const ct = Buffer.concat([c.update(dataKey), c.final()]);
  return { salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}

/** The data key – null if the password does not fit. */
export function unwrapKey(w: Wrap, password: string): Buffer | null {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', kek(password, unb64(w.salt)), unb64(w.iv));
    d.setAuthTag(unb64(w.tag));
    return Buffer.concat([d.update(unb64(w.ct)), d.final()]);
  } catch {
    return null;
  }
}

export function seal(snapshot: Snapshot, dataKey: Buffer, wrap: Wrap): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)))), c.final()]);
  const blob: Blob = { v: 1, wrap, iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
  return Buffer.from(JSON.stringify(blob));
}

export function parseBlob(data: Buffer): Blob {
  const b = JSON.parse(data.toString('utf8')) as Blob;
  if (b?.v !== 1 || !b.wrap || !b.ct) throw new Error('Unknown sync data format');
  return b;
}

/** Decrypts a snapshot – null if the data key does not fit. */
export function openBlob(b: Blob, dataKey: Buffer): Snapshot | null {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', dataKey, unb64(b.iv));
    d.setAuthTag(unb64(b.tag));
    const s = JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(unb64(b.ct)), d.final()])).toString('utf8')) as Snapshot;
    for (const k of ENTITY_KINDS) s[k] ??= {};
    return s;
  } catch {
    return null;
  }
}

const snapshotHash = (s: Snapshot) => crypto.createHash('sha256').update(canonical(s)).digest('base64url');

export type SyncState = 'off' | 'needs-password' | 'syncing' | 'ok' | 'error';

export class SyncService {
  state: SyncState = 'off';
  lastError: string | null = null;
  problems: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private lastPullAt = 0;
  private closed = false;

  constructor(
    private readonly io: SnapshotIO,
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly backend: BackendLink,
    private readonly bus: EventBus,
    private readonly audit: AuditLog,
    /** After changes from another PC were applied (sessions / macros follow them). */
    private readonly afterApply: () => void = () => undefined,
    private readonly opts: { intervalMs?: number; pullEveryMs?: number } = {},
  ) {
    // another PC stored new settings → fetch them right away (also before the periodic sync started)
    backend.onSyncChanged = () => this.schedule(true);
  }

  // ------------------------------------------------------------------ state

  status() {
    return {
      state: this.state,
      lastError: this.lastError,
      problems: this.problems,
      version: Number(this.repo.getSetting('sync.version') || 0),
      lastSyncAt: this.repo.getSetting('sync.lastAt') || null,
      account: this.repo.getSetting('sync.user') || null,
    };
  }

  private set(state: SyncState, error: string | null = null): void {
    const changed = state !== this.state || error !== this.lastError;
    this.state = state;
    this.lastError = error;
    if (changed && !this.closed) this.bus.emit({ type: 'sync.status', data: this.status() } as any);
  }

  private async dataKey(): Promise<Buffer | null> {
    const k = await this.vault.store.get(KEY_REF);
    return k ? unb64(k) : null;
  }

  private signedInUser(): string | null {
    return this.backend.status().state === 'signed-out' ? null : this.repo.getSetting('backend.username') || null;
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.schedule(false), this.opts.intervalMs ?? 20_000);
    this.timer.unref?.();
    this.schedule(true);
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Something changed (here or on another PC): sync soon. */
  schedule(pull: boolean): void {
    if (pull) this.lastPullAt = 0;
    void this.syncNow().catch(() => undefined);
  }

  /**
   * Sign-in with the account password (from the sign-in form or "Set up sync"): the data key is
   * taken from the account's sync data, or created for the first PC. A wrong password is refused.
   */
  async setup(username: string, password: string, opts: { verified?: boolean } = {}): Promise<ReturnType<SyncService['status']>> {
    if (!opts.verified) await this.api('POST', { password }).catch((e) => {
      throw new SuiteError((e as { status?: number }).status === 401 ? 'Wrong password' : `Backend: ${(e as Error).message}`, 400);
    });
    const previousUser = this.repo.getSetting('sync.user');
    if (previousUser && previousUser.toLowerCase() !== username.toLowerCase()) {
      // another account on this PC: start fresh (nothing is removed here – it is merged into that account)
      await this.vault.store.delete(KEY_REF);
      for (const k of ['sync.version', 'sync.base', 'sync.lastPushed', 'sync.wrap', 'sync.wrapDirty']) this.repo.setSetting(k, '');
    }
    this.repo.setSetting('sync.user', username);
    const remote = await this.api<{ version: number; data: string | null }>('GET');
    let dk = await this.dataKey();
    if (remote.data) {
      const blob = parseBlob(unb64(remote.data));
      const fromPassword = unwrapKey(blob.wrap, password);
      if (fromPassword) dk = fromPassword;
      else if (dk && openBlob(blob, dk)) {
        // the password changed since the data was stored: re-encrypt the data key with the new one
        this.repo.setSetting('sync.wrap', JSON.stringify(wrapKey(dk, password)));
        this.repo.setSetting('sync.wrapDirty', '1'); // stored with the new key wrap right away
      } else {
        throw new SuiteError('The settings of this account were saved with another password. Sign in once more on a PC that already synchronizes (it re-encrypts them), then here.', 409);
      }
      if (fromPassword) this.repo.setSetting('sync.wrap', JSON.stringify(blob.wrap));
    } else {
      dk ??= crypto.randomBytes(32);
      this.repo.setSetting('sync.wrap', JSON.stringify(wrapKey(dk, password)));
    }
    await this.vault.store.set(KEY_REF, b64(dk!));
    this.audit.record(null, 'Settings sync set up', { account: username });
    this.lastPullAt = 0;
    await this.syncNow();
    return this.status();
  }

  // ------------------------------------------------------------------ the sync

  async syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.once().catch((e) => {
          log.warn(`Sync failed: ${(e as Error).message}`);
          this.set('error', (e as Error).message);
        });
      } while (this.again && !this.closed);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async once(): Promise<void> {
    if (this.closed) return;
    const user = this.signedInUser();
    if (!user) return this.set('off');
    const dk = await this.dataKey();
    const wrapRaw = this.repo.getSetting('sync.wrap');
    if (!dk || !wrapRaw || (this.repo.getSetting('sync.user') || '').toLowerCase() !== user.toLowerCase()) return this.set('needs-password');
    const wrap = JSON.parse(wrapRaw) as Wrap;

    let local = await this.io.export();
    const pullDue = Date.now() - this.lastPullAt > (this.opts.pullEveryMs ?? 5 * 60_000);
    const wrapDirty = this.repo.getSetting('sync.wrapDirty') === '1';
    if (!pullDue && !wrapDirty && snapshotHash(local) === this.repo.getSetting('sync.lastPushed')) return; // nothing new here
    if (this.state !== 'ok') this.set('syncing', this.lastError);

    for (let attempt = 0; attempt < 5; attempt++) {
      const remote = await this.api<{ version: number; data: string | null }>('GET');
      this.lastPullAt = Date.now();
      const known = Number(this.repo.getSetting('sync.version') || 0);
      let remoteSnap: Snapshot | null = null;
      if (remote.data) {
        const blob = parseBlob(unb64(remote.data));
        remoteSnap = openBlob(blob, dk);
        if (!remoteSnap) return this.set('needs-password', 'The sync data was encrypted with another key – enter the account password once');
        if (remote.version !== known) {
          const base = JSON.parse(this.repo.getSetting('sync.base') || '{}') as BaseHashes;
          const r = await this.io.merge(remoteSnap, base);
          this.problems = r.problems.slice(0, 20);
          if (r.created || r.updated || r.deleted) {
            log.info(`Sync: ${r.created} new, ${r.updated} changed, ${r.deleted} removed from another PC`);
            this.audit.record(null, 'Settings synchronized from another PC', { new: r.created, changed: r.updated, removed: r.deleted });
            this.afterApply();
            this.bus.emit({ type: 'identity.changed', identityId: 0 } as any);
            this.bus.emit({ type: 'accounts.changed', data: {} } as any);
          }
          if (r.problems.length) log.warn(`Sync: ${r.problems.join('; ')}`);
          local = await this.io.export();
        }
      }
      const h = snapshotHash(local);
      if (remoteSnap && h === snapshotHash(remoteSnap) && !wrapDirty) {
        // both PCs have the same now
        this.agreed(remote.version, local, h);
        return this.set('ok');
      }
      try {
        const r = await this.api<{ version: number }>('PUT', { expected: remote.version, data: b64(seal(local, dk, wrap)) });
        this.agreed(r.version, local, h);
        this.repo.setSetting('sync.wrapDirty', '');
        return this.set('ok');
      } catch (e) {
        if ((e as { status?: number }).status !== 409) throw e;
        // another PC stored meanwhile: merge that first
      }
    }
    throw new Error('Settings changed on another PC all the time – trying again later');
  }

  private agreed(version: number, s: Snapshot, h: string): void {
    this.repo.setSetting('sync.version', String(version));
    this.repo.setSetting('sync.base', JSON.stringify(hashesOf(s)));
    this.repo.setSetting('sync.lastPushed', h);
    this.repo.setSetting('sync.lastAt', new Date().toISOString());
  }

  private async api<T>(method: 'GET' | 'PUT' | 'POST', body?: unknown): Promise<T> {
    const token = await this.backend.deviceToken();
    if (!token) throw new SuiteError('Not signed in to the backend');
    return requestJson<T>(`${this.backend.url}/api/sync`, method, body, { ...this.backend.transportOptions, timeoutMs: 30_000 }, { Authorization: `Bearer ${token}` });
  }
}
