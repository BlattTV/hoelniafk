/**
 * Session Manager with a desired-state reconciler.
 *
 *   Identity × Server assignment ── desired_state (ONLINE | OFFLINE)  ← user / bulk ops
 *                    │
 *        reconcile() every few seconds and after every runtime event
 *                    │
 *   SessionRecord (actual state) ──▶ MinecraftRuntime (supervised hosts)
 *
 * Per session: startSession / stopSession / reconnect / sendChat / getChat /
 * getState / openGame / closeGame.
 *
 * Two runtimes can own a session:
 *   lightweight – MineflayerRuntime (AFK, 50–100 sessions)
 *   game        – GameClientRuntime, the real Minecraft client in a normal window
 * "Open game" (default "takeover" mode) lets the real client take over the running
 * lightweight session's connection – no second login; leaving the game hands control
 * back to the AFK client. Fallbacks: "handover" (quick re-login) and "background"
 * (the game itself holds the session, minimized).
 *
 * A session that SHOULD be online and ends is brought back according to the
 * reconnect policy from rules.yaml (backoff, delay, or block for bans/whitelist).
 */
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { nowIso } from '../core/db.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { decideReconnect, parseChatLine, type RulesConfig } from '../core/rules.js';
import type { ChatLine, DesiredState, SessionInfo, SessionState } from '../core/types.js';
import { describeSchedule, nextScheduleChange, scheduleActive } from '../core/schedule.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { NetworkService } from '../network/networkService.js';
import type { GameInfo, MinecraftRuntime, RuntimeEvent, RuntimeSessionSpec, SessionStats } from '../runtime/types.js';
import type { GameClientRuntime } from '../client/gameClientRuntime.js';
import { versionFromKick } from '../client/instance.js';
import type { LinkingWorkflow } from './linking.js';
import type { RewardTracker } from './rewards.js';

const log = createLogger('sessions');

export interface SessionManagerOptions {
  reconcileIntervalMs: number;
  maxConcurrentStarts: number;
  /** How old a successful exit-IP check may be before a guarded start re-checks. */
  networkGuardMaxAgeMs: number;
  /** Retry delay while the network guard blocks a start. */
  networkGuardRetryMs: number;
  chatBuffer: number;
  connectTimeoutMs: number;
}

const DEFAULTS: SessionManagerOptions = {
  reconcileIntervalMs: 3000,
  maxConcurrentStarts: 4,
  networkGuardMaxAgeMs: 10 * 60_000,
  networkGuardRetryMs: 5 * 60_000,
  chatBuffer: 300,
  connectTimeoutMs: 90_000,
};

const ACTIVE: SessionState[] = ['STARTING', 'CONNECTING', 'AUTHENTICATING', 'ONLINE', 'STOPPING'];

/** Kick reasons that point at the chat packet itself (not a normal kick that happens to follow chat). */
const CHAT_KICK = /internal (server )?error|internal exception|chat|signature|profile (public )?key|message validation|decoderexception/i;

export class SessionRecord {
  state: SessionState = 'STOPPED';
  since = nowIso();
  lastError: string | null = null;
  lastEndReason: string | null = null;
  reconnects = 0;
  consecutiveFailures = 0;
  nextAttemptAt: number | null = null;
  onlineSince: number | null = null;
  networkProfileId: number | null = null;
  /** Runtime that currently owns the connection. */
  runtime: 'lightweight' | 'game' = 'lightweight';
  /** The user asked for the game window (handover mode). */
  wantGame = false;
  /** Game client is being prepared while the lightweight session still holds the account. */
  handoverPending = false;
  /** Live takeover: the game plays on this session's own connection. */
  takeover: 'none' | 'launching' | 'attached' = 'none';
  /** When the game joined the live session. */
  attachedAt = 0;
  /** Last chat message sent through the suite (a kick right after it points at chat signing). */
  lastChatAt = 0;
  /** Last incoming chat line (diagnosis). */
  lastChatInAt = 0;
  /** Last start failure written to the session log (logged once per distinct reason). */
  lastFailLogged: string | null = null;
  /** Live takeover failed for this session (reason) – the game opens with its own login instead. */
  takeoverBroken: string | null = null;
  uuid: string | null = null;
  /** "Start" outside the schedule: keep it online until this time (next schedule change). */
  scheduleOverrideUntil: number | null = null;
  game: GameInfo | null = null;
  stats: SessionStats | null = null;
  username: string | null = null;
  startedAt: number | null = null;
  /** Releases the concurrent-start slot taken by launch(). */
  releaseStart: (() => void) | null = null;
  readonly chat: ChatLine[] = [];
  /** Serialises start/stop/reconnect of this session. */
  lock: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly identityId: number,
    readonly serverId: number,
    public serverName: string,
  ) {}
}

export class SessionManager {
  private readonly records = new Map<string, SessionRecord>();
  private game: GameClientRuntime | null = null;
  private offGame: (() => void) | null = null;
  private readonly opts: SessionManagerOptions;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private reconcileAgain = false;
  private startsInFlight = 0;
  private chatQueue: Array<{ ts: string; sessionId: string; identityId: number; serverId: number; text: string }> = [];
  private chatTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly offRuntime: () => void;

  /** Macros of a session (macro builder) – set by the app. */
  macrosFor: ((identityId: number, serverId: number) => import('../macros/types.js').MacroProgram[]) | null = null;

  /** Renews the Minecraft session of an identity (fresh token + chat keys) – set by the app. */
  renewAuth: ((identityId: number) => Promise<void>) | null = null;

  constructor(
    private readonly repo: IdentityRepository,
    private readonly network: NetworkService,
    private readonly runtime: MinecraftRuntime,
    private readonly linking: LinkingWorkflow,
    private readonly rewards: RewardTracker,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly getRules: () => RulesConfig,
    opts: Partial<SessionManagerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.offRuntime = runtime.onEvent((e) => this.onRuntimeEvent('lightweight', e));
  }

  /** Enables "Open game" with the real Minecraft client. */
  attachGameClient(game: GameClientRuntime): void {
    this.game = game;
    this.offGame = game.onEvent((e) => this.onRuntimeEvent('game', e));
  }

  get gameClientAvailable(): boolean {
    return !!this.game;
  }

