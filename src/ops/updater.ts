/**
 * Updater: talks to the self-hosted update server (update-server/, e.g. in a LXC).
 *
 *   check     GET <url>/api/channels/<channel>/latest → Ed25519 signature verified with the
 *             PINNED key (pinned once in the UI after comparing the fingerprint)
 *   download  GET <url>/files/<build>/backend-<build>.zip → SHA-256 + size from the signed
 *             manifest → extracted to <root>/.update/staging-<build> → pending.json
 *   install   the suite exits with code 75; the supervisor applies the staged files before
 *             starting it again and rolls back automatically if the new version crashes early
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type { IdentityRepository } from '../identity/repository.js';
import { UPDATE_DIR } from './updateApply.js';
import { keyFingerprint, verifyEnvelope, type ReleaseManifest, type SignedEnvelope } from './updateSig.js';

const log = createLogger('updates');

export interface BuildInfo {
  version: string;
  build: number;
  commit: string | null;
  lockHash: string | null;
  source: 'release' | 'checkout';
}

export interface UpdateSettings {
  url: string;
  channel: string;
  publicKey: string | null;
  autoCheck: boolean;
  autoInstall: boolean;
}

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'staged' | 'restarting' | 'error';

export function appRoot(): string {
  // dist/ops/updater.js and src/ops/updater.ts → repository / installation root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function currentBuild(root = appRoot()): BuildInfo {
  const read = (f: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const info = read('build-info.json');
  const pkg = read('package.json') ?? {};
  let lockHash: string | null = null;
  try {
    lockHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
  } catch {
    /* none */
  }
  if (info?.build) return { version: info.version ?? pkg.version, build: Number(info.build), commit: info.commit ?? null, lockHash, source: 'release' };
  return { version: pkg.version ?? '0.0.0', build: 0, commit: null, lockHash, source: 'checkout' };
}

