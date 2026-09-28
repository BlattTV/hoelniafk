/**
 * Hoelni Agent – runs Minecraft sessions for the backend on this PC (household).
 *
 *   AgentCore ──wss──▶ backend AgentHub
 *      ├─ RuntimeHostCore (mineflayer sessions the backend assigns, through this PC's internet)
 *      └─ GameClientRuntime (optional: "Open game" for a session running here)
 *
 * The backend can only use what a runtime host offers: start/stop sessions, chat, takeover
 * for the game window. The household sees what runs and can pause at any time.
 */
import os from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import { GameClientRuntime } from '../client/gameClientRuntime.js';
import { createWindowController } from '../client/window.js';
import { mineflayerBotFactory } from '../minecraft/mineflayerBot.js';
import { RuntimeHostCore, type HostBotFactory } from '../runtime/host/hostCore.js';
import type { HostChannel, HostToMain, MainToHost } from '../runtime/protocol.js';
import type { RuntimeEvent } from '../runtime/types.js';
import { refuseReason } from './guard.js';
import { openWebSocket, type TransportOptions } from './transport.js';

export interface AgentConfig {
  backendUrl: string;
  token: string;
  agentId: number;
  name: string;
  transport: TransportOptions;
  dataDir: string;
  version?: string;
  /** Allow servers/proxies on private addresses (only for local tests – never in households). */
  allowPrivateTargets?: boolean;
}

export type AgentState = 'connecting' | 'online' | 'offline' | 'paused' | 'revoked';

export interface AgentStatus {
  state: AgentState;
  /** The account's manager is connected (only then sessions can run here). */
  managerOnline: boolean;
  backendUrl: string;
  name: string;
  since: string;
  lastError: string | null;
  sessions: Array<{ sessionId: string; server: string; username: string; phase: string }>;
  game: { sessionId: string; status: string } | null;
}