  static sessionId(identityId: number, serverId: number): string {
    return `${identityId}:${serverId}`;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Starts the reconciler loop (restores desired sessions after a restart). */
  startReconciler(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.opts.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
    void this.reconcile();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.flushChat();
    // Desired state is kept on purpose: sessions are restored on the next start.
    await Promise.all([this.runtime.shutdown(), this.game?.shutdown()]);
    this.offRuntime();
    this.offGame?.();
  }

  // ------------------------------------------------------------------ records

  private record(identityId: number, serverId: number): SessionRecord {
    const id = SessionManager.sessionId(identityId, serverId);
    let r = this.records.get(id);
    if (!r) {
      r = new SessionRecord(id, identityId, serverId, this.repo.getServer(serverId).name);
      this.records.set(id, r);
    }
    return r;
  }

  private info(r: SessionRecord): SessionInfo {
    const a = this.repo.getAssignment(r.identityId, r.serverId);
    return {
      id: r.id,
      identityId: r.identityId,
      serverId: r.serverId,
      serverName: r.serverName,
      networkProfileId: r.networkProfileId,
      desiredState: a?.desiredState ?? 'OFFLINE',
      state: r.state,
      since: r.since,
      lastError: r.lastError,
      lastEndReason: r.lastEndReason,
      reconnects: r.reconnects,
      consecutiveFailures: r.consecutiveFailures,
      nextAttemptAt: r.nextAttemptAt ? new Date(r.nextAttemptAt).toISOString() : null,
      onlineSince: r.onlineSince ? new Date(r.onlineSince).toISOString() : null,
      runtime: r.runtime === 'game' ? 'game' : 'lightweight',
      takeover: r.takeover,
      game: r.game,
      schedule: a?.schedule?.enabled
        ? {
            text: describeSchedule(a.schedule),
            active: scheduleActive(a.schedule),
            override: this.overrideActive(r),
            nextChange: nextScheduleChange(a.schedule)?.toISOString() ?? null,
          }
        : null,
      stats: r.stats,
      username: r.username,
    };
  }

  /** All sessions (also the ones that only exist as desired state). */
  list(identityId?: number): SessionInfo[] {
    for (const a of this.repo.listAssignments(identityId)) {
      if (a.desiredState === 'ONLINE' || this.records.has(SessionManager.sessionId(a.identityId, a.serverId))) this.record(a.identityId, a.serverId);
    }
    return [...this.records.values()]
      .filter((r) => identityId === undefined || r.identityId === identityId)
      .filter((r) => this.repo.getAssignment(r.identityId, r.serverId) || ACTIVE.includes(r.state))
      .map((r) => this.info(r));
  }

  get(sessionId: string): SessionRecord {
    const r = this.records.get(sessionId);
    if (!r) throw new NotFoundError(`Session ${sessionId} not found`);
    return r;
  }

  /**
   * "Run on" of an identity changed (this PC ↔ agent): running sessions move there now – stopped here
   * first (never two logins at once), then started at the new place. Waiting ones retry right away.
   */
  async placementChanged(identityId: number): Promise<void> {
    const agentId = this.repo.getIdentity(identityId).settings.agentId ?? null;
    let where = 'this PC';
    if (agentId !== null) where = `agent #${agentId}`;
    for (const r of [...this.records.values()].filter((x) => x.identityId === identityId)) {
      const a = this.repo.getAssignment(r.identityId, r.serverId);
      if (!a?.enabled || a.desiredState !== 'ONLINE') continue;
      const onAgent = !!this.runtime.isRemoteSession?.(r.id);
      const active = ACTIVE.includes(r.state) && r.state !== 'STOPPING';
      if (active && onAgent === (agentId !== null)) continue; // already there
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'move', `Moving the session to ${where}`);
      await this.withLock(r, async () => {
        if (r.takeover !== 'none') await this.closeGame(r.id).catch(() => undefined);
        if (ACTIVE.includes(r.state)) await this.halt(r, `Moving to ${where}`, true);
        r.consecutiveFailures = 0;
        r.nextAttemptAt = Date.now();
        r.lastFailLogged = null;
        if (r.state === 'BLOCKED') this.setState(r, 'STOPPED');
      });
    }
    void this.reconcile();
  }

  /** An agent came online or was resumed: sessions waiting for it retry right away instead of after their backoff. */
  agentAvailable(agentId: number): void {
    for (const r of this.records.values()) {
      if (r.state !== 'RECONNECTING') continue;
      if (this.repo.getIdentity(r.identityId).settings.agentId !== agentId) continue;
      r.nextAttemptAt = Date.now();
      r.consecutiveFailures = 0;
    }
  }

  getState(sessionId: string): SessionInfo {
    return this.info(this.get(sessionId));
  }

  getChat(sessionId: string, opts: { limit?: number; before?: number } = {}): ChatLine[] {
    const r = this.records.get(sessionId);
    this.flushChat();
    const rows = this.repo.chatLog({ sessionId, limit: opts.limit ?? 200, before: opts.before });
    if (rows.length || !r) return rows.map((x) => ({ ts: x.ts, sessionId: x.sessionId, identityId: x.identityId, serverId: x.serverId, text: x.text }));
    return r.chat.slice(-(opts.limit ?? 200));
  }

  /** Backwards-compatible alias. */
  chat(sessionId: string, limit = 100): ChatLine[] {
    return this.getChat(sessionId, { limit });
  }

