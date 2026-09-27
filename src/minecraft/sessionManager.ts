import { EventEmitter } from 'node:events';
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { nowIso } from '../core/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { parseChatLine, type RulesConfig } from '../core/rules.js';
import type { ChatLine, MinecraftServer, SessionInfo, SessionState } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { NetworkService, ResolvedNetwork } from '../network/networkService.js';
import type { MinecraftAuthService } from './authService.js';
import type { LinkingWorkflow } from './linking.js';
import type { RewardTracker } from './rewards.js';
import type { vaultCacheFactory } from './tokenCache.js';

const log = createLogger('sessions');

/** Everything a bot needs to connect. Always built for exactly one identity. */
export interface SessionLaunchSpec {
  identityId: number;
  server: MinecraftServer;
  username: string;
  authType: 'microsoft' | 'offline';
  msaAccount: string | null;
  /** Token cache bound to this identity's vault scope. */
  cacheFactory: ReturnType<typeof vaultCacheFactory> | null;
  network: ResolvedNetwork;
  onMsaCode: (info: { user_code: string; verification_uri: string; expires_in: number }) => void;
}

/** Minimal surface of a mineflayer bot used by the session manager. */
export interface BotLike extends EventEmitter {
  quit(reason?: string): void;
  chat(message: string): void;
  antiAfk?(action: 'look' | 'swing' | 'jump'): void;
}

export type BotFactory = (spec: SessionLaunchSpec) => BotLike;

const CHAT_BUFFER = 300;