export class AgentCore {
  private ws: WebSocket | null = null;
  private core: RuntimeHostCore | null = null;
  private toCore: ((m: MainToHost) => void) | null = null;
  private game: GameClientRuntime | null = null;
  private retry = 1000;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly sessions = new Map<string, { server: string; username: string; phase: string }>();
  private gameInfo: AgentStatus['game'] = null;
  private readonly takeoverWaiters = new Set<(msg: HostToMain) => void>();
  /** Manager commands run strictly in order (each is checked asynchronously first). */
  private queue: Promise<void> = Promise.resolve();
  status: AgentStatus;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly onStatus: (s: AgentStatus) => void = () => undefined,
    private readonly botFactory: HostBotFactory = mineflayerBotFactory,
    private readonly gameOptions: { javaPath?: string; mirrors?: Record<string, string> } = {},
  ) {
    this.status = { state: 'connecting', managerOnline: false, backendUrl: cfg.backendUrl, name: cfg.name, since: new Date().toISOString(), lastError: null, sessions: [], game: null };
  }

  private set(state: AgentState, error: string | null = this.status.lastError): void {
    const changed = state !== this.status.state;
    this.status = {
      ...this.status,
      state,
      since: changed ? new Date().toISOString() : this.status.since,
      lastError: error,
      sessions: [...this.sessions].map(([sessionId, v]) => ({ sessionId, ...v })),
      game: this.gameInfo,
    };
    this.onStatus(this.status);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.status.state === 'paused' || this.status.state === 'revoked') return;
    this.set('connecting');
    let ws: WebSocket;
    try {
      ws = openWebSocket(this.cfg.backendUrl, this.cfg.token, this.cfg.transport);
    } catch (e) {
      this.scheduleReconnect((e as Error).message);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 1000;
      this.send({ t: 'hello', info: { version: this.cfg.version ?? '', os: `${os.platform()} ${os.release()}`, hostname: os.hostname(), node: process.version } });
      this.createCore();
      this.set('online', null);
    });
    ws.on('message', (data) => this.onFrame(String(data)));
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        this.set('revoked', 'The backend rejected this agent (signed out or access revoked) – sign in again');
        this.stopped = true;
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.disposeCore();
      if (this.status.state === 'online' || this.status.state === 'connecting') this.scheduleReconnect(this.status.lastError ?? 'Connection closed');
    });
    ws.on('error', (e) => {
      this.status.lastError = e.message;
    });
  }

  private scheduleReconnect(error: string): void {
    if (this.stopped) return;
    this.set('offline', error);
    clearTimeout(this.timer!);
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 60_000);
  }

  private send(frame: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private onFrame(text: string): void {
    let f: any;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    if (f?.t === 'bye') {
      if (/revoked|removed|signed out|disabled|deleted/i.test(String(f.reason))) {
        this.stopped = true;
        this.set('revoked', String(f.reason));
      } else this.status.lastError = String(f.reason);
      return;
    }
    if (f?.t === 'reset') {
      // The manager (re)connected or went away: start clean, it will assign the sessions again.
      this.createCore();
      this.set(this.status.state);
      return;
    }
    if (f?.t === 'manager') {
      this.status.managerOnline = !!f.online;
      this.set(this.status.state);
      return;
    }
    if (f?.t !== 'host' || !f.m || typeof f.m.cmd !== 'string') return;
    const m = f.m as MainToHost;
    this.queue = this.queue.then(() => this.handle(m)).catch(() => undefined);
  }

  private async handle(m: MainToHost): Promise<void> {
    if (m.cmd === 'start' || m.cmd === 'game.open') {
      const reason = this.status.state === 'paused' ? 'paused by the household' : await refuseReason(m, !!this.cfg.allowPrivateTargets);
      if (reason) {
        const sessionId = m.cmd === 'start' ? m.spec?.sessionId : m.sessionId;
        if (m.cmd === 'start') this.emitRuntime({ type: 'ended', sessionId: String(sessionId), reason: 'refused', kicked: false, error: `Agent refused: ${reason}` });
        else this.emitRuntime({ type: 'takeover', sessionId: String(sessionId), status: 'error', message: `Agent refused: ${reason}` });
        return;
      }
    } else if (await refuseReason(m, true)) return;
    if (m.cmd === 'start') this.sessions.set(m.spec.sessionId, { server: m.spec.server.name, username: m.spec.username, phase: 'starting' });
    if (m.cmd === 'game.open') return void this.openGame(m);
    if (m.cmd === 'game.close') return void this.closeGame(m.sessionId);
    if (m.cmd === 'game.show') return void this.game?.show(m.sessionId).catch(() => undefined);
    this.toCore?.(m);
    this.set(this.status.state);
  }

  private createCore(): void {
    this.disposeCore();
    const channel: HostChannel = {
      send: (msg: HostToMain) => {
        if (msg.evt === 'runtime') this.track(msg.event);
        for (const w of this.takeoverWaiters) w(msg);
        this.send({ t: 'host', m: msg });
      },
      onMessage: (l) => (this.toCore = l),
    };
    this.core = new RuntimeHostCore(channel, this.botFactory, { heartbeatMs: 5000 });
  }

  private disposeCore(): void {
    this.core?.dispose();
    this.core = null;
    this.toCore = null;
    this.sessions.clear();
    void this.game?.shutdown().catch(() => undefined);
    this.game = null;
    this.gameInfo = null;
  }

  private track(e: RuntimeEvent): void {
    const s = this.sessions.get(e.sessionId);
    if (e.type === 'phase' && s) s.phase = e.phase.toLowerCase();
    if (e.type === 'spawned' && s) s.username = e.username;
    if (e.type === 'ended') this.sessions.delete(e.sessionId);
    if (e.type === 'phase' || e.type === 'ended' || e.type === 'spawned') this.set(this.status.state);
  }

  private emitRuntime(event: RuntimeEvent): void {
    this.track(event);
    this.send({ t: 'host', m: { evt: 'runtime', event } satisfies HostToMain });
  }

  // ------------------------------------------------------------------ game window on this PC

  private gameRuntime(): GameClientRuntime {
    if (!this.game) {
      this.game = new GameClientRuntime({
        rootDir: path.join(this.cfg.dataDir, 'minecraft'),
        instancesDir: path.join(this.cfg.dataDir, 'instances'),
        javaPath: this.gameOptions.javaPath,
        mirrors: this.gameOptions.mirrors,
        authProvider: async () => {
          throw new Error('Agents launch the game in takeover mode only');
        },
        window: createWindowController(),
      });
      this.game.onEvent((e) => {
        if (e.type === 'game') {
          this.gameInfo = { sessionId: e.sessionId, status: e.game.status };
          this.emitRuntime(e);
        } else if (e.type === 'ended') {
          // The game window is gone: release the session back to AFK.
          this.gameInfo = null;
          this.toCore?.({ cmd: 'takeover.close', sessionId: e.sessionId, reason: 'Game closed' });
          this.emitRuntime({ type: 'takeover', sessionId: e.sessionId, status: 'detached', message: e.error ?? 'Game closed' });
          this.set(this.status.state);
        }
      });
    }
    return this.game;
  }

  private async openGame(m: Extract<MainToHost, { cmd: 'game.open' }>): Promise<void> {
    const game = this.gameRuntime();
    if (game.has(m.sessionId)) return void game.show(m.sessionId).catch(() => undefined);
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Session did not open the takeover endpoint')), 15_000);
      const check = (msg: HostToMain) => {
        if (msg.evt === 'runtime' && msg.event.type === 'takeover' && msg.event.sessionId === m.sessionId && (msg.event.status === 'ready' || msg.event.status === 'error')) {
          clearTimeout(t);
          this.takeoverWaiters.delete(check);
          if (msg.event.status === 'ready' && msg.event.port) resolve(msg.event.port);
          else reject(new Error(msg.event.message ?? 'Takeover failed'));
        }
      };
      this.takeoverWaiters.add(check);
      this.toCore?.({ cmd: 'takeover.open', sessionId: m.sessionId });
    }).catch((e) => {
      this.emitRuntime({ type: 'takeover', sessionId: m.sessionId, status: 'error', message: (e as Error).message });
      return null;
    });
    if (!port) return;
    const uuid = m.auth.uuid.replace(/-/g, '') || '00000000000000000000000000000000';
    await game.startSession({ spec: m.spec, settings: m.settings, visible: true, connect: { host: '127.0.0.1', port }, auth: { username: m.auth.username, uuid, accessToken: '0', userType: 'legacy' } }).catch((e) => {
      this.emitRuntime({ type: 'takeover', sessionId: m.sessionId, status: 'detached', message: `Game could not be started: ${(e as Error).message}` });
    });
  }

  private async closeGame(sessionId: string): Promise<void> {
    this.toCore?.({ cmd: 'takeover.close', sessionId, reason: 'Back to AFK' });
    await this.game?.stopSession(sessionId, 'Back to AFK');
  }

  // ------------------------------------------------------------------ household controls

  /** Stops all sessions on this PC and tells the backend not to place new ones. */
  pause(): void {
    if (this.status.state === 'paused') return;
    this.send({ t: 'paused', value: true });
    for (const id of [...this.sessions.keys()]) this.toCore?.({ cmd: 'stop', sessionId: id, reason: 'Paused by the household' });
    void this.game?.shutdown().catch(() => undefined);
    this.set('paused');
  }

  resume(): void {
    if (this.status.state !== 'paused') return;
    this.send({ t: 'paused', value: false });
    this.set(this.ws ? 'online' : 'offline');
    if (!this.ws) this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer!);
    for (const id of [...this.sessions.keys()]) this.toCore?.({ cmd: 'stop', sessionId: id, reason: 'Agent closed' });
    await new Promise((r) => setTimeout(r, this.sessions.size ? 1500 : 0));
    this.disposeCore();
    this.ws?.close();
  }
}
