/**
 * MineflayerRuntime – supervises runtime hosts.
 *
 *  main process                         runtime host (child process)
 *  ─────────────                        ────────────────────────────
 *  MineflayerRuntime ──IPC(advanced)──▶ RuntimeHostCore ── mineflayer bots
 *        ▲  auth.request (per session)        │
 *        └── MinecraftAuthService (vault) ◀───┘
 *
 * - Sessions are placed on hosts with a per-host cap (fault isolation vs. RAM).
 * - Host crash → every session on it ends with reason "runtimeCrash"; the
 *   reconciler restarts them on a fresh host. Other hosts are unaffected.
 * - Missing heartbeats → host is killed and treated as crashed.
 * - Idle hosts are reaped.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';
import type { HostChannel, HostToMain, MainToHost } from './protocol.js';
import { RuntimeHostCore, type HostBotFactory } from './host/hostCore.js';
import type { HostStats, JavaSession, MinecraftRuntime, RuntimeEvent, RuntimeSessionSpec, RuntimeStats } from './types.js';

const log = createLogger('runtime');

export interface MineflayerRuntimeOptions {
  mode: 'process' | 'inline';
  /** Max sessions per host process. 1 = one process per session (maximum isolation). */
  sessionsPerHost: number;
  /** "identity": keep sessions of one identity together (a crash affects one account); "pooled": fill hosts. */
  grouping: 'identity' | 'pooled';
  botFactory?: HostBotFactory;
  /** Called with the identity recorded by the main process when the session was started (never trusted from the host). */
  authProvider: (identityId: number, sessionId: string) => Promise<JavaSession>;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  idleHostTtlMs?: number;
}

/** A runtime host on another machine (Hoelni Agent), connected over WebSocket. */
export interface RemoteHostLink {
  agentId: number;
  name: string;
  send(m: MainToHost): void;
  close(reason: string): void;
}

interface HostHandle {
  id: string;
  child: ChildProcess | null;
  remote: RemoteHostLink | null;
  inline: { deliver: (m: MainToHost) => void; core: RuntimeHostCore } | null;
  sessions: Set<string>;
  identities: Map<number, number>;
  stats: Omit<HostStats, 'hostId'> | null;
  lastBeat: number;
  alive: boolean;
  idleSince: number | null;
  ready: Promise<void>;
}

let hostSeq = 1;

function hostScript(): { file: string; execArgv: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const isTs = import.meta.url.endsWith('.ts');
  const file = path.join(here, 'host', isTs ? 'main.ts' : 'main.js');
  return { file, execArgv: isTs ? ['--import', 'tsx'] : [] };
}

export class MineflayerRuntime implements MinecraftRuntime {
  readonly kind = 'mineflayer' as const;
  private readonly hosts = new Map<string, HostHandle>();
  private readonly sessionHost = new Map<string, HostHandle>();
  private readonly sessionIdentity = new Map<string, number>();
  private readonly events = new EventEmitter();
  private readonly watchdog: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(private readonly opts: MineflayerRuntimeOptions) {
    this.events.setMaxListeners(50);
    this.watchdog = setInterval(() => this.checkHosts(), Math.min(opts.heartbeatMs ?? 5000, 5000));
    this.watchdog.unref?.();
  }

