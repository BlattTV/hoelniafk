/**
 * GameClientRuntime – runs the official Minecraft Java client (vanilla or Fabric)
 * for a session, as a normal desktop window.
 *
 *   install (Mojang/Fabric, SHA-1 verified) ─▶ java … net.minecraft.client.main.Main
 *        --quickPlayMultiplayer 127.0.0.1:<forwarder>        (or --server/--port)
 *   forwarder ─▶ NetworkProfile (bind IP / SOCKS5 / HTTP) ─▶ server
 *   logs/latest.log ─▶ chat lines ─▶ rules (link codes, rewards)
 *   window: user32 (Windows) / xdotool (X11) – show, minimize, close
 *
 * The runtime reports the same events as the lightweight runtime (phase, spawned,
 * chat, ended, stats) plus `game` lifecycle events, so the SessionManager can treat
 * both uniformly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, registerSecret } from '../core/logger.js';
import type { GameClientSettings } from '../core/types.js';
import type { GameInfo, JavaSession, RuntimeEvent, RuntimeSessionSpec, RuntimeStats, HostStats } from '../runtime/types.js';
import { startForwarder, type Forwarder } from './forwarder.js';
import { LogTail, offlineUuid, parseLogLine, pingServer, versionForProtocol, writeOptions } from './instance.js';
import { buildLaunchArgs, type LaunchAuth } from './launcher/args.js';
import { Downloader, type MirrorMap } from './launcher/download.js';
import { ENDPOINTS, Installer, type InstalledVersion } from './launcher/installer.js';
import { currentPlatform, type Platform } from './launcher/rules.js';
import { NoWindowController, type WindowController } from './window.js';

const log = createLogger('game');

export interface GameClientOptions {
  /** Shared installation (versions, libraries, assets, Java runtimes). */
  rootDir: string;
  /** Per-session game directories. */
  instancesDir: string;
  /** Java executable to use instead of Mojang's runtime (also used by tests for the client emulator). */
  javaPath?: string;
  mirrors?: MirrorMap;
  endpoints?: typeof ENDPOINTS;
  platform?: Platform;
  authProvider: (identityId: number) => Promise<JavaSession>;
  window?: WindowController;
  /** A login connection that stays up this long counts as ONLINE. */
  onlineAfterMs?: number;
  /** The game must reach the server within this time after it was started. */
  joinTimeoutMs?: number;
  /** Grace period for a graceful close before the process is killed. */
  closeTimeoutMs?: number;
  concurrency?: number;
}

export interface GameLaunch {
  spec: RuntimeSessionSpec;
  settings: GameClientSettings;
  /** true: bring the window to the front once it exists; false: minimize it. */
  visible: boolean;
  /** Runs right before the game's login goes upstream (ends the lightweight session on handover). */
  beforeLogin?: () => Promise<void>;
  /**
   * Live takeover: join this local endpoint (the running lightweight session) instead of the
   * server. No forwarder, no own server connection – the session's connection is used.
   */
  connect?: { host: string; port: number };
  /** Launch identity for takeover (the local endpoint is offline-mode: no Microsoft token is passed to the game). */
  auth?: LaunchAuth;
}