export class SessionInstance {
  state: SessionState = 'IDLE';
  since = nowIso();
  lastError: string | null = null;
  reconnects = 0;
  readonly chat: ChatLine[] = [];
  bot: BotLike | null = null;
  stopped = false;
  reconnectTimer: NodeJS.Timeout | null = null;
  afkTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    readonly identityId: number,
    readonly server: MinecraftServer,
    readonly networkProfileId: number | null,
  ) {}

  info(): SessionInfo {
    return {
      id: this.id,
      identityId: this.identityId,
      serverId: this.server.id,
      serverName: this.server.name,
      networkProfileId: this.networkProfileId,
      state: this.state,
      since: this.since,
      lastError: this.lastError,
      reconnects: this.reconnects,
    };
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionInstance>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly network: NetworkService,
    private readonly auth: MinecraftAuthService,
    private readonly linking: LinkingWorkflow,
    private readonly rewards: RewardTracker,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly botFactory: BotFactory,
    private readonly getRules: () => RulesConfig,
  ) {}

  static sessionId(identityId: number, serverId: number): string {
    return `${identityId}:${serverId}`;
  }

  list(identityId?: number): SessionInfo[] {
    return [...this.sessions.values()].filter((s) => identityId === undefined || s.identityId === identityId).map((s) => s.info());
  }

  get(sessionId: string): SessionInstance {
    const s = this.sessions.get(sessionId);
    if (!s) throw new NotFoundError(`Session ${sessionId} not found`);
    return s;
  }

  chat(sessionId: string, limit = 100): ChatLine[] {
    return this.get(sessionId).chat.slice(-limit);
  }

  /** Builds the launch spec for identity × server. Throws on any cross-identity resource. */
  async buildSpec(identityId: number, serverId: number): Promise<SessionLaunchSpec> {
    const assignment = this.repo.getAssignment(identityId, serverId);
    if (!assignment) throw new ValidationError('Identity is not assigned to this server');
    if (!assignment.enabled) throw new ValidationError('Server assignment is disabled');
    const mc = this.repo.getMinecraft(identityId);
    if (!mc) throw new ValidationError('No Minecraft account configured for this identity');
    const server = this.repo.getServer(serverId);
    const network = await this.network.resolve(identityId, assignment.networkProfileId);
    return {
      identityId,
      server,
      username: mc.authType === 'microsoft' ? mc.msaAccount ?? mc.username : mc.username,
      authType: mc.authType,
      msaAccount: mc.msaAccount,
      cacheFactory: mc.authType === 'microsoft' ? this.auth.cacheFactoryFor(identityId) : null,
      network,
      onMsaCode: (info) =>
        this.bus.emit({
          type: 'auth.devicecode',
          identityId,
          data: { userCode: info.user_code, verificationUri: info.verification_uri, expiresIn: info.expires_in },
        }),
    };
  }

  async start(identityId: number, serverId: number): Promise<SessionInfo> {
    const id = SessionManager.sessionId(identityId, serverId);
    const existing = this.sessions.get(id);
    if (existing && !['STOPPED', 'ERROR', 'IDLE'].includes(existing.state)) {
      throw new ConflictError('Session is already running');
    }
    const spec = await this.buildSpec(identityId, serverId);
    const session = new SessionInstance(id, identityId, spec.server, spec.network.profile?.id ?? null);
    this.sessions.set(id, session);
    this.audit.record(identityId, 'Session started', { server: spec.server.name, network: spec.network.profile?.name ?? 'direct' });
    this.launch(session, spec);
    return session.info();
  }

  private setState(s: SessionInstance, state: SessionState, error: string | null = null): void {
    s.state = state;
    s.since = nowIso();
    if (error !== null) s.lastError = error;
    this.bus.emit({ type: 'session.state', identityId: s.identityId, data: s.info() });
  }

  private launch(s: SessionInstance, spec: SessionLaunchSpec): void {
    s.stopped = false;
    this.setState(s, 'CONNECTING');
    let bot: BotLike;
    try {
      bot = this.botFactory(spec);
    } catch (e) {
      this.setState(s, 'ERROR', (e as Error).message);
      return;
    }
    s.bot = bot;
    bot.on('login', () => this.setState(s, 'AUTHENTICATING'));
    bot.on('spawn', () => {
      if (s.state !== 'ONLINE') {
        this.setState(s, 'ONLINE', null);
        s.lastError = null;
        this.startAfk(s, bot);
      }
    });
    bot.on('messagestr', (text: string) => this.onChat(s, text));
    bot.on('kicked', (reason: unknown) => {
      s.lastError = `Kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`.slice(0, 300);
    });
    bot.on('error', (err: Error) => {
      s.lastError = err.message.slice(0, 300);
      log.warn(`Session ${s.id} error: ${err.message}`);
    });
    bot.on('end', () => {
      this.stopAfk(s);
      s.bot = null;
      if (s.stopped) {
        this.setState(s, 'STOPPED');
        return;
      }
      const identity = this.repo.getIdentity(s.identityId);
      if (identity.settings.autoReconnect) {
        const delay = Math.min(identity.settings.reconnectDelaySec * 1000 * 2 ** Math.min(s.reconnects, 5), 300_000);
        s.reconnects++;
        this.setState(s, 'RECONNECTING');
        s.reconnectTimer = setTimeout(() => {
          s.reconnectTimer = null;
          if (s.stopped) return;
          this.buildSpec(s.identityId, s.server.id)
            .then((next) => this.launch(s, next))
            .catch((e) => this.setState(s, 'ERROR', (e as Error).message));
        }, delay);
      } else {
        this.setState(s, 'ERROR', s.lastError ?? 'Disconnected');
      }
    });
  }

  private onChat(s: SessionInstance, text: string): void {
    const line: ChatLine = { ts: nowIso(), sessionId: s.id, identityId: s.identityId, serverId: s.server.id, text };
    s.chat.push(line);
    if (s.chat.length > CHAT_BUFFER) s.chat.splice(0, s.chat.length - CHAT_BUFFER);
    this.bus.emit({ type: 'session.chat', identityId: s.identityId, data: line });
    const identity = this.repo.getIdentity(s.identityId);
    const events = parseChatLine(this.getRules(), identity.settings.parsers, text);
    if (events.length) {
      this.linking.handleChatEvents(s.identityId, s.server.id, events);
      this.rewards.handleChatEvents(s.identityId, s.server.name, events);
    }
  }

  private startAfk(s: SessionInstance, bot: BotLike): void {
    this.stopAfk(s);
    const { afk } = this.repo.getIdentity(s.identityId).settings;
    if (!afk.enabled || afk.action === 'none' || !bot.antiAfk) return;
    const action = afk.action;
    s.afkTimer = setInterval(() => {
      try {
        bot.antiAfk!(action);
      } catch {
        /* ignore */
      }
    }, Math.max(afk.intervalSec, 10) * 1000);
  }

  private stopAfk(s: SessionInstance): void {
    if (s.afkTimer) clearInterval(s.afkTimer);
    s.afkTimer = null;
  }

  stop(sessionId: string): SessionInfo {
    const s = this.get(sessionId);
    s.stopped = true;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
    this.stopAfk(s);
    if (s.bot) s.bot.quit('Stopped by user');
    else this.setState(s, 'STOPPED');
    this.audit.record(s.identityId, 'Session stopped', { server: s.server.name });
    return s.info();
  }

  async reconnect(sessionId: string): Promise<SessionInfo> {
    const s = this.get(sessionId);
    s.stopped = true;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.bot) {
      const bot = s.bot;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        bot.once('end', () => {
          clearTimeout(t);
          resolve();
        });
        bot.quit('Reconnect');
      });
    }
    const spec = await this.buildSpec(s.identityId, s.server.id);
    s.reconnects++;
    this.launch(s, spec);
    return s.info();
  }

  sendChat(sessionId: string, text: string): void {
    const s = this.get(sessionId);
    if (!s.bot || s.state !== 'ONLINE') throw new ValidationError('Session is not online');
    const msg = text.trim().slice(0, 256);
    if (!msg) return;
    s.bot.chat(msg);
  }

  /** Starts all enabled server assignments of an identity. */
  async startAll(identityId: number, onlyAutoStart = false): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    for (const a of this.repo.listAssignments(identityId)) {
      if (!a.enabled || (onlyAutoStart && !a.autoStart)) continue;
      const id = SessionManager.sessionId(identityId, a.serverId);
      const cur = this.sessions.get(id);
      if (cur && !['STOPPED', 'ERROR', 'IDLE'].includes(cur.state)) {
        out.push(cur.info());
        continue;
      }
      out.push(await this.start(identityId, a.serverId));
    }
    return out;
  }

  stopAll(identityId?: number): void {
    for (const s of this.sessions.values()) {
      if (identityId !== undefined && s.identityId !== identityId) continue;
      if (!s.stopped) this.stop(s.id);
    }
  }

  forgetIdentity(identityId: number): void {
    this.stopAll(identityId);
    for (const [id, s] of this.sessions) if (s.identityId === identityId) this.sessions.delete(id);
  }
}
