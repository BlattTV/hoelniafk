/**
 * Updates for the agent (PCs in other households): the same signed releases the suite gets,
 * through the backend's update distribution (<backend>/updates, only for signed-in devices).
 *
 *   key       taken once over the authenticated connection to the backend (https / pinned
 *             certificate) and pinned – a later different key is refused
 *   check     every few hours: signed manifest → Ed25519 signature with the pinned key
 *   download  bundle → size + SHA-256 from the signed manifest → staged (<root>/.update)
 *   install   when nothing runs here (no session, no game window) – at the latest a few hours
 *             later if sessions run all the time (they reconnect within seconds), never while the
 *             game window is open. The agent exits with code 75; the agent app applies the staged
 *             files before starting it again and rolls back if the new version does not start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { appRoot, currentBuild, stageBundle, verifiedManifest } from '../ops/updater.js';
import { keyFingerprint, type ReleaseManifest, type SignedEnvelope } from '../ops/updateSig.js';
import { UPDATE_DIR } from '../ops/updateApply.js';
import { requestBuffer, requestJson, type TransportOptions } from './transport.js';

export interface AgentUpdaterOptions {
  backendUrl: string;
  token: string;
  transport: TransportOptions;
  root?: string;
  channel?: string;
  /** Pinned update key (stored in the agent config). */
  getKey: () => string | null;
  setKey: (key: string) => void;
  /** Nothing runs on this PC right now. */
  isIdle: () => boolean;
  /** The game window is open (never restart then). */
  gameOpen: () => boolean;
  /** Stop cleanly and exit with the "restart for update" code. */
  restart: () => void;
  log?: (msg: string) => void;
  checkEveryMs?: number;
  /** Restart even with sessions running this long after the update was staged. */
  forceAfterMs?: number;
}

export type AgentUpdateState = 'idle' | 'checking' | 'downloading' | 'staged' | 'restarting' | 'error';

export class AgentUpdater {
  state: AgentUpdateState = 'idle';
  error: string | null = null;
  latest: ReleaseManifest | null = null;
  private stagedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  readonly root: string;

  constructor(private readonly o: AgentUpdaterOptions) {
    this.root = o.root ?? appRoot();
    const pending = this.pending();
    if (pending) {
      this.state = 'staged';
      this.stagedAt = Date.parse(pending.stagedAt) || Date.now();
    }
  }

  private get base(): string {
    return `${this.o.backendUrl.replace(/\/+$/, '')}/updates`;
  }

  private get auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.o.token}` };
  }

  private pending(): { build: number; stagedAt: string } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, UPDATE_DIR, 'pending.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  status() {
    const cur = currentBuild(this.root);
    return { build: cur.build, version: cur.version, state: this.state, error: this.error, latest: this.latest ? { build: this.latest.build, version: this.latest.version } : null };
  }

  private async key(): Promise<string> {
    const pinned = this.o.getKey();
    const r = await requestJson<{ publicKey?: string }>(`${this.base}/api/public-key`, 'GET', undefined, this.o.transport, this.auth);
    if (typeof r?.publicKey !== 'string') throw new Error('The backend does not distribute updates');
    if (pinned) {
      if (pinned !== r.publicKey) throw new Error(`The update key of the backend changed (${keyFingerprint(r.publicKey)}) – updates refused until the agent is signed in again`);
      return pinned;
    }
    // First contact: only over a protected connection (https, pinned certificate or this PC).
    const u = new URL(this.o.backendUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !loopback) throw new Error('Updates need an https connection to the backend');
    this.o.setKey(r.publicKey);
    this.o.log?.(`update key pinned: ${keyFingerprint(r.publicKey)}`);
    return r.publicKey;
  }

  /** Checks for and downloads a newer release. Returns true when an update is staged. */
  async check(): Promise<boolean> {
    if (this.busy) return this.state === 'staged';
    this.busy = true;
    try {
      this.state = this.pending() ? 'staged' : 'checking';
      const key = await this.key();
      const env = await requestJson<SignedEnvelope>(`${this.base}/api/channels/${this.o.channel ?? 'stable'}/latest`, 'GET', undefined, this.o.transport, this.auth);
      const m = verifiedManifest(env, key);
      this.latest = m;
      const cur = currentBuild(this.root);
      const pending = this.pending();
      if (m.build <= cur.build || pending?.build === m.build) {
        this.state = pending ? 'staged' : 'idle';
        this.error = null;
        return !!pending;
      }
      this.state = 'downloading';
      const data = await requestBuffer(`${this.base}/files/${m.build}/${encodeURIComponent(m.backend.file)}`, m.backend.size, { ...this.o.transport, timeoutMs: 120_000 }, this.auth);
      stageBundle(this.root, m, data);
      this.state = 'staged';
      this.stagedAt = Date.now();
      this.error = null;
      this.o.log?.(`update ${m.version} (build ${m.build}) downloaded and verified – installed when nothing runs here`);
      return true;
    } catch (e) {
      this.state = this.pending() ? 'staged' : 'error';
      this.error = (e as Error).message;
      if ((e as any).status !== 404) this.o.log?.(`update check failed: ${this.error}`);
      return this.state === 'staged';
    } finally {
      this.busy = false;
    }
  }

  /** The owner asked for it: check now and install right away (sessions reconnect after the restart). */
  async updateNow(): Promise<string> {
    const staged = await this.check();
    if (!staged) return this.error ? `check failed: ${this.error}` : 'already up to date';
    if (this.o.gameOpen()) return 'update ready – installed when the game window is closed';
    this.state = 'restarting';
    this.o.log?.('installing the update now (requested by the account owner – sessions reconnect in a moment)');
    this.o.restart();
    return 'installing';
  }

  /** Restarts into a staged update when the moment is right. */
  maybeInstall(now = Date.now()): boolean {
    if (this.state !== 'staged' || this.o.gameOpen()) return false;
    const force = now - this.stagedAt >= (this.o.forceAfterMs ?? 6 * 3600_000);
    if (!this.o.isIdle() && !force) return false;
    this.state = 'restarting';
    this.o.log?.(`installing the update now${force && !this.o.isIdle() ? ' (sessions reconnect in a moment)' : ''}`);
    this.o.restart();
    return true;
  }

  start(): void {
    const every = this.o.checkEveryMs ?? 6 * 3600_000;
    const first = setTimeout(() => void this.check().then(() => this.maybeInstall()), 60_000);
    const checks = setInterval(() => void this.check().then(() => this.maybeInstall()), every);
    const install = setInterval(() => this.maybeInstall(), 60_000);
    for (const t of [first, checks, install]) t.unref?.();
    this.timers.push(first, checks, install);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
