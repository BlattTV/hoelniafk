/**
 * Runtime host: owns a set of mineflayer sessions. Runs inside a supervised
 * child process (production) or inline (tests). Communicates only through a
 * HostChannel, so the same code serves both modes.
 *
 * A host never touches the vault: Microsoft tokens are requested per session
 * from the main process (which checks the owning identity) and kept in memory.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { HostChannel, MainToHost } from '../protocol.js';
import type { ControlInput, InventoryItem, JavaSession, RuntimeEvent, RuntimeSessionSpec, SessionStats } from '../types.js';

/** The subset of a mineflayer bot the host uses (fakes in tests implement parts of it). */
export interface HostBot extends EventEmitter {
  quit(reason?: string): void;
  chat(message: string): void;
  end?(reason?: string): void;
  username?: string;
  version?: string;
  entity?: any;
  world?: any;
  entities?: Record<string, any>;
  health?: number;
  food?: number;
  player?: any;
  game?: any;
  physicsEnabled?: boolean;
  inventory?: any;
  _client?: any;
  look?(yaw: number, pitch: number, force?: boolean): Promise<void> | void;
  setControlState?(control: string, state: boolean): void;
  clearControlStates?(): void;
  swingArm?(hand?: string): void;
  attack?(entity: any): void;
  activateItem?(): void;
  deactivateItem?(): void;
  dig?(block: any, forceLook?: boolean | string): Promise<void>;
  stopDigging?(): void;
  placeBlock?(ref: any, face: any): Promise<void>;
  setQuickBarSlot?(slot: number): void;
  blockAtCursor?(maxDistance?: number): any;
  entityAtCursor?(maxDistance?: number): any;
}

export type HostBotFactory = (spec: RuntimeSessionSpec, getJavaSession: () => Promise<JavaSession>) => HostBot;

interface HostSession {
  spec: RuntimeSessionSpec;
  bot: HostBot;
  afkTimer: NodeJS.Timeout | null;
  statsTimer: NodeJS.Timeout | null;
  views: Set<string>;
  viewOpen: boolean;
  ended: boolean;
  kicked: boolean;
  lastError: string | null;
}

interface ViewRelay {
  sessionId: string;
  worldView: any;
  incoming: EventEmitter;
  onMove: () => void;
}

const STATS_INTERVAL_MS = 5000;