  private setState(r: SessionRecord, state: SessionState, error?: string | null): void {
    const changed = r.state !== state;
    r.state = state;
    if (changed) r.since = nowIso();
    if (error !== undefined) r.lastError = error;
    if (changed) {
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, `state:${state}`, error ?? '');
      const l = log.with({ identityId: r.identityId, sessionId: r.id });
      if (state === 'BLOCKED') l.warn(`${r.serverName}: ${state}${error ? ` – ${error}` : ''}`);
      else l.info(`${r.serverName}: ${state}${error ? ` – ${error}` : ''}`);
    }
    this.bus.emit({ type: 'session.state', identityId: r.identityId, data: this.info(r) });
  }

  private withLock<T>(r: SessionRecord, fn: () => Promise<T>): Promise<T> {
    const next = r.lock.then(fn, fn);
    r.lock = next.catch(() => undefined);
    return next;
  }

  // ------------------------------------------------------------------ desired state

  setDesired(identityId: number, serverId: number, desired: DesiredState): SessionInfo {
    const a = this.repo.getAssignment(identityId, serverId);
    if (!a) throw new ValidationError('Identity is not assigned to this server');
    if (!a.enabled && desired === 'ONLINE') throw new ValidationError('Server assignment is disabled');
    if (a.desiredState !== desired) {
      this.repo.setDesiredState(identityId, serverId, desired);
      this.audit.record(identityId, `Session desired ${desired.toLowerCase()}`, { server: this.repo.getServer(serverId).name });
    }
    const r = this.record(identityId, serverId);
    if (desired === 'ONLINE' && (r.state === 'BLOCKED' || r.state === 'RECONNECTING')) {
      // Explicit user intent overrides backoff and blocks.
      r.consecutiveFailures = 0;
      r.nextAttemptAt = null;
      this.setState(r, 'STOPPED', null);
    }
    void this.reconcile();
    return this.info(r);
  }

  private overrideActive(r: SessionRecord): boolean {
    if (r.scheduleOverrideUntil === null) return false;
    if (Date.now() < r.scheduleOverrideUntil) return true;
    r.scheduleOverrideUntil = null;
    return false;
  }

  /** Should this assignment be online right now (desired state + schedule + manual override)? */
  private wantsOnline(a: { enabled: boolean; desiredState: DesiredState; schedule: import('../core/schedule.js').WeekSchedule | null }, r: SessionRecord): boolean {
    if (!a.enabled || a.desiredState !== 'ONLINE') return false;
    if (scheduleActive(a.schedule)) {
      r.scheduleOverrideUntil = null;
      return true;
    }
    // Someone is playing in the real game: never cut them off because a schedule window ended.
    if (r.takeover !== 'none' || (r.runtime === 'game' && r.wantGame)) return true;
    return this.overrideActive(r);
  }

  /** startSession(): desired ONLINE and start now (also outside its schedule, until the next schedule change). */
  async startSession(identityId: number, serverId: number): Promise<SessionInfo> {
    this.setDesired(identityId, serverId, 'ONLINE');
    const r = this.record(identityId, serverId);
    const a = this.repo.getAssignment(identityId, serverId);
    if (a?.schedule?.enabled && !scheduleActive(a.schedule)) {
      r.scheduleOverrideUntil = nextScheduleChange(a.schedule)?.getTime() ?? Date.now() + 3600_000;
      this.repo.addSessionEvent(identityId, serverId, r.id, 'schedule-override', `until ${new Date(r.scheduleOverrideUntil).toISOString()}`);
    }
    await this.withLock(r, async () => {
      if (!ACTIVE.includes(r.state)) await this.launch(r);
    });
    return this.info(r);
  }

  /** Backwards compatible name used by bulk operations & tests. */
  async start(identityId: number, serverId: number): Promise<SessionInfo> {
    return this.startSession(identityId, serverId);
  }

  async stopSession(sessionId: string): Promise<SessionInfo> {
    const r = this.get(sessionId);
    if (this.repo.getAssignment(r.identityId, r.serverId)) this.setDesired(r.identityId, r.serverId, 'OFFLINE');
    r.takeoverBroken = null; // stopped by the user: the next start tries live takeover again
    await this.withLock(r, () => this.halt(r, 'Stopped by user'));
    return this.info(r);
  }

  stop(sessionId: string): SessionInfo {
    void this.stopSession(sessionId);
    return this.info(this.get(sessionId));
  }

  async reconnect(sessionId: string): Promise<SessionInfo> {
    const r = this.get(sessionId);
    if (this.repo.getAssignment(r.identityId, r.serverId)?.desiredState !== 'ONLINE') {
      this.setDesired(r.identityId, r.serverId, 'ONLINE');
    }
    await this.withLock(r, async () => {
      if (ACTIVE.includes(r.state)) await this.halt(r, 'Reconnect', true);
      r.consecutiveFailures = 0;
      r.reconnects++;
      await this.launch(r);
    });
    return this.info(r);
  }

  async startAll(identityId: number, onlyAutoStart = false): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    for (const a of this.repo.listAssignments(identityId)) {
      if (!a.enabled || (onlyAutoStart && !a.autoStart)) continue;
      out.push(await this.startSession(identityId, a.serverId));
    }
    return out;
  }

  stopAll(identityId?: number): void {
    for (const a of this.repo.listAssignments(identityId)) {
      if (a.desiredState === 'ONLINE') this.repo.setDesiredState(a.identityId, a.serverId, 'OFFLINE');
    }
    for (const r of this.records.values()) {
      if (identityId !== undefined && r.identityId !== identityId) continue;
      if (ACTIVE.includes(r.state) || r.state === 'RECONNECTING' || r.state === 'BLOCKED') void this.withLock(r, () => this.halt(r, 'Stopped by user'));
    }
  }

  forgetIdentity(identityId: number): void {
    for (const [id, r] of this.records) {
      if (r.identityId !== identityId) continue;
      if (ACTIVE.includes(r.state)) void this.runtimeOf(r).stopSession(id, 'identity deleted').catch(() => undefined);
      if (this.game?.has(id)) void this.game.stopSession(id, 'identity deleted');
      this.records.delete(id);
    }
  }

  // ------------------------------------------------------------------ reconciler

  async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.reconciling) {
      this.reconcileAgain = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.reconcileAgain = false;
        await this.reconcileOnce();
      } while (this.reconcileAgain && !this.stopped);
    } catch (e) {
      log.error(`Reconcile failed: ${(e as Error).message}`);
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const now = Date.now();
    const assignments = this.repo.listAssignments();
    const wanted = new Set<string>();
    for (const a of assignments) {
      const id = SessionManager.sessionId(a.identityId, a.serverId);
      if (!a.enabled || a.desiredState !== 'ONLINE') continue;
      const r = this.record(a.identityId, a.serverId);
      if (!this.wantsOnline(a, r)) continue; // outside its schedule → stopped below
      wanted.add(id);
      if (ACTIVE.includes(r.state) || r.state === 'BLOCKED') {
        // Connect watchdog: a session stuck before ONLINE is restarted.
        if ((r.state === 'CONNECTING' || r.state === 'AUTHENTICATING') && r.startedAt && now - r.startedAt > this.opts.connectTimeoutMs) {
          r.lastError = 'Connect timeout';
          void this.runtimeOf(r).stopSession(r.id, 'connectTimeout').catch(() => undefined);
        }
        continue;
      }
      if (r.state === 'RECONNECTING' && r.nextAttemptAt && r.nextAttemptAt > now) continue;
      if (this.startsInFlight >= this.opts.maxConcurrentStarts) continue;
      void this.withLock(r, async () => {
        if (!ACTIVE.includes(r.state) && r.state !== 'BLOCKED') {
          if (r.state === 'RECONNECTING') r.reconnects++;
          await this.launch(r);
        }
      });
    }
    // Everything running that is not wanted (desired OFFLINE, unassigned, disabled) is stopped.
    for (const r of this.records.values()) {
      if (wanted.has(r.id)) continue;
      const a = this.repo.getAssignment(r.identityId, r.serverId);
      const why = a?.enabled && a.desiredState === 'ONLINE' ? 'Outside schedule' : 'Desired state offline';
      if (ACTIVE.includes(r.state) && r.state !== 'STOPPING') void this.withLock(r, () => this.halt(r, why));
      else if (r.state === 'RECONNECTING' || r.state === 'BLOCKED') this.setState(r, 'STOPPED');
    }
  }

  // ------------------------------------------------------------------ start / stop

  /** Builds the runtime spec. Throws on any cross-identity resource. */
  async buildSpec(r: SessionRecord): Promise<RuntimeSessionSpec> {
    const a = this.repo.getAssignment(r.identityId, r.serverId);
    if (!a) throw new ValidationError('Identity is not assigned to this server');
    if (!a.enabled) throw new ValidationError('Server assignment is disabled');
    const mc = this.repo.getMinecraft(r.identityId);
    if (!mc) throw new ValidationError('No Minecraft account configured for this identity');
    if (mc.authType === 'microsoft' && !mc.msaAccount) throw new ValidationError('Microsoft account e-mail missing');
    const identity = this.repo.getIdentity(r.identityId);
    const server = this.repo.getServer(r.serverId);
    r.serverName = server.name;
    const network = await this.network.resolve(r.identityId, a.networkProfileId);
    const s = identity.settings;
    return {
      sessionId: r.id,
      identityId: r.identityId,
      server: { id: server.id, name: server.name, host: server.host, port: server.port, version: server.version || (await this.autoVersion(r, server, network)) || null },
      username: mc.authType === 'microsoft' ? mc.msaAccount! : mc.username,
      auth: mc.authType,
      network,
      afk: s.afk,
      lightweight: s.lightweight,
      viewDistance: s.viewDistance,
      takeover: (!!this.game || s.agentId !== null) && s.gameClient.mode === 'takeover',
      placement: s.agentId !== null && s.agentId !== undefined ? { agentId: s.agentId } : null,
      macros: this.macrosFor?.(r.identityId, r.serverId) ?? [],
      unsignedChat: this.repo.getSetting(`server.${server.id}.unsignedChat`) === '1',
      // the AFK session reports the same client as the identity's game window
      brand: s.gameClient.loader === 'fabric' ? 'fabric' : 'vanilla',
    };
  }

  /**
   * Version detection (production): a server behind Velocity/BungeeCord mirrors whatever version it
   * is asked with, so "auto" would pick the newest version the library knows – and chat / the game
   * window then break. Detected once per server (cached), corrected from "Outdated client" kicks.
   */
  detectVersion: ((host: string, port: number, network: RuntimeSessionSpec['network']) => Promise<{ version: string | null; proxy: boolean; name: string }>) | null = null;
  proxyFallbackVersion = '1.21.1';
  private readonly versionCache = new Map<number, { version: string | undefined; at: number }>();

  private async autoVersion(r: SessionRecord, server: { id: number; host: string; port: number }, network: RuntimeSessionSpec['network']): Promise<string | undefined> {
    const learned = this.repo.getSetting(`server.${server.id}.learnedVersion`);
    if (learned) return learned;
    if (!this.detectVersion) return undefined;
    const hit = this.versionCache.get(server.id);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.version;
    let version: string | undefined;
    try {
      const d = await this.detectVersion(server.host, server.port, network);
      version = d.version ?? (d.proxy ? this.proxyFallbackVersion : undefined);
      if (d.proxy) {
        this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'version', `Proxy detected (${d.name || 'no name'}) – using ${version}; set the exact server version under Advanced → Servers if it differs`);
      }
    } catch {
      version = undefined; // ping failed – the connection itself will report the problem
    }
    this.versionCache.set(server.id, { version, at: Date.now() });
    return version;
  }

  /**
   * Kicked right after sending chat (e.g. "An internal error occurred in your connection" behind
   * Velocity/ViaVersion): switch this server to unsigned chat. If that gets kicked as well, switch back
   * – it was not the signature.
   */
  private adjustChatMode(r: SessionRecord, reason: string | null | undefined): boolean {
    r.lastChatAt = 0;
    const key = `server.${r.serverId}.unsignedChat`;
    const cur = this.repo.getSetting(key);
    if (cur === 'x') return false; // both tried – the problem is elsewhere
    const unsigned = cur === '1';
    this.repo.setSetting(key, unsigned ? 'x' : '1');
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'chat-mode',
      unsigned ? `Kicked after chat again (${reason ?? ''}) – unsigned chat did not help, signed chat again` : `Kicked right after chatting (${reason ?? ''}) – sending chat without signature from now on`);
    this.audit.record(r.identityId, unsigned ? 'Chat signing switched back on' : 'Chat switched to unsigned', { server: r.serverName });
    return true;
  }

  /** The server told us which version it wants ("Outdated client! Please use 1.21.4"): remember it. */
  private learnVersion(r: SessionRecord, text: string | null | undefined): boolean {
    const server = this.repo.getServer(r.serverId);
    if (server.version) return false; // fixed by the user
    const v = versionFromKick(text);
    if (!v || v === this.repo.getSetting(`server.${server.id}.learnedVersion`)) return false;
    this.repo.setSetting(`server.${server.id}.learnedVersion`, v);
    this.versionCache.delete(server.id);
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'version', `Server wants Minecraft ${v} – using it from now on`);
    this.audit.record(r.identityId, 'Server version learned', { server: server.name, version: v });
    return true;
  }

  /** Network guard: verifies the exit IP before a session starts (setting per identity). */
  private async networkGuard(r: SessionRecord, spec: RuntimeSessionSpec): Promise<string | null> {
    const guard = this.repo.getIdentity(r.identityId).settings.networkGuard;
    const p = spec.network.profile;
    if (guard === 'off' || !p || !p.expectedPublicIp) return null;
    const fresh = p.checkStatus === 'OK' && p.lastCheckedAt && Date.now() - Date.parse(p.lastCheckedAt) < this.opts.networkGuardMaxAgeMs;
    let status = p.checkStatus;
    let detail = p.lastError;
    if (!fresh) {
      const checked = await this.network.verify(r.identityId, p.id);
      status = checked?.checkStatus ?? 'ERROR';
      detail = checked?.lastError ?? null;
    }
    if (status === 'OK') return null;
    const msg = `Network guard: exit IP ${status === 'MISMATCH' ? 'mismatch' : 'check failed'} (${detail ?? status})`;
    if (guard === 'block') return msg;
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'network-warning', msg);
    return null;
  }

  private async launch(r: SessionRecord): Promise<void> {
    if (this.stopped) return;
    this.startsInFlight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.startsInFlight--;
      }
    };
    try {
      this.setState(r, 'STARTING', null);
      let spec: RuntimeSessionSpec;
      try {
        spec = await this.buildSpec(r);
      } catch (e) {
        this.fail(r, (e as Error).message, 'block');
        release();
        return;
      }
      r.networkProfileId = spec.network.profile?.id ?? null;
      const blocked = await this.networkGuard(r, spec);
      if (blocked) {
        this.audit.record(r.identityId, 'Session start blocked by network guard', { server: r.serverName });
        r.nextAttemptAt = Date.now() + this.opts.networkGuardRetryMs;
        this.setState(r, 'RECONNECTING', blocked);
        release();
        return;
      }
      r.startedAt = Date.now();
      r.onlineSince = null;
      this.setState(r, 'CONNECTING');
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'start', `network=${spec.network.profile?.name ?? 'direct'}`);
      r.releaseStart = release;
      r.runtime = this.chooseRuntime(r);
      if (r.runtime === 'game') {
        r.handoverPending = false;
        await this.game!.startSession({ spec, settings: this.gameSettings(r), visible: r.wantGame });
        this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-start', r.wantGame ? 'visible' : 'background');
      } else await this.runtime.startSession(spec);
      // Release the start slot once the session is online or failed (handled in events), or after a timeout.
      setTimeout(release, this.opts.connectTimeoutMs).unref?.();
    } catch (e) {
      release();
      this.fail(r, (e as Error).message, 'retry');
    }
  }

  private fail(r: SessionRecord, message: string, kind: 'retry' | 'block'): void {
    r.lastError = message.slice(0, 500);
    // Why a start does not happen (agent offline/paused, missing account …) – once per distinct reason.
    if (r.lastFailLogged !== r.lastError) {
      r.lastFailLogged = r.lastError;
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'start-failed', r.lastError);
    }
    if (kind === 'block') {
      this.setState(r, 'BLOCKED', r.lastError);
      return;
    }
    r.consecutiveFailures++;
    const d = decideReconnect(this.getRules().reconnect, message, r.consecutiveFailures);
    r.nextAttemptAt = Date.now() + d.delaySec * 1000;
    this.setState(r, d.action === 'block' ? 'BLOCKED' : 'RECONNECTING', r.lastError);
  }

  private async halt(r: SessionRecord, reason: string, keepDesired = false): Promise<void> {
    if (r.handoverPending) await this.game?.stopSession(r.id, reason);
    if (r.takeover !== 'none') {
      r.takeover = 'none';
      await this.game?.stopSession(r.id, reason);
    }
    if (!ACTIVE.includes(r.state)) {
      if (!keepDesired && r.state !== 'STOPPED') this.setState(r, 'STOPPED');
      return;
    }
    this.setState(r, 'STOPPING');
    await this.runtimeOf(r).stopSession(r.id, reason);
    if (r.state === 'STOPPING') this.setState(r, 'STOPPED');
  }

  // ------------------------------------------------------------------ runtime events

  private runtimeOf(r: SessionRecord): { stopSession(id: string, reason?: string): Promise<void> } {
    return r.runtime === 'game' && this.game ? this.game : this.runtime;
  }

  private gameSettings(r: SessionRecord) {
    return this.repo.getIdentity(r.identityId).settings.gameClient;
  }

  /** Which runtime should hold this session when it is (re)started. */
  private chooseRuntime(r: SessionRecord): 'lightweight' | 'game' {
    if (!this.game) return 'lightweight';
    const mode = this.gameSettings(r).mode;
    const onAgent = this.placedOnAgent(r);
    if (mode === 'background' && !onAgent) return 'game';
    // An identity that runs on an agent is played on THIS PC with its own login while the game is open.
    return r.wantGame && (mode === 'handover' || onAgent) ? 'game' : 'lightweight';
  }

  /** "Run on" of the identity is an agent (another PC). */
  private placedOnAgent(r: SessionRecord): boolean {
    return this.repo.getIdentity(r.identityId).settings.agentId != null;
  }

  private onRuntimeEvent(source: 'lightweight' | 'game', e: RuntimeEvent): void {
    const r = this.records.get(e.sessionId);
    if (!r) return;
    if (e.type === 'game') {
      const before = r.game;
      // Start progress in the session log: shows where a start that "does nothing" stops.
      const stage = (g: typeof e.game | null) => (g ? `${g.status}|${g.status === 'installing' ? (g.message ?? '').replace(/\s*\d.*$/, '') : g.message ?? ''}` : '');
      if (stage(e.game) !== stage(before) && e.game.status !== 'closed') {
        const detail = [e.game.status === 'starting' && e.game.pid ? `pid ${e.game.pid}` : null, e.game.message, e.game.version].filter(Boolean).join(' · ');
        this.repo.addSessionEvent(r.identityId, r.serverId, r.id, `game-${e.game.status}`, detail.slice(0, 300));
      }
      r.game = e.game;
      this.bus.emit({ type: 'session.game', identityId: r.identityId, data: { sessionId: r.id, game: e.game } });
      this.bus.emit({ type: 'session.state', identityId: r.identityId, data: this.info(r) });
      return;
    }
    if (source === 'game' && r.handoverPending && e.type === 'ended') {
      // The game never reached the server – the lightweight session still holds the account.
      r.handoverPending = false;
      r.wantGame = false;
      if (e.reason === 'Cancelled') {
        this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-cancelled');
        this.setState(r, r.state);
        return;
      }
      r.lastError = `Game could not be started: ${e.error ?? e.reason}`.slice(0, 500);
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-failed', r.lastError);
      this.setState(r, r.state, r.lastError);
      return;
    }
    if (e.type === 'takeover') {
      this.onTakeoverEvent(r, e);
      return;
    }
    if (source === 'game' && r.takeover !== 'none' && e.type === 'ended') {
      // The game (attached to or launching for the live session) is gone – the AFK client continues.
      const wasLaunching = r.takeover === 'launching';
      r.takeover = 'none';
      r.wantGame = false;
      void this.runtime.closeTakeover(r.id, 'Game closed').catch(() => undefined);
      if (e.reason === 'launchFailed' || e.reason === 'connectFailed') {
        r.lastError = `Game could not be started: ${e.error ?? e.reason}`.slice(0, 500);
        this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-failed', r.lastError);
      } else this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-closed', e.error ?? '');
      this.setState(r, r.state, e.reason === 'launchFailed' || e.reason === 'connectFailed' ? r.lastError : undefined);
      // The game crashed while entering / right after entering the live session: open it with its own login.
      const crashed = e.reason === 'clientExited' && /\(exit (?!0\))/.test(e.error ?? '');
      const failedToEnter = wasLaunching && e.reason === 'connectFailed';
      if ((failedToEnter || (crashed && (wasLaunching || Date.now() - r.attachedAt < 60_000))) && !this.stopped) void this.fallbackToHandover(r, e.error ?? 'game crashed', false);
      return;
    }
    if (source === 'lightweight' && r.handoverPending && e.type === 'ended') {
      // The lightweight session dropped while the game was still starting: the game takes over directly.
      r.handoverPending = false;
      r.runtime = 'game';
      this.setState(r, 'CONNECTING', e.error ?? e.reason);
      return;
    }
    if (source !== r.runtime) return; // late events of the runtime that handed the session over
    switch (e.type) {
      case 'phase':
        if (r.state === 'STOPPING') return;
        if (e.phase === 'ONLINE') {
          r.onlineSince = Date.now();
          r.lastFailLogged = null;
          r.releaseStart?.();
          this.setState(r, 'ONLINE', null);
        } else this.setState(r, e.phase);
        return;
      case 'spawned':
        r.username = e.username;
        r.uuid = e.uuid;
        return;
      case 'stats':
        r.stats = e.stats;
        this.bus.emit({ type: 'session.stats', identityId: r.identityId, data: { sessionId: r.id, stats: e.stats } });
        return;
      case 'chat':
        this.onChat(r, e.text, e.ts);
        return;
      case 'note':
        this.repo.addSessionEvent(r.identityId, r.serverId, r.id, e.kind.slice(0, 40), e.detail.slice(0, 500));
        return;
      case 'ended':
        this.onEnded(r, e);
        return;
    }
  }

  private onTakeoverEvent(r: SessionRecord, e: Extract<RuntimeEvent, { type: 'takeover' }>): void {
    if (e.status === 'attached') {
      r.takeover = 'attached';
      r.attachedAt = Date.now();
      this.game?.notifyJoined(r.id);
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-attached', 'live takeover');
      this.setState(r, r.state);
    } else if (e.status === 'error' && r.takeover === 'launching') {
      r.takeover = 'none';
      r.wantGame = false;
      r.lastError = `Game could not be opened: ${e.message ?? 'takeover failed'}`;
      this.setState(r, r.state, r.lastError);
    } else if (e.status === 'parked') {
      // The live session is reconnecting (expired session renewed, server restart …): the game waits.
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-parked', e.message ?? '');
      this.setState(r, r.state);
    } else if (e.status === 'closed' && r.takeover !== 'none' && r.state !== 'ONLINE') {
      // A parked game gave up waiting (session did not come back in time).
      r.takeover = 'none';
      r.wantGame = false;
      if (this.game?.has(r.id)) void this.game.stopSession(r.id, 'Session did not come back');
      this.setState(r, r.state);
    } else if (e.status === 'detached') {
      if (r.takeover === 'none') return; // closed by us ("Back to AFK")
      // The game left the session (quit to title, closed, kicked, error): the AFK client carries on.
      const early = Date.now() - r.attachedAt < 30_000;
      r.takeover = 'none';
      r.wantGame = false;
      void this.runtime.closeTakeover(r.id, 'Back to AFK').catch(() => undefined);
      // The game writes its reason to latest.log a moment later.
      setTimeout(() => {
        const why = this.game?.diagnosis(r.id) ?? null;
        this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-detached', [e.message, why].filter(Boolean).join(' – ').slice(0, 500));
        const normalQuit = !why || /quitting|^closed$|^disconnected$/i.test(why);
        if (early && !normalQuit && this.game?.has(r.id)) {
          // Live takeover does not work with this server (e.g. a proxy/translation layer sends packets
          // the game rejects): open the game with its own login instead – for the rest of this session.
          void this.fallbackToHandover(r, why!, true);
          return;
        }
        if (this.game?.has(r.id)) void this.game.stopSession(r.id, 'Back to AFK');
        this.setState(r, r.state);
      }, 1200);
    }
  }

  private onEnded(r: SessionRecord, e: Extract<RuntimeEvent, { type: 'ended' }>): void {
    r.releaseStart?.();
    // A game on the live session stays connected ("parked") while the session reconnects; it is
    // switched into the new connection automatically. It only ends if the session does not come back.
    const detail = [e.error, e.reason].filter(Boolean).join(' | ');
    r.lastEndReason = e.reason;
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, e.kicked ? 'kicked' : 'ended', detail);
    r.stats = null;
    if (r.runtime !== 'game' && e.kicked && Date.now() - r.lastChatAt < 5000 && CHAT_KICK.test(e.error ?? '') && this.adjustChatMode(r, e.error)) {
      const a2 = this.repo.getAssignment(r.identityId, r.serverId);
      if (a2?.enabled && a2.desiredState === 'ONLINE' && r.state !== 'STOPPING' && !this.stopped) {
        r.nextAttemptAt = Date.now();
        this.setState(r, 'RECONNECTING', e.error);
        void this.reconcile();
        return;
      }
    }
    if (r.runtime !== 'game' && this.learnVersion(r, e.error)) {
      // wrong version: reconnect right away with the one the server asked for
      const a1 = this.repo.getAssignment(r.identityId, r.serverId);
      if (a1?.enabled && a1.desiredState === 'ONLINE' && r.state !== 'STOPPING' && !this.stopped) {
        r.nextAttemptAt = Date.now();
        this.setState(r, 'RECONNECTING', e.error);
        void this.reconcile();
        return;
      }
    }
    const fromGame = r.runtime === 'game';
    if (fromGame) {
      r.runtime = 'lightweight';
      if (r.wantGame && e.reason === 'clientExited' && r.state !== 'STOPPING') {
        // The user closed the game window: back to AFK right away.
        r.wantGame = false;
        const a0 = this.repo.getAssignment(r.identityId, r.serverId);
        if (a0?.enabled && a0.desiredState === 'ONLINE' && !this.stopped && (this.gameSettings(r).mode === 'handover' || this.placedOnAgent(r))) {
          r.consecutiveFailures = 0;
          r.onlineSince = null;
          r.nextAttemptAt = Date.now();
          this.setState(r, 'RECONNECTING', null);
          void this.reconcile();
          return;
        }
      }
      if (e.reason !== 'clientExited') r.wantGame = false;
    }
    const a = this.repo.getAssignment(r.identityId, r.serverId);
    const desiredOnline = !!a && a.enabled && a.desiredState === 'ONLINE';
    if (r.state === 'STOPPING' || !desiredOnline || this.stopped) {
      this.endParkedGame(r, 'Session ended');
      this.setState(r, 'STOPPED', r.state === 'STOPPING' ? null : e.error);
      return;
    }
    if (e.reason === 'refused' && !/paused/i.test(e.error ?? '')) {
      // The agent's own safety checks refused this session (e.g. a private server address): retrying
      // cannot help until the setup is changed – stop and say why instead of looping.
      r.lastError = (e.error ?? 'Agent refused the session').slice(0, 500);
      this.audit.record(r.identityId, 'Session refused by the agent', { server: r.serverName, reason: r.lastError });
      this.setState(r, 'BLOCKED', `${r.lastError} – change the setup, then start the session again`);
      return;
    }
    const policy = this.getRules().reconnect;
    const wasStable = r.onlineSince !== null && Date.now() - r.onlineSince > policy.stableAfterSec * 1000;
    r.consecutiveFailures = wasStable ? 1 : r.consecutiveFailures + 1;
    r.onlineSince = null;
    const decision = decideReconnect(policy, detail, r.consecutiveFailures, e.reason === 'runtimeCrash');
    r.lastError = (e.error ?? e.reason).slice(0, 500);
    if (decision.action === 'block') {
      this.audit.record(r.identityId, 'Automatic reconnect blocked', { server: r.serverName, rule: decision.label });
      this.setState(r, 'BLOCKED', `${decision.label}: ${r.lastError}`);
      this.endParkedGame(r, `Session blocked: ${decision.label}`);
      return;
    }
    if (decision.action === 'renew') {
      // Expired session: fresh Minecraft token + chat keys in the background, then reconnect immediately.
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'renew', decision.label);
      this.setState(r, 'RECONNECTING', `${decision.label} – renewing the session`);
      void (this.renewAuth?.(r.identityId) ?? Promise.resolve())
        .then(() => this.audit.record(r.identityId, 'Session renewed automatically', { server: r.serverName }))
        .catch((err) => {
          r.lastError = `Session renewal failed: ${(err as Error).message}`.slice(0, 500);
          this.audit.record(r.identityId, 'Session renewal failed', { server: r.serverName });
        })
        .finally(() => {
          r.nextAttemptAt = Date.now();
          void this.reconcile();
        });
      return;
    }
    r.nextAttemptAt = Date.now() + decision.delaySec * 1000;
    this.setState(r, 'RECONNECTING', r.lastError);
    setTimeout(() => void this.reconcile(), decision.delaySec * 1000 + 50).unref?.();
  }

  /** The session will not come back: a game parked on it is closed. */
  private endParkedGame(r: SessionRecord, reason: string): void {
    if (r.takeover === 'none') return;
    r.takeover = 'none';
    void this.runtime.closeTakeover(r.id, reason).catch(() => undefined);
    if (this.game?.has(r.id)) void this.game.stopSession(r.id, reason);
  }

  private onChat(r: SessionRecord, text: string, ts: string): void {
    const line: ChatLine = { ts, sessionId: r.id, identityId: r.identityId, serverId: r.serverId, text };
    r.lastChatInAt = Date.now();
    r.chat.push(line);
    if (r.chat.length > this.opts.chatBuffer) r.chat.splice(0, r.chat.length - this.opts.chatBuffer);
    this.chatQueue.push({ ...line });
    if (!this.chatTimer) {
      this.chatTimer = setTimeout(() => this.flushChat(), 1000);
      this.chatTimer.unref?.();
    }
    this.bus.emit({ type: 'session.chat', identityId: r.identityId, data: line });
    let identity;
    try {
      identity = this.repo.getIdentity(r.identityId);
    } catch {
      return;
    }
    const events = parseChatLine(this.getRules(), identity.settings.parsers, text);
    if (events.length) {
      this.linking.handleChatEvents(r.identityId, r.serverId, events);
      this.rewards.handleChatEvents(r.identityId, r.serverId, r.serverName, events, text);
    }
  }

  private flushChat(): void {
    if (this.chatTimer) clearTimeout(this.chatTimer);
    this.chatTimer = null;
    const batch = this.chatQueue;
    this.chatQueue = [];
    try {
      this.repo.insertChat(batch);
    } catch (e) {
      log.warn(`Chat log write failed: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ interaction

  async sendChat(sessionId: string, text: string): Promise<void> {
    const r = this.get(sessionId);
    if (r.state !== 'ONLINE') throw new ValidationError('Session is not online');
    if (r.runtime === 'game') throw new ValidationError('The game window owns this session – type the message in the game');
    const msg = text.replace(/[\r\n]+/g, ' ').trim().slice(0, 256);
    if (!msg) return;
    await this.runtime.sendChat(sessionId, msg);
    const sentAt = (r.lastChatAt = Date.now());
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'chat-sent', msg.startsWith('/') ? msg.split(' ')[0] : 'message');
    // Diagnosis: the server echoes chat and answers commands – nothing at all coming back means the
    // message did not arrive or incoming chat is not readable (shown in the session log).
    const check = setTimeout(() => {
      if (this.records.get(r.id) !== r || r.state !== 'ONLINE' || r.lastChatInAt >= sentAt) return;
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'chat-no-reply', 'Nothing came back from the server within 10 s');
    }, 10_000);
    check.unref?.();
  }

  // ------------------------------------------------------------------ real game window

  /**
   * "Open game": shows the real Minecraft client for this session.
   *  - game already running (background mode or opened before): restore + focus its window
   *  - lightweight session online (handover mode): the game is prepared and started while the
   *    AFK session keeps the account online; right before the game logs in, the AFK session
   *    disconnects (~1 s gap) – the server never sees two logins
   *  - session offline: the game starts and joins directly
   */
  async openGame(sessionId: string): Promise<SessionInfo> {
    const r = this.get(sessionId);
    const a = this.repo.getAssignment(r.identityId, r.serverId);
    if (!a) throw new ValidationError('Identity is not assigned to this server');
    const onAgent = this.placedOnAgent(r);
    // The AFK session runs on an agent: the game opens HERE (where the button was clicked) with its own
    // login – the agent hands the account over and takes it back when the game is closed.
    if (onAgent && !this.game) return this.openGameOnAgent(r, a.desiredState);
    if (!this.game) throw new ValidationError('The game client is not available');
    r.wantGame = true;
    if (this.game.has(r.id) && r.takeover === 'none' && r.runtime === 'lightweight') {
      // a game window left open after it lost the session (shows Minecraft's error) – start fresh
      await this.game.stopSession(r.id, 'Reopening');
    }
    if (this.game.has(r.id)) {
      await this.game.show(r.id);
      return this.info(r);
    }
    if (a.desiredState !== 'ONLINE') this.setDesired(r.identityId, r.serverId, 'ONLINE');
    this.audit.record(r.identityId, 'Game window opened', { server: r.serverName });
    if (this.gameSettings(r).mode === 'takeover' && !r.takeoverBroken && !onAgent) {
      if (r.state !== 'ONLINE' || r.runtime !== 'lightweight') await this.waitOnline(r);
      await this.withLock(r, async () => {
        if (this.game!.has(r.id)) return void (await this.game!.show(r.id));
        try {
          await this.takeoverWithGame(r);
        } catch (e) {
          if (!/without live takeover/.test((e as Error).message)) throw e;
          // Session was started before takeover was enabled: fall back to a handover re-login.
          this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-takeover-unavailable', (e as Error).message);
          await this.handoverToGame(r);
        }
      });
      return this.info(r);
    }
    await this.withLock(r, async () => {
      if (this.game!.has(r.id)) return void (await this.game!.show(r.id));
      if (r.runtime === 'lightweight' && r.state === 'ONLINE') return this.handoverToGame(r);
      if (ACTIVE.includes(r.state)) await this.halt(r, 'Opening game', true);
      r.consecutiveFailures = 0;
      r.nextAttemptAt = null;
      await this.launch(r);
    });
    return this.info(r);
  }

  /**
   * The identity runs on a remote agent: the game window opens on THAT PC (the agent launches the
   * official client and lets it take over the session there).
   */
  private async openGameOnAgent(r: SessionRecord, desired: DesiredState): Promise<SessionInfo> {
    if (desired !== 'ONLINE') this.setDesired(r.identityId, r.serverId, 'ONLINE');
    if (r.state !== 'ONLINE') await this.waitOnline(r);
    if (!this.runtime.isRemoteSession?.(r.id)) throw new ValidationError('The session is not running on its agent yet');
    if (r.takeover !== 'none') {
      this.runtime.sendToSessionHost?.(r.id, { cmd: 'game.show', sessionId: r.id });
      return this.info(r);
    }
    const spec = await this.buildSpec(r);
    // The game joins with the in-game profile name (for Microsoft identities spec.username is the e-mail).
    const profileName = r.username ?? (spec.auth === 'offline' ? spec.username : null);
    if (!profileName) throw new ValidationError('The session is not in the world yet – try again in a moment');
    r.takeover = 'launching';
    r.wantGame = true;
    this.audit.record(r.identityId, 'Game window opened on agent', { server: r.serverName });
    this.runtime.sendToSessionHost?.(r.id, { cmd: 'game.open', sessionId: r.id, spec, settings: this.gameSettings(r), auth: { username: profileName, uuid: r.uuid ?? '' } });
    this.setState(r, r.state);
    return this.info(r);
  }

  private async waitOnline(r: SessionRecord): Promise<void> {
    const deadline = Date.now() + this.opts.connectTimeoutMs;
    void this.reconcile();
    while (!(r.state === 'ONLINE' && r.runtime === 'lightweight')) {
      if (r.state === 'BLOCKED') throw new ValidationError(`Session is blocked: ${r.lastError ?? ''}`);
      if (Date.now() > deadline) throw new ValidationError('Session did not come online');
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  /** Live takeover: the game joins the running session's local endpoint (same server connection). */
  private async takeoverWithGame(r: SessionRecord): Promise<void> {
    const spec = await this.buildSpec(r);
    const port = await this.runtime.openTakeover(r.id);
    r.takeover = 'launching';
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-takeover', 'launching');
    const name = r.username ?? spec.username;
    const uuid = (r.uuid ?? '').replace(/-/g, '') || '00000000000000000000000000000000';
    try {
      await this.game!.startSession({
        spec,
        settings: this.gameSettings(r),
        visible: true,
        connect: { host: '127.0.0.1', port },
        // The local endpoint is offline-mode: the game gets no Microsoft token at all.
        auth: { username: name, uuid, accessToken: '0', userType: 'legacy' },
      });
    } catch (e) {
      r.takeover = 'none';
      await this.runtime.closeTakeover(r.id).catch(() => undefined);
      throw e;
    }
    this.setState(r, r.state);
  }

  /** Live takeover does not work with this server: open the game with its own login instead (rest of this session). */
  private async fallbackToHandover(r: SessionRecord, why: string, gameStillOpen: boolean): Promise<void> {
    if (r.takeoverBroken) return;
    r.takeoverBroken = why.slice(0, 300);
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-takeover-failed', `${why} – the game signs in on its own instead`.slice(0, 500));
    this.setState(r, r.state, `Live takeover failed (${why}) – the game signs in on its own instead`.slice(0, 500));
    try {
      if (gameStillOpen) await this.game!.stopSession(r.id, 'Live takeover failed');
      r.wantGame = true;
      await this.withLock(r, () => this.handoverToGame(r));
    } catch (err) {
      r.wantGame = false;
      this.setState(r, r.state, `Game could not be opened: ${(err as Error).message}`.slice(0, 500));
    }
  }

  private async handoverToGame(r: SessionRecord): Promise<void> {
    let spec: RuntimeSessionSpec;
    try {
      spec = await this.buildSpec(r);
    } catch (e) {
      r.wantGame = false;
      throw new ValidationError((e as Error).message);
    }
    r.handoverPending = true;
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-handover', 'preparing');
    const beforeLogin = async () => {
      if (r.handoverPending) {
        r.handoverPending = false;
        r.runtime = 'game';
        r.startedAt = Date.now();
        this.setState(r, 'AUTHENTICATING', null);
      }
      // Frees the account: the lightweight client disconnects before the game logs in.
      await this.runtime.stopSession(r.id, 'Handover to game').catch(() => undefined);
    };
    try {
      await this.game!.startSession({ spec, settings: this.gameSettings(r), visible: true, beforeLogin });
    } catch (e) {
      r.handoverPending = false;
      r.wantGame = false;
      throw e;
    }
  }

  /**
   * "Back to AFK": background mode minimizes the game (same connection stays).
   * Handover mode closes the game and the lightweight client takes the account back.
   */
  async closeGame(sessionId: string): Promise<SessionInfo> {
    const r = this.get(sessionId);
    r.wantGame = false;
    if (r.takeover !== 'none' && this.runtime.isRemoteSession?.(r.id)) {
      r.takeover = 'none';
      this.runtime.sendToSessionHost?.(r.id, { cmd: 'game.close', sessionId: r.id });
      this.setState(r, r.state);
      return this.info(r);
    }
    if (r.takeover !== 'none') {
      this.audit.record(r.identityId, 'Game closed – back to AFK', { server: r.serverName });
      r.takeover = 'none';
      await this.runtime.closeTakeover(r.id, 'Back to AFK').catch(() => undefined);
      await this.game?.stopSession(r.id, 'Back to AFK');
      this.setState(r, r.state);
      return this.info(r);
    }
    if (!this.game?.has(r.id)) return this.info(r);
    if (r.runtime === 'game' && this.gameSettings(r).mode === 'background') {
      await this.game.minimize(r.id);
      return this.info(r);
    }
    this.audit.record(r.identityId, 'Game window closed – back to AFK', { server: r.serverName });
    await this.withLock(r, async () => {
      if (r.handoverPending) {
        await this.game!.stopSession(r.id, 'Cancelled');
        return;
      }
      await this.halt(r, 'Back to AFK', true);
      const a = this.repo.getAssignment(r.identityId, r.serverId);
      if (a?.enabled && a.desiredState === 'ONLINE') {
        r.consecutiveFailures = 0;
        await this.launch(r);
      }
    });
    return this.info(r);
  }
}