interface Entry {
  launch: GameLaunch;
  info: GameInfo;
  proc: ChildProcess | null;
  forwarder: Forwarder | null;
  tail: LogTail | null;
  timers: NodeJS.Timeout[];
  output: string[];
  disconnectReason: string | null;
  /** Last ERROR/FATAL line of latest.log (why the game left or crashed). */
  lastErrorLine: string | null;
  loginSeen: boolean;
  online: boolean;
  ended: boolean;
  exited: Promise<void>;
  markExited: () => void;
  secret: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GameClientRuntime {
  readonly kind = 'game';
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(e: RuntimeEvent) => void>();
  private readonly installer: Installer;
  private readonly platform: Platform;
  private readonly window: WindowController;
  private readonly installs = new Map<string, Promise<InstalledVersion>>();
  private readonly javas = new Map<string, Promise<string>>();

  constructor(private readonly opts: GameClientOptions) {
    this.platform = opts.platform ?? currentPlatform();
    this.installer = new Installer(opts.rootDir, new Downloader(opts.mirrors ?? {}, opts.concurrency ?? 16), this.platform, opts.endpoints ?? ENDPOINTS);
    this.window = opts.window ?? new NoWindowController();
  }

  get windowControl(): string {
    return this.window.name;
  }

  onEvent(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: RuntimeEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        log.error(`listener failed: ${(err as Error).message}`);
      }
    }
  }

  private update(en: Entry, patch: Partial<GameInfo>): void {
    Object.assign(en.info, patch);
    this.emit({ type: 'game', sessionId: en.launch.spec.sessionId, game: { ...en.info } });
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Why the game left the server, from its own log (disconnect reason or last error line). */
  diagnosis(sessionId: string): string | null {
    const en = this.entries.get(sessionId);
    if (!en) return null;
    en.tail?.poll();
    return en.disconnectReason ?? en.lastErrorLine ?? null;
  }

  info(sessionId: string): GameInfo | null {
    const en = this.entries.get(sessionId);
    return en ? { ...en.info } : null;
  }

  // ------------------------------------------------------------------ start

  /** Starts installing + launching in the background. Failures arrive as `ended` events. */
  async startSession(launch: GameLaunch): Promise<void> {
    const id = launch.spec.sessionId;
    if (this.entries.has(id)) throw new Error('A game client is already running for this session');
    let markExited!: () => void;
    const exited = new Promise<void>((r) => (markExited = r));
    const en: Entry = {
      launch,
      info: { status: 'installing', pid: null, visible: launch.visible, mode: launch.settings.mode, version: null, progress: null, message: 'Preparing game files', startedAt: new Date().toISOString() },
      proc: null,
      forwarder: null,
      tail: null,
      timers: [],
      output: [],
      disconnectReason: null,
      lastErrorLine: null,
      loginSeen: false,
      online: false,
      ended: false,
      exited,
      markExited,
      secret: null,
    };
    this.entries.set(id, en);
    this.update(en, {});
    void this.run(en).catch((e) => this.end(en, 'launchFailed', (e as Error).message, false));
  }

  private async resolveVersion(spec: RuntimeSessionSpec, settings: GameClientSettings): Promise<string> {
    if (settings.version && settings.version !== 'auto') return settings.version;
    if (spec.server.version) return spec.server.version;
    try {
      const st = await pingServer(spec.server.host, spec.server.port, spec.network);
      const v = versionForProtocol(st.protocol, st.versionName);
      if (v) return v;
    } catch (e) {
      log.warn(`Version detection for ${spec.server.name} failed: ${(e as Error).message}`);
    }
    return 'latest-release';
  }

  private installVersion(version: string, loader: GameClientSettings['loader'], en: Entry): Promise<InstalledVersion> {
    const key = `${loader}:${version}`;
    let p = this.installs.get(key);
    if (!p) {
      let last = 0;
      p = this.installer.install({ version, loader }, (stage, pr) => {
        const now = Date.now();
        if (now - last < 250 && pr.done !== pr.total) return;
        last = now;
        for (const e of this.entries.values()) if (e.info.status === 'installing') this.update(e, { progress: { stage, done: pr.done, total: pr.total }, message: `Downloading ${stage}` });
      });
      this.installs.set(key, p);
      p.catch(() => this.installs.delete(key));
    }
    this.update(en, { message: `Installing Minecraft ${version}${loader === 'fabric' ? ' (Fabric)' : ''}` });
    return p;
  }

  private java(v: InstalledVersion): Promise<string> {
    if (this.opts.javaPath) return Promise.resolve(this.opts.javaPath);
    let p = this.javas.get(v.javaComponent);
    if (!p) {
      p = this.installer.ensureJava(v.javaComponent);
      this.javas.set(v.javaComponent, p);
      p.catch(() => this.javas.delete(v.javaComponent));
    }
    return p;
  }

  private async launchAuth(spec: RuntimeSessionSpec): Promise<LaunchAuth> {
    if (spec.auth === 'offline') return { username: spec.username, uuid: offlineUuid(spec.username), accessToken: '0', userType: 'legacy' };
    const js = await this.opts.authProvider(spec.identityId);
    registerSecret(js.accessToken);
    return { username: js.profile.name, uuid: js.profile.id.replace(/-/g, ''), accessToken: js.accessToken, userType: 'msa' };
  }

  gameDir(spec: RuntimeSessionSpec): string {
    return path.join(this.opts.instancesDir, `identity-${spec.identityId}-server-${spec.server.id}`);
  }

  private async run(en: Entry): Promise<void> {
    const { spec, settings } = en.launch;
    const sid = spec.sessionId;
    const version = await this.resolveVersion(spec, settings);
    if (en.ended) return;
    this.update(en, { version });
    const installed = await this.installVersion(version, settings.loader, en);
    if (en.ended) return;
    const java = await this.java(installed);
    if (en.ended) return;
    this.update(en, { status: 'launching', progress: null, version: installed.id, message: 'Signing in' });
    const auth = en.launch.auth ?? (await this.launchAuth(spec));
    if (en.ended) return;
    en.secret = auth.accessToken.length > 8 ? auth.accessToken : null;

    // Live takeover: the game joins the lightweight session's local endpoint directly.
    // Otherwise a local forwarder: the game joins 127.0.0.1:<port>, the forwarder connects through the network profile.
    const joinTarget = en.launch.connect ?? null;
    if (!joinTarget) en.forwarder = await startForwarder({
      target: { host: spec.server.host, port: spec.server.port },
      network: spec.network,
      beforeLogin: en.launch.beforeLogin,
      onLoginUpstream: () => {
        if (en.ended) return;
        en.loginSeen = true;
        this.emit({ type: 'phase', sessionId: sid, phase: 'AUTHENTICATING' });
        en.timers.push(
          setTimeout(() => {
            if (en.ended || !en.forwarder?.stats().loginActive) return;
            en.online = true;
            this.emit({ type: 'spawned', sessionId: sid, username: auth.username, uuid: auth.uuid, version: installed.gameVersion });
            this.emit({ type: 'phase', sessionId: sid, phase: 'ONLINE' });
          }, this.opts.onlineAfterMs ?? 5000),
        );
      },
      onLoginClosed: (reason) => {
        if (en.ended) return;
        // The log line with the kick reason is usually written a moment later.
        setTimeout(() => {
          en.tail?.poll();
          const detail = en.disconnectReason ?? reason;
          this.end(en, en.online ? 'disconnected' : 'connectFailed', detail, !!en.disconnectReason);
        }, 700).unref?.();
      },
    });
    if (en.ended) {
      await en.forwarder?.close();
      return;
    }

    const gameDir = this.gameDir(spec);
    writeOptions(gameDir);
    const latest = path.join(gameDir, 'logs', 'latest.log');
    fs.rmSync(latest, { force: true });
    en.tail = new LogTail(latest, (line) => this.onLogLine(en, line));
    en.tail.start();

    const args = buildLaunchArgs(
      installed,
      { gameDir, auth, server: joinTarget ?? { host: '127.0.0.1', port: en.forwarder!.port }, memoryMb: settings.memoryMb, launcherName: 'hoelni-client-suite' },
      this.platform,
    );
    log.with({ identityId: spec.identityId, sessionId: sid }).info(`Launching Minecraft ${installed.id} (${settings.mode}) for ${spec.server.name}`);
    const proc = spawn(java, args, { cwd: gameDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    en.proc = proc;
    const keep = (d: Buffer) => {
      for (const l of d.toString('utf8').split(/\r?\n/)) {
        if (!l.trim()) continue;
        en.output.push(en.secret ? l.split(en.secret).join('***') : l);
        if (en.output.length > 60) en.output.shift();
      }
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    proc.on('error', (e) => this.end(en, 'launchFailed', `Could not start Java (${java}): ${e.message}`, false));
    proc.on('exit', (code, signal) => {
      en.markExited();
      if (en.ended) return;
      const tail = en.output.filter((l) => !l.startsWith('<')).slice(-3).join(' | ');
      this.end(en, 'clientExited', `Game closed (exit ${code ?? signal})${code && tail ? `: ${tail}` : ''}`, false);
    });
    this.update(en, { status: 'starting', pid: proc.pid ?? null, message: 'Starting Minecraft' });
    if (!joinTarget) {
      this.emit({ type: 'phase', sessionId: sid, phase: 'CONNECTING' });
      this.watchStats(en, installed.gameVersion);
    }
    this.watchWindow(en);
    en.timers.push(
      setTimeout(() => {
        if (!en.ended && !en.loginSeen) this.end(en, 'connectFailed', 'The game did not join the server in time', false);
      }, this.opts.joinTimeoutMs ?? 5 * 60_000),
    );
  }

  private onLogLine(en: Entry, line: string): void {
    const p = parseLogLine(line);
    if (!p) return;
    const sid = en.launch.spec.sessionId;
    if (p.type === 'chat') this.emit({ type: 'chat', sessionId: sid, text: p.text, ts: new Date().toISOString() });
    else if (p.type === 'disconnect') {
      // keep the real reason – a following "Connection lost: quitting/closed" line adds nothing
      if (!en.disconnectReason || !/quitting|closed/i.test(p.reason)) en.disconnectReason = p.reason.slice(0, 300);
    }
    else if (p.type === 'error') en.lastErrorLine = (en.secret ? p.text.split(en.secret).join('***') : p.text).slice(0, 300);
  }

  /** Waits for the game window and applies the wanted visibility once it exists. */
  private watchWindow(en: Entry): void {
    const pid = en.proc?.pid;
    if (!pid) return;
    if (this.window.name === 'none') {
      this.update(en, { status: 'running', message: null });
      return;
    }
    let tries = 0;
    const tick = async () => {
      if (en.ended) return;
      tries++;
      if (await this.window.hasWindow(pid)) {
        await (en.info.visible ? this.window.show(pid) : this.window.minimize(pid));
        this.update(en, { status: 'running', message: null });
        return;
      }
      if (tries < 180) en.timers.push(setTimeout(() => void tick(), 1000));
      else this.update(en, { status: 'running', message: 'Game window not found – use Alt-Tab' });
    };
    en.timers.push(setTimeout(() => void tick(), 1000));
  }

  private watchStats(en: Entry, version: string): void {
    const t = setInterval(() => {
      if (en.ended || !en.forwarder) return;
      const s = en.forwarder.stats();
      this.emit({
        type: 'stats',
        sessionId: en.launch.spec.sessionId,
        stats: { bytesIn: s.bytesDown, bytesOut: s.bytesUp, ping: null, health: null, food: null, position: null, dimension: null, physics: true, version },
      });
    }, 5000);
    t.unref?.();
    en.timers.push(t);
  }

  /** Takeover: the session reports that the game joined (stops the join timeout). */
  notifyJoined(sessionId: string): void {
    const en = this.entries.get(sessionId);
    if (en) en.loginSeen = true;
  }

  // ------------------------------------------------------------------ window

  async show(sessionId: string): Promise<string> {
    const en = this.entries.get(sessionId);
    if (!en) throw new Error('No game client running for this session');
    this.update(en, { visible: true });
    return en.proc?.pid ? this.window.show(en.proc.pid) : 'nowindow';
  }

  async minimize(sessionId: string): Promise<string> {
    const en = this.entries.get(sessionId);
    if (!en) throw new Error('No game client running for this session');
    this.update(en, { visible: false });
    return en.proc?.pid ? this.window.minimize(en.proc.pid) : 'nowindow';
  }

  // ------------------------------------------------------------------ stop

  private async terminate(en: Entry): Promise<void> {
    const proc = en.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const grace = this.opts.closeTimeoutMs ?? 15_000;
    const r = proc.pid ? await this.window.close(proc.pid) : 'nowindow';
    if (r !== 'ok') proc.kill('SIGTERM');
    const done = await Promise.race([en.exited.then(() => true), sleep(grace).then(() => false)]);
    if (!done) {
      proc.kill('SIGKILL');
      await Promise.race([en.exited, sleep(3000)]);
    }
  }

  private end(en: Entry, reason: string, error: string | null, kicked: boolean): void {
    if (en.ended) return;
    en.ended = true;
    const sid = en.launch.spec.sessionId;
    for (const t of en.timers) clearTimeout(t);
    en.tail?.stop();
    const failed = reason === 'launchFailed' || reason === 'connectFailed';
    if (error) log.with({ identityId: en.launch.spec.identityId, sessionId: sid })[failed ? 'warn' : 'info'](`Game session ended (${reason}): ${error}`);
    this.update(en, { status: 'closing', message: error });
    void (async () => {
      await en.forwarder?.close().catch(() => undefined);
      await this.terminate(en).catch(() => undefined);
      this.entries.delete(sid);
      this.update(en, { status: failed ? 'failed' : 'closed', pid: null });
      this.emit({ type: 'ended', sessionId: sid, reason, kicked, error });
    })();
  }

  /** Closes the game (graceful window close, then kill) and resolves when it is gone. */
  async stopSession(sessionId: string, reason = 'stopped'): Promise<void> {
    const en = this.entries.get(sessionId);
    if (!en) return;
    const gone = new Promise<void>((resolve) => {
      const off = this.onEvent((e) => {
        if (e.type === 'ended' && e.sessionId === sessionId) {
          off();
          resolve();
        }
      });
    });
    this.end(en, reason, null, false);
    await gone;
  }

  async sendChat(): Promise<void> {
    throw new Error('The real game window owns this session – type the message in the game');
  }

  stats(): RuntimeStats {
    const hosts: HostStats[] = [];
    for (const [sid, en] of this.entries) {
      const pid = en.proc?.pid;
      if (!pid) continue;
      hosts.push({ hostId: `game:${sid}`, pid, rss: rssOf(pid), heapUsed: 0, cpuPercent: 0, eventLoopLagMs: 0, sessions: 1, threads: null, uptimeSec: Math.round((Date.now() - Date.parse(en.info.startedAt ?? new Date().toISOString())) / 1000) });
    }
    return { kind: 'game', hosts };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stopSession(id, 'shutdown')));
    this.window.dispose();
  }
}

function rssOf(pid: number): number {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}