export class Updater {
  state: UpdateState = 'idle';
  error: string | null = null;
  latest: ReleaseManifest | null = null;
  lastCheckAt: string | null = null;
  progress: { done: number; total: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;
  /** Provided by the entry point: graceful shutdown with the "restart for update" exit code. */
  restart: (() => Promise<void>) | null = null;
  /** Blocks automatic installation while a game window is open, etc. */
  autoInstallAllowed: () => boolean = () => true;

  constructor(
    private readonly repo: IdentityRepository,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    readonly root = appRoot(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  settings(): UpdateSettings {
    const g = (k: string) => this.repo.getSetting(`updates.${k}`);
    return {
      url: g('url') ?? '',
      channel: g('channel') ?? 'stable',
      publicKey: g('publicKey'),
      autoCheck: g('autoCheck') !== 'false',
      autoInstall: g('autoInstall') === 'true',
    };
  }

  status() {
    const s = this.settings();
    const current = currentBuild(this.root);
    const read = (f: string) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.root, UPDATE_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    };
    return {
      current,
      settings: { url: s.url, channel: s.channel, keyFingerprint: s.publicKey ? keyFingerprint(s.publicKey) : null, autoCheck: s.autoCheck, autoInstall: s.autoInstall },
      state: this.state,
      error: this.error,
      progress: this.progress,
      lastCheckAt: this.lastCheckAt,
      latest: this.latest,
      available: !!this.latest && this.latest.build > current.build,
      supervised: process.env.HOELNI_SUPERVISED === '1',
      lastApplied: read('applied.json'),
      lastFailed: read('failed.json'),
      pending: read('pending.json'),
      // Downloaded through the suite (sign-in header for the backend, SHA-256 from the signed manifest).
      installerUrl: this.latest?.installer && s.url ? '/api/updates/installer' : null,
    };
  }

  private emit(): void {
    this.bus.emit({ type: 'updates.status', data: this.status() });
  }

  private base(): string {
    const url = this.settings().url.replace(/\/+$/, '');
    if (!url) throw new Error('No update server configured');
    return url;
  }

  /** Extra request headers per URL – the backend's /updates needs this device's sign-in token. */
  authHeaders: (url: string) => Promise<Record<string, string>> = async () => ({});

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: await this.authHeaders(url), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} – ${url}`);
    return (await res.json()) as T;
  }

  /** Desktop installer of the latest verified release, checked against the signed SHA-256. */
  async downloadInstaller(): Promise<{ file: string; content: Buffer }> {
    const m = this.latest;
    if (!m?.installer) throw new Error('The latest release has no desktop installer');
    const url = `${this.base()}/files/${m.build}/${encodeURIComponent(m.installer.file)}`;
    const res = await this.fetchImpl(url, { headers: await this.authHeaders(url), signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const content = Buffer.from(await res.arrayBuffer());
    if (content.length !== m.installer.size || crypto.createHash('sha256').update(content).digest('hex') !== m.installer.sha256) {
      throw new Error('Installer does not match the signed release (size/SHA-256) – not offered');
    }
    return { file: m.installer.file, content };
  }

  /** Reads the server's public key so the user can compare the fingerprint before pinning it. */
  async probe(url: string): Promise<{ publicKey: string; fingerprint: string }> {
    const clean = normalizeUrl(url);
    const r = await this.getJson<{ publicKey: string }>(`${clean}/api/public-key`);
    if (typeof r.publicKey !== 'string') throw new Error('Not a Hoelni update server');
    return { publicKey: r.publicKey, fingerprint: keyFingerprint(r.publicKey) };
  }

  configure(patch: Partial<UpdateSettings>): void {
    const cur = this.settings();
    if (patch.url !== undefined) {
      const url = patch.url ? normalizeUrl(patch.url) : '';
      if (url !== cur.url) {
        this.repo.setSetting('updates.url', url);
        // A different server needs its key to be confirmed again.
        if (patch.publicKey === undefined) this.repo.setSetting('updates.publicKey', '');
        this.latest = null;
      }
    }
    if (patch.publicKey !== undefined) this.repo.setSetting('updates.publicKey', patch.publicKey ?? '');
    if (patch.channel !== undefined) {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(patch.channel)) throw new Error('Invalid channel');
      this.repo.setSetting('updates.channel', patch.channel);
      this.latest = null;
    }
    if (patch.autoCheck !== undefined) this.repo.setSetting('updates.autoCheck', String(!!patch.autoCheck));
    if (patch.autoInstall !== undefined) this.repo.setSetting('updates.autoInstall', String(!!patch.autoInstall));
    const s = this.settings();
    this.audit.record(null, 'Update settings changed', { url: s.url, channel: s.channel, key: s.publicKey ? keyFingerprint(s.publicKey) : 'none', autoInstall: s.autoInstall });
    this.emit();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) return Promise.reject(new Error('Another update operation is running'));
    const p = fn().finally(() => (this.busy = null));
    this.busy = p;
    return p;
  }

  check(): Promise<ReturnType<Updater['status']>> {
    return this.exclusive(async () => {
      const s = this.settings();
      this.state = 'checking';
      this.error = null;
      this.emit();
      try {
        if (!s.publicKey) throw new Error('The update server key is not confirmed yet (Settings → Updates)');
        const env = await this.getJson<SignedEnvelope>(`${this.base()}/api/channels/${s.channel}/latest`);
        if (!env?.manifest || !verifyEnvelope(env, s.publicKey)) throw new Error('Release signature is INVALID – update refused (wrong server or manipulated release)');
        if (env.manifest.product !== 'hoelni-client-suite' || env.manifest.schema !== 1) throw new Error('Release is not for this product');
        this.latest = env.manifest;
        this.lastCheckAt = new Date().toISOString();
        this.state = fs.existsSync(path.join(this.root, UPDATE_DIR, 'pending.json')) ? 'staged' : 'idle';
      } catch (e) {
        this.state = 'error';
        this.error = (e as Error).message;
        log.warn(`Update check failed: ${this.error}`);
      }
      this.emit();
      return this.status();
    });
  }

  /** Downloads, verifies and extracts the latest release into the staging area. */
  download(): Promise<ReturnType<Updater['status']>> {
    return this.exclusive(async () => {
      const m = this.latest;
      const current = currentBuild(this.root);
      if (!m) throw new Error('Check for updates first');
      if (m.build <= current.build) throw new Error('Already up to date');
      this.state = 'downloading';
      this.progress = { done: 0, total: m.backend.size };
      this.error = null;
      this.emit();
      const dir = path.join(this.root, UPDATE_DIR);
      const staging = path.join(dir, `staging-${m.build}`);
      try {
        const fileUrl = `${this.base()}/files/${m.build}/${encodeURIComponent(m.backend.file)}`;
        const res = await this.fetchImpl(fileUrl, { headers: await this.authHeaders(fileUrl), signal: AbortSignal.timeout(10 * 60_000) });
        if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of res.body as any as AsyncIterable<Uint8Array>) {
          size += c.length;
          if (size > m.backend.size) throw new Error('Download larger than announced');
          chunks.push(Buffer.from(c));
          this.progress = { done: size, total: m.backend.size };
        }
        const data = Buffer.concat(chunks);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        if (data.length !== m.backend.size || hash !== m.backend.sha256) throw new Error('Checksum mismatch – download refused');
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        const entries = unzipSync(new Uint8Array(data));
        for (const [name, bytes] of Object.entries(entries)) {
          if (name.endsWith('/')) continue;
          const target = path.resolve(staging, name);
          if (!target.startsWith(staging + path.sep)) throw new Error(`Unsafe path in bundle: ${name}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, bytes);
        }
        const info = JSON.parse(fs.readFileSync(path.join(staging, 'build-info.json'), 'utf8'));
        if (Number(info.build) !== m.build) throw new Error('Bundle does not match the signed manifest');
        const lockChanged = (m.lockHash ?? null) !== current.lockHash;
        for (const f of fs.readdirSync(dir)) if (f.startsWith('staging-') && f !== `staging-${m.build}`) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ build: m.build, version: m.version, dir: `staging-${m.build}`, lockChanged, fromBuild: current.build, stagedAt: new Date().toISOString() }, null, 2));
        this.state = 'staged';
        this.progress = null;
        log.info(`Update ${m.version} downloaded and verified – applied on the next restart${lockChanged ? ' (dependencies change)' : ''}`);
      } catch (e) {
        fs.rmSync(staging, { recursive: true, force: true });
        this.state = 'error';
        this.error = (e as Error).message;
        this.progress = null;
      }
      this.emit();
      if (this.state === 'error') throw new Error(this.error!);
      return this.status();
    });
  }

  /** Downloads if needed, then restarts through the supervisor, which applies the update. */
  async install(): Promise<ReturnType<Updater['status']>> {
    if (!fs.existsSync(path.join(this.root, UPDATE_DIR, 'pending.json'))) {
      if (!this.latest) await this.check();
      await this.download();
    }
    const st = this.status();
    this.audit.record(null, 'Update installation started', { from: st.current.version, to: st.pending?.version ?? '' });
    if (!st.supervised || !this.restart) {
      this.error = 'Downloaded – restart the suite (it is not running under the supervisor) to apply the update';
      this.emit();
      return this.status();
    }
    this.state = 'restarting';
    this.emit();
    setTimeout(() => void this.restart?.(), 300);
    return this.status();
  }

  /** Asks the supervisor to restore the previous version on the next start. */
  async rollback(): Promise<ReturnType<Updater['status']>> {
    const dir = path.join(this.root, UPDATE_DIR);
    if (!fs.existsSync(path.join(dir, 'applied.json'))) throw new Error('No applied update to roll back');
    fs.writeFileSync(path.join(dir, 'rollback.json'), JSON.stringify({ at: new Date().toISOString() }));
    fs.rmSync(path.join(dir, 'pending.json'), { force: true });
    this.audit.record(null, 'Update rollback requested');
    if (this.status().supervised && this.restart) {
      this.state = 'restarting';
      setTimeout(() => void this.restart?.(), 300);
    }
    this.emit();
    return this.status();
  }

  start(intervalHours = 6): void {
    const tick = async () => {
      const s = this.settings();
      if (!s.url || !s.publicKey || !s.autoCheck) return;
      const st = await this.check();
      if (st.available && s.autoInstall && this.autoInstallAllowed()) await this.install().catch((e) => log.warn(`Automatic update failed: ${(e as Error).message}`));
    };
    setTimeout(() => void tick(), 60_000).unref?.();
    this.timer = setInterval(() => void tick(), intervalHours * 3600_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export function normalizeUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, '');
  const url = new URL(/^https?:\/\//.test(s) ? s : `http://${s}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Update URL must be http(s)');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}