  onEvent(listener: (e: RuntimeEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  private emit(e: RuntimeEvent): void {
    this.events.emit('event', e);
  }

  // ------------------------------------------------------------------ hosts

  private spawnHost(): HostHandle {
    const id = `host-${hostSeq++}`;
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));
    const handle: HostHandle = {
      id, child: null, remote: null, inline: null, sessions: new Set(), identities: new Map(), stats: null,
      lastBeat: Date.now(), alive: true, idleSince: null, ready,
    };
    const onMsg = (m: HostToMain) => {
      if (m.evt === 'ready') resolveReady();
      this.fromHost(handle, m);
    };
    if (this.opts.mode === 'inline') {
      if (!this.opts.botFactory) throw new Error('inline runtime needs a botFactory');
      let toHost: ((m: MainToHost) => void) | null = null;
      const channel: HostChannel = {
        send: (m) => setImmediate(() => handle.alive && onMsg(structuredClone(m))),
        onMessage: (l) => (toHost = l),
      };
      const core = new RuntimeHostCore(channel, this.opts.botFactory, { heartbeatMs: this.opts.heartbeatMs ?? 5000 });
      handle.inline = {
        core,
        deliver: (m) =>
          setImmediate(() => {
            if (!handle.alive) return;
            try {
              toHost!(structuredClone(m));
            } catch (e) {
              log.error(`Inline host ${id} crashed: ${(e as Error).message}`);
              core.dispose();
              this.onHostExit(handle, 'crash');
            }
          }),
      };
    } else {
      const { file, execArgv } = hostScript();
      const child = fork(file, [], {
        serialization: 'advanced',
        execArgv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, HOELNI_HOST_ID: id, HOELNI_HOST_HEARTBEAT_MS: String(this.opts.heartbeatMs ?? 5000) },
      });
      handle.child = child;
      child.on('message', (m) => onMsg(m as HostToMain));
      child.on('exit', (code, signal) => this.onHostExit(handle, `exit code=${code} signal=${signal}`));
      child.on('error', (e) => log.error(`Runtime host ${id} error: ${e.message}`));
      const pipeLog = (buf: Buffer) => {
        for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) log.debug(`[${id}] ${line.slice(0, 500)}`);
      };
      child.stdout?.on('data', pipeLog);
      child.stderr?.on('data', pipeLog);
    }
    this.hosts.set(id, handle);
    log.info(`Started runtime host ${id} (${this.opts.mode})`);
    return handle;
  }

  /**
   * Registers a connected agent as runtime host. Returns the function that delivers the
   * agent's messages and a close callback for when its connection ends.
   */
  attachRemoteHost(link: RemoteHostLink): { deliver: (m: HostToMain) => void; detach: (why: string) => void } {
    const existing = this.remoteHost(link.agentId);
    if (existing) {
      existing.remote?.close('Replaced by a new connection');
      this.onHostExit(existing, 'agent reconnected');
    }
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));
    const handle: HostHandle = {
      id: `agent-${link.agentId}`, child: null, remote: link, inline: null, sessions: new Set(), identities: new Map(), stats: null,
      lastBeat: Date.now(), alive: true, idleSince: null, ready,
    };
    this.hosts.set(handle.id, handle);
    log.info(`Agent "${link.name}" (#${link.agentId}) connected as runtime host`);
    return {
      deliver: (m) => {
        if (!handle.alive) return;
        if (m.evt === 'ready') resolveReady();
        this.fromHost(handle, m);
      },
      detach: (why) => this.onHostExit(handle, why),
    };
  }

  private remoteHost(agentId: number): HostHandle | undefined {
    return [...this.hosts.values()].find((h) => h.alive && h.remote?.agentId === agentId);
  }

  private readonly pausedAgents = new Set<number>();

  /** The household paused sharing: no new sessions are placed on this agent. */
  setAgentPaused(agentId: number, paused: boolean): void {
    if (paused) this.pausedAgents.add(agentId);
    else this.pausedAgents.delete(agentId);
  }

  isAgentOnline(agentId: number): boolean {
    return !!this.remoteHost(agentId);
  }

  agentSessions(agentId: number): string[] {
    return [...(this.remoteHost(agentId)?.sessions ?? [])];
  }

  /** Sends a command to the agent that runs a session (used for the game window on agents). */
  sendToSessionHost(sessionId: string, m: MainToHost): boolean {
    const h = this.sessionHost.get(sessionId);
    if (!h?.remote) return false;
    this.send(h, m);
    return true;
  }

  isRemoteSession(sessionId: string): boolean {
    return !!this.sessionHost.get(sessionId)?.remote;
  }

  private send(h: HostHandle, m: MainToHost): void {
    if (!h.alive) return;
    if (h.remote) h.remote.send(m);
    else if (h.inline) h.inline.deliver(m);
    else if (h.child?.connected) h.child.send(m);
  }

  private pickHost(identityId: number, agentId: number | null = null): HostHandle {
    if (agentId !== null) {
      const remote = this.remoteHost(agentId);
      if (!remote) throw new Error(`Agent #${agentId} is offline – the session starts as soon as it connects`);
      if (this.pausedAgents.has(agentId)) throw new Error(`Agent "${remote.remote?.name}" is paused by the household`);
      return remote;
    }
    const cap = Math.max(1, this.opts.sessionsPerHost);
    const alive = [...this.hosts.values()].filter((h) => h.alive && !h.remote && h.sessions.size < cap);
    if (this.opts.grouping === 'identity') {
      const same = alive.find((h) => h.identities.has(identityId));
      if (same) return same;
      const empty = alive.find((h) => h.sessions.size === 0);
      if (empty) return empty;
      return this.spawnHost();
    }
    alive.sort((a, b) => b.sessions.size - a.sessions.size); // fill up
    return alive[0] ?? this.spawnHost();
  }

  private fromHost(h: HostHandle, m: HostToMain): void {
    switch (m.evt) {
      case 'ready':
        h.lastBeat = Date.now();
        return;
      case 'heartbeat':
        h.stats = m.stats;
        h.lastBeat = Date.now();
        return;
      case 'log': {
        const identityId = m.sessionId ? this.sessionIdentity.get(m.sessionId) : undefined;
        log.with({ sessionId: m.sessionId, identityId })[m.level](`[${h.id}] ${m.message}`);
        return;
      }
      case 'auth.request': {
        // Only sessions that actually live on this host may request tokens.
        const identityId = this.sessionIdentity.get(m.sessionId);
        if (!h.sessions.has(m.sessionId) || identityId === undefined) {
          this.send(h, { cmd: 'auth.reply', reqId: m.reqId, error: 'Unknown session' });
          return;
        }
        this.opts
          .authProvider(identityId, m.sessionId)
          .then((session) => this.send(h, { cmd: 'auth.reply', reqId: m.reqId, session }))
          .catch((e) => this.send(h, { cmd: 'auth.reply', reqId: m.reqId, error: (e as Error).message }));
        return;
      }
      case 'runtime': {
        const e = m.event;
        if (this.sessionHost.get(e.sessionId) !== h) {
          return; // stale event of a session that moved or ended
        }
        if (e.type === 'ended') this.release(e.sessionId);
        this.emit(e);
        return;
      }
    }
  }

  private release(sessionId: string): void {
    const h = this.sessionHost.get(sessionId);
    if (!h) return;
    this.sessionHost.delete(sessionId);
    h.sessions.delete(sessionId);
    const identityId = this.sessionIdentity.get(sessionId);
    this.sessionIdentity.delete(sessionId);
    if (identityId !== undefined) {
      const n = (h.identities.get(identityId) ?? 1) - 1;
      if (n <= 0) h.identities.delete(identityId);
      else h.identities.set(identityId, n);
    }
    if (h.sessions.size === 0) h.idleSince = Date.now();
  }

  private onHostExit(h: HostHandle, why: string): void {
    if (!h.alive) return;
    h.alive = false;
    this.hosts.delete(h.id);
    const affected = [...h.sessions];
    if (!this.shuttingDown) log.warn(`Runtime host ${h.id} exited (${why}); ${affected.length} session(s) affected`);
    for (const sessionId of affected) {
      this.release(sessionId);
      this.emit({ type: 'ended', sessionId, reason: 'runtimeCrash', kicked: false, error: `Runtime host ${h.id} exited (${why})` });
    }
  }

  private checkHosts(): void {
    const now = Date.now();
    const timeout = this.opts.heartbeatTimeoutMs ?? 30_000;
    for (const h of this.hosts.values()) {
      if (now - h.lastBeat > timeout) {
        log.error(`Runtime host ${h.id} missed heartbeats for ${Math.round((now - h.lastBeat) / 1000)}s – restarting`);
        if (h.remote) {
          h.remote.close('heartbeat timeout');
          this.onHostExit(h, 'agent heartbeat timeout');
        } else if (h.child) h.child.kill('SIGKILL');
        else {
          h.inline?.core.dispose();
          this.onHostExit(h, 'heartbeat timeout');
        }
        continue;
      }
      if (!h.remote && h.sessions.size === 0 && h.idleSince && now - h.idleSince > (this.opts.idleHostTtlMs ?? 60_000)) {
        this.stopHost(h);
      }
    }
  }

  private stopHost(h: HostHandle): void {
    this.send(h, { cmd: 'shutdown' });
    if (h.child) {
      h.child.disconnect?.();
      setTimeout(() => h.child?.kill('SIGKILL'), 5000).unref?.();
    } else {
      h.inline?.core.dispose();
      this.onHostExit(h, 'idle');
    }
  }

  // ------------------------------------------------------------------ MinecraftRuntime

  async startSession(spec: RuntimeSessionSpec): Promise<void> {
    if (this.shuttingDown) throw new Error('Runtime is shutting down');
    if (this.sessionHost.has(spec.sessionId)) await this.stopSession(spec.sessionId, 'restart');
    const h = this.pickHost(spec.identityId, spec.placement?.agentId ?? null);
    h.sessions.add(spec.sessionId);
    h.identities.set(spec.identityId, (h.identities.get(spec.identityId) ?? 0) + 1);
    h.idleSince = null;
    this.sessionHost.set(spec.sessionId, h);
    this.sessionIdentity.set(spec.sessionId, spec.identityId);
    await h.ready;
    this.send(h, { cmd: 'start', spec });
  }

  async stopSession(sessionId: string, reason = 'stopped'): Promise<void> {
    const h = this.sessionHost.get(sessionId);
    if (!h) return;
    await new Promise<void>((resolve) => {
      const off = this.onEvent((e) => {
        if (e.type === 'ended' && e.sessionId === sessionId) {
          off();
          clearTimeout(t);
          resolve();
        }
      });
      const t = setTimeout(() => {
        off();
        // Host did not confirm – forget the session so it can be restarted.
        if (this.sessionHost.get(sessionId) === h) {
          this.release(sessionId);
          this.emit({ type: 'ended', sessionId, reason, kicked: false, error: 'Stop not confirmed by runtime host' });
        }
        resolve();
      }, 8000);
      this.send(h, { cmd: 'stop', sessionId, reason });
    });
  }

  async sendChat(sessionId: string, text: string): Promise<void> {
    const h = this.requireHost(sessionId);
    this.send(h, { cmd: 'chat', sessionId, text });
  }

  async openTakeover(sessionId: string): Promise<number> {
    const h = this.requireHost(sessionId);
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('The session did not answer the takeover request'));
      }, 15_000);
      const off = this.onEvent((e) => {
        if (e.sessionId !== sessionId || e.type !== 'takeover' || (e.status !== 'ready' && e.status !== 'error')) return;
        clearTimeout(timer);
        off();
        if (e.status === 'ready' && e.port) resolve(e.port);
        else reject(new Error(e.message ?? 'Takeover failed'));
      });
      this.send(h, { cmd: 'takeover.open', sessionId });
    });
  }

  async closeTakeover(sessionId: string, reason = 'Back to AFK'): Promise<void> {
    const h = this.sessionHost.get(sessionId);
    if (!h) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, 10_000);
      const off = this.onEvent((e) => {
        if (e.sessionId === sessionId && e.type === 'takeover' && e.status === 'closed') {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      this.send(h, { cmd: 'takeover.close', sessionId, reason });
    });
  }

  /** Test hook: crash the host that runs a session. */
  crashHostOf(sessionId: string): void {
    const h = this.requireHost(sessionId);
    this.send(h, { cmd: 'crash' });
  }

  private requireHost(sessionId: string): HostHandle {
    const h = this.sessionHost.get(sessionId);
    if (!h) throw new Error(`Session ${sessionId} is not running`);
    return h;
  }

  stats(): RuntimeStats {
    return {
      kind: this.kind,
      hosts: [...this.hosts.values()].map((h) => ({
        hostId: h.id,
        pid: h.stats?.pid ?? h.child?.pid ?? process.pid,
        rss: h.stats?.rss ?? 0,
        heapUsed: h.stats?.heapUsed ?? 0,
        cpuPercent: h.stats?.cpuPercent ?? 0,
        eventLoopLagMs: h.stats?.eventLoopLagMs ?? 0,
        sessions: h.sessions.size,
        threads: h.stats?.threads ?? null,
        uptimeSec: h.stats?.uptimeSec ?? 0,
      })),
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.watchdog);
    const waits: Promise<void>[] = [];
    for (const h of [...this.hosts.values()]) {
      for (const s of h.sessions) this.send(h, { cmd: 'stop', sessionId: s, reason: 'shutdown' });
      if (h.child) {
        const child = h.child;
        waits.push(
          new Promise((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', () => resolve());
            setTimeout(() => {
              this.send(h, { cmd: 'shutdown' });
              child.disconnect?.();
            }, 1500).unref?.();
            setTimeout(() => {
              child.kill('SIGKILL');
              resolve();
            }, 6000).unref?.();
          }),
        );
      } else {
        this.send(h, { cmd: 'shutdown' });
        h.inline?.core.dispose();
        h.alive = false;
      }
    }
    await Promise.all(waits);
    this.hosts.clear();
  }
}