export class RuntimeHostCore {
  private readonly sessions = new Map<string, HostSession>();
  private readonly views = new Map<string, ViewRelay>();
  private readonly authWaiters = new Map<number, { resolve: (s: JavaSession) => void; reject: (e: Error) => void }>();
  private authSeq = 1;
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private lastCpu = process.cpuUsage();
  private lastCpuAt = Date.now();
  private readonly startedAt = Date.now();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly channel: HostChannel,
    private readonly botFactory: HostBotFactory,
    private readonly opts: { heartbeatMs?: number; exitOnCrash?: boolean } = {},
  ) {
    this.lag.enable();
    channel.onMessage((m) => this.handle(m));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), opts.heartbeatMs ?? 5000);
    this.heartbeatTimer.unref?.();
    channel.send({ evt: 'ready', pid: process.pid });
  }

  /** Tears the host down without emitting events (used after a simulated/inline crash). */
  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.lag.disable();
    for (const s of this.sessions.values()) {
      s.ended = true;
      if (s.afkTimer) clearInterval(s.afkTimer);
      if (s.statsTimer) clearInterval(s.statsTimer);
      try {
        s.bot.quit('host disposed');
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    this.views.clear();
  }

  private emit(event: RuntimeEvent): void {
    this.channel.send({ evt: 'runtime', event });
  }

  private log(level: 'info' | 'warn' | 'error', message: string, sessionId?: string): void {
    this.channel.send({ evt: 'log', level, message, sessionId });
  }

  // ------------------------------------------------------------------ heartbeat

  private heartbeat(): void {
    const now = Date.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsedMs = Math.max(1, now - this.lastCpuAt);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const mem = process.memoryUsage();
    this.channel.send({
      evt: 'heartbeat',
      stats: {
        pid: process.pid,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10,
        eventLoopLagMs: Math.round((this.lag.mean / 1e6) * 10) / 10,
        sessions: this.sessions.size,
        threads: readThreadCount(),
        uptimeSec: Math.round((now - this.startedAt) / 1000),
      },
    });
    this.lag.reset();
  }

  // ------------------------------------------------------------------ commands

  private handle(m: MainToHost): void {
    try {
      switch (m.cmd) {
        case 'start':
          return this.start(m.spec);
        case 'stop':
          return this.stop(m.sessionId, m.reason);
        case 'chat': {
          const s = this.sessions.get(m.sessionId);
          if (s && !s.ended) s.bot.chat(m.text);
          return;
        }
        case 'control':
          return this.control(m.sessionId, m.input);
        case 'inventory':
          this.channel.send({ evt: 'inventory.reply', reqId: m.reqId, items: this.inventory(m.sessionId) });
          return;
        case 'view.attach':
          return this.attachView(m.sessionId, m.viewId);
        case 'view.detach':
          return this.detachView(m.viewId);
        case 'view.in':
          this.views.get(m.viewId)?.incoming.emit(m.event, ...m.args);
          return;
        case 'setViewOpen':
          return this.setViewOpen(m.sessionId, m.open);
        case 'auth.reply': {
          const w = this.authWaiters.get(m.reqId);
          this.authWaiters.delete(m.reqId);
          if (!w) return;
          if (m.session) w.resolve(m.session);
          else w.reject(new Error(m.error ?? 'Authentication failed'));
          return;
        }
        case 'crash':
          if (this.opts.exitOnCrash) process.exit(70);
          throw new Error('Simulated runtime crash');
        case 'shutdown':
          for (const id of [...this.sessions.keys()]) this.stop(id, 'shutdown');
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
          this.lag.disable();
          return;
      }
    } catch (e) {
      if (m.cmd === 'crash') throw e;
      this.log('error', `Command ${m.cmd} failed: ${(e as Error).message}`, 'sessionId' in m ? (m as any).sessionId : undefined);
    }
  }

  private requestJavaSession(sessionId: string): Promise<JavaSession> {
    const reqId = this.authSeq++;
    return new Promise((resolve, reject) => {
      this.authWaiters.set(reqId, { resolve, reject });
      this.channel.send({ evt: 'auth.request', reqId, sessionId });
      setTimeout(() => {
        if (this.authWaiters.delete(reqId)) reject(new Error('Authentication timed out (Microsoft sign-in pending?)'));
      }, 10 * 60_000).unref?.();
    });
  }

  private start(spec: RuntimeSessionSpec): void {
    if (this.sessions.has(spec.sessionId)) this.stop(spec.sessionId, 'restart');
    this.emit({ type: 'phase', sessionId: spec.sessionId, phase: 'CONNECTING' });
    let bot: HostBot;
    try {
      bot = this.botFactory(spec, () => this.requestJavaSession(spec.sessionId));
    } catch (e) {
      this.emit({ type: 'ended', sessionId: spec.sessionId, reason: 'startFailed', kicked: false, error: (e as Error).message });
      return;
    }
    const s: HostSession = { spec, bot, afkTimer: null, statsTimer: null, views: new Set(), viewOpen: false, ended: false, kicked: false, lastError: null };
    this.sessions.set(spec.sessionId, s);
    const id = spec.sessionId;

    bot.on('login', () => this.emit({ type: 'phase', sessionId: id, phase: 'AUTHENTICATING' }));
    bot.once('spawn', () => {
      this.applyPhysics(s);
      this.emit({
        type: 'spawned',
        sessionId: id,
        username: bot.username ?? spec.username,
        uuid: bot.player?.uuid ?? null,
        version: bot.version ?? null,
      });
      this.emit({ type: 'phase', sessionId: id, phase: 'ONLINE' });
      this.startAfk(s);
      s.statsTimer = setInterval(() => this.emit({ type: 'stats', sessionId: id, stats: this.statsOf(s) }), STATS_INTERVAL_MS);
      s.statsTimer.unref?.();
    });
    bot.on('messagestr', (text: string, position?: string) => {
      if (position === 'game_info') return; // action bar spam
      this.emit({ type: 'chat', sessionId: id, text: String(text).slice(0, 1000), ts: new Date().toISOString() });
    });
    bot.on('kicked', (reason: unknown) => {
      s.kicked = true;
      s.lastError = kickText(reason);
    });
    bot.on('error', (err: Error) => {
      s.lastError = String(err?.message ?? err).slice(0, 500);
    });
    bot.on('end', (reason: unknown) => this.finish(s, typeof reason === 'string' ? reason : 'end'));
  }

  private finish(s: HostSession, reason: string): void {
    if (s.ended) return;
    s.ended = true;
    if (s.afkTimer) clearInterval(s.afkTimer);
    if (s.statsTimer) clearInterval(s.statsTimer);
    for (const v of [...s.views]) this.detachView(v);
    if (this.sessions.get(s.spec.sessionId) === s) this.sessions.delete(s.spec.sessionId);
    this.emit({ type: 'ended', sessionId: s.spec.sessionId, reason, kicked: s.kicked, error: s.lastError });
  }

  private stop(sessionId: string, reason: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.emit({ type: 'ended', sessionId, reason, kicked: false, error: null });
      return;
    }
    try {
      s.bot.quit(reason);
    } catch {
      /* ignore */
    }
    // Some servers never close the socket cleanly: force the end after a grace period.
    setTimeout(() => {
      if (!s.ended) {
        try {
          s.bot._client?.end?.(reason);
          s.bot._client?.socket?.destroy?.();
        } catch {
          /* ignore */
        }
        this.finish(s, reason);
      }
    }, 3000).unref?.();
  }

  // ------------------------------------------------------------------ AFK / lightweight mode

  private applyPhysics(s: HostSession): void {
    if (!('physicsEnabled' in s.bot)) return;
    const needs = s.viewOpen || !s.spec.lightweight || (s.spec.afk.enabled && s.spec.afk.action === 'jump');
    s.bot.physicsEnabled = needs;
  }

  private setViewOpen(sessionId: string, open: boolean): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.viewOpen = open;
    if (!open) s.bot.clearControlStates?.();
    this.applyPhysics(s);
    if (open && s.afkTimer) {
      clearInterval(s.afkTimer); // the user is playing – no automatic AFK actions
      s.afkTimer = null;
    }
    if (!open) this.startAfk(s);
  }

  private startAfk(s: HostSession): void {
    if (s.afkTimer) clearInterval(s.afkTimer);
    s.afkTimer = null;
    const afk = s.spec.afk;
    if (!afk.enabled || afk.action === 'none' || s.viewOpen) return;
    s.afkTimer = setInterval(() => {
      try {
        const b = s.bot;
        if (afk.action === 'look') b.look?.(Math.random() * Math.PI * 2 - Math.PI, (Math.random() - 0.5) * 0.6, false);
        else if (afk.action === 'swing') b.swingArm?.('right');
        else if (afk.action === 'jump') {
          b.setControlState?.('jump', true);
          setTimeout(() => b.setControlState?.('jump', false), 400);
        }
      } catch {
        /* ignore */
      }
    }, Math.max(afk.intervalSec, 10) * 1000);
    s.afkTimer.unref?.();
  }

  // ------------------------------------------------------------------ interactive control

  private control(sessionId: string, input: ControlInput): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;
    const b = s.bot;
    switch (input.kind) {
      case 'state':
        b.setControlState?.(input.control, !!input.value);
        return;
      case 'look':
        void b.look?.(input.yaw, clampPitch(input.pitch), true);
        return;
      case 'lookDelta': {
        const yaw = (b.entity?.yaw ?? 0) + input.dYaw;
        const pitch = clampPitch((b.entity?.pitch ?? 0) + input.dPitch);
        void b.look?.(yaw, pitch, true);
        return;
      }
      case 'attack': {
        const target = b.entityAtCursor?.(3.5);
        if (target) b.attack?.(target);
        else b.swingArm?.('right');
        return;
      }
      case 'dig': {
        const block = b.blockAtCursor?.(5);
        if (block && b.dig) b.dig(block, 'ignore').catch(() => undefined);
        return;
      }
      case 'stopDig':
        b.stopDigging?.();
        return;
      case 'use':
        b.activateItem?.();
        setTimeout(() => b.deactivateItem?.(), 200);
        return;
      case 'place': {
        const block = b.blockAtCursor?.(5);
        if (!block || !b.placeBlock) return;
        const face = block.face;
        const dirs: Record<number, [number, number, number]> = { 0: [0, -1, 0], 1: [0, 1, 0], 2: [0, 0, -1], 3: [0, 0, 1], 4: [-1, 0, 0], 5: [1, 0, 0] };
        const d = dirs[face] ?? [0, 1, 0];
        const vec = block.position.constructor ? new block.position.constructor(d[0], d[1], d[2]) : { x: d[0], y: d[1], z: d[2] };
        b.placeBlock(block, vec).catch(() => undefined);
        return;
      }
      case 'hotbar':
        if (input.slot >= 0 && input.slot <= 8) b.setQuickBarSlot?.(input.slot);
        return;
      case 'clearControls':
        b.clearControlStates?.();
        return;
    }
  }

  private inventory(sessionId: string): InventoryItem[] {
    const s = this.sessions.get(sessionId);
    const items = s?.bot.inventory?.items?.() ?? [];
    return items.map((i: any) => ({ slot: i.slot, name: i.name, displayName: i.displayName ?? i.name, count: i.count }));
  }

  private statsOf(s: HostSession): SessionStats {
    const b = s.bot;
    const sock = b._client?.socket;
    const pos = b.entity?.position;
    return {
      bytesIn: sock?.bytesRead ?? 0,
      bytesOut: sock?.bytesWritten ?? 0,
      ping: typeof b.player?.ping === 'number' ? b.player.ping : null,
      health: typeof b.health === 'number' ? b.health : null,
      food: typeof b.food === 'number' ? b.food : null,
      position: pos ? { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) } : null,
      dimension: b.game?.dimension ?? null,
      physics: b.physicsEnabled ?? false,
      viewOpen: s.viewOpen,
      version: b.version ?? null,
    };
  }

  // ------------------------------------------------------------------ view relay

  private attachView(sessionId: string, viewId: string): void {
    const s = this.sessions.get(sessionId);
    const bot = s?.bot;
    if (!s || !bot?.entity || !bot.world) {
      this.emit({ type: 'view', viewId, event: 'error', args: ['Session is not online'] });
      return;
    }
    const { WorldView } = requireViewer();
    const incoming = new EventEmitter();
    const shim = {
      emit: (event: string, ...args: unknown[]) => this.emit({ type: 'view', viewId, event, args: sanitize(args) }),
      on: (event: string, fn: (...a: any[]) => void) => incoming.on(event, fn),
    };
    const viewDistance = 6;
    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, shim);
    shim.emit('version', bot.version);
    worldView.init(bot.entity.position).catch(() => undefined);
    worldView.listenToBot(bot);
    const onMove = () => {
      shim.emit('position', { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: bot.entity.pitch, addMesh: true });
      worldView.updatePosition(bot.entity.position).catch(() => undefined);
    };
    bot.on('move', onMove);
    onMove();
    this.views.set(viewId, { sessionId, worldView, incoming, onMove });
    s.views.add(viewId);
  }

  private detachView(viewId: string): void {
    const v = this.views.get(viewId);
    if (!v) return;
    this.views.delete(viewId);
    const s = this.sessions.get(v.sessionId);
    s?.views.delete(viewId);
    if (s) {
      s.bot.removeListener('move', v.onMove);
      try {
        v.worldView.removeListenersFromBot(s.bot);
      } catch {
        /* ignore */
      }
    }
  }
}

