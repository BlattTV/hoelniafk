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
 * "Open game" hands a running lightweight session over to the real client
 * (handover mode) or brings the always-running minimized client to the front
 * (background mode); "Back to AFK" reverses it.
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
import type { IdentityRepository } from '../identity/repository.js';
import type { NetworkService } from '../network/networkService.js';
import type { GameInfo, MinecraftRuntime, RuntimeEvent, RuntimeSessionSpec, SessionStats } from '../runtime/types.js';
import type { GameClientRuntime } from '../client/gameClientRuntime.js';
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
      game: r.game,
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

  /** startSession(): desired ONLINE and start now. */
  async startSession(identityId: number, serverId: number): Promise<SessionInfo> {
    this.setDesired(identityId, serverId, 'ONLINE');
    const r = this.record(identityId, serverId);
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
      const shouldRun = a.enabled && a.desiredState === 'ONLINE';
      if (!shouldRun) continue;
      wanted.add(id);
      const r = this.record(a.identityId, a.serverId);
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
      if (ACTIVE.includes(r.state) && r.state !== 'STOPPING') void this.withLock(r, () => this.halt(r, 'Desired state offline'));
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
      server: { id: server.id, name: server.name, host: server.host, port: server.port, version: server.version },
      username: mc.authType === 'microsoft' ? mc.msaAccount! : mc.username,
      auth: mc.authType,
      network,
      afk: s.afk,
      lightweight: s.lightweight,
      viewDistance: s.viewDistance,
    };
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
    if (r.wantGame) return 'game';
    return this.gameSettings(r).mode === 'background' ? 'game' : 'lightweight';
  }

  private onRuntimeEvent(source: 'lightweight' | 'game', e: RuntimeEvent): void {
    const r = this.records.get(e.sessionId);
    if (!r) return;
    if (e.type === 'game') {
      r.game = e.game;
      this.bus.emit({ type: 'session.game', identityId: r.identityId, data: { sessionId: r.id, game: e.game } });
      this.bus.emit({ type: 'session.state', identityId: r.identityId, data: this.info(r) });
      return;
    }
    if (source === 'game' && r.handoverPending && e.type === 'ended') {
      // The game never reached the server – the lightweight session still holds the account.
      r.handoverPending = false;
      r.wantGame = false;
      r.lastError = `Game could not be started: ${e.error ?? e.reason}`.slice(0, 500);
      this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'game-failed', r.lastError);
      this.setState(r, r.state, r.lastError);
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
          r.releaseStart?.();
          this.setState(r, 'ONLINE', null);
        } else this.setState(r, e.phase);
        return;
      case 'spawned':
        r.username = e.username;
        return;
      case 'stats':
        r.stats = e.stats;
        this.bus.emit({ type: 'session.stats', identityId: r.identityId, data: { sessionId: r.id, stats: e.stats } });
        return;
      case 'chat':
        this.onChat(r, e.text, e.ts);
        return;
      case 'ended':
        this.onEnded(r, e);
        return;
    }
  }

  private onEnded(r: SessionRecord, e: Extract<RuntimeEvent, { type: 'ended' }>): void {
    r.releaseStart?.();
    const detail = [e.error, e.reason].filter(Boolean).join(' | ');
    r.lastEndReason = e.reason;
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, e.kicked ? 'kicked' : 'ended', detail);
    r.stats = null;
    const fromGame = r.runtime === 'game';
    if (fromGame) {
      r.runtime = 'lightweight';
      if (r.wantGame && e.reason === 'clientExited' && r.state !== 'STOPPING') {
        // The user closed the game window: back to AFK right away.
        r.wantGame = false;
        const a0 = this.repo.getAssignment(r.identityId, r.serverId);
        if (a0?.enabled && a0.desiredState === 'ONLINE' && !this.stopped && this.gameSettings(r).mode === 'handover') {
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
      this.setState(r, 'STOPPED', r.state === 'STOPPING' ? null : e.error);
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
      return;
    }
    r.nextAttemptAt = Date.now() + decision.delaySec * 1000;
    this.setState(r, 'RECONNECTING', r.lastError);
    setTimeout(() => void this.reconcile(), decision.delaySec * 1000 + 50).unref?.();
  }

  private onChat(r: SessionRecord, text: string, ts: string): void {
    const line: ChatLine = { ts, sessionId: r.id, identityId: r.identityId, serverId: r.serverId, text };
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
    this.repo.addSessionEvent(r.identityId, r.serverId, r.id, 'chat-sent', msg.startsWith('/') ? msg.split(' ')[0] : 'message');
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
    if (!this.game) throw new ValidationError('The game client is not available');
    const r = this.get(sessionId);
    const a = this.repo.getAssignment(r.identityId, r.serverId);
    if (!a) throw new ValidationError('Identity is not assigned to this server');
    r.wantGame = true;
    if (this.game.has(r.id)) {
      await this.game.show(r.id);
      return this.info(r);
    }
    if (a.desiredState !== 'ONLINE') this.setDesired(r.identityId, r.serverId, 'ONLINE');
    this.audit.record(r.identityId, 'Game window opened', { server: r.serverName });
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