let viewerModule: any = null;
function requireViewer(): any {
  if (!viewerModule) {
    // Loaded lazily: the viewer code is only needed while a view is open.
    viewerModule = createRequire(import.meta.url)('prismarine-viewer/viewer/lib/worldView');
  }
  return viewerModule;
}

function sanitize(args: unknown[]): unknown[] {
  // Vec3 & friends → plain objects so they survive structured cloning.
  return JSON.parse(JSON.stringify(args));
}

function clampPitch(p: number): number {
  return Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function kickText(reason: unknown): string {
  if (typeof reason === 'string') {
    try {
      return flattenChat(JSON.parse(reason)).slice(0, 500) || reason.slice(0, 500);
    } catch {
      return reason.slice(0, 500);
    }
  }
  return flattenChat(reason).slice(0, 500);
}

function flattenChat(c: any): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(flattenChat).join('');
  if (typeof c === 'object') {
    let out = typeof c.text === 'string' ? c.text : c.translate ?? '';
    if (c.value && typeof c.value === 'object') out += flattenChat(c.value.text?.value ?? c.value);
    if (Array.isArray(c.extra)) out += c.extra.map(flattenChat).join('');
    if (Array.isArray(c.with)) out += ' ' + c.with.map(flattenChat).join(' ');
    return out;
  }
  return String(c);
}

function readThreadCount(): number | null {
  try {
    const status = fs.readFileSync(`/proc/${process.pid}/status`, 'utf8');
    const m = /^Threads:\s+(\d+)/m.exec(status);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
