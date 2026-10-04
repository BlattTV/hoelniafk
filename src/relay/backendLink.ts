/**
 * Manager ↔ Hoelni backend (default https://afk.hoelni.de).
 *
 *   manager (this suite) ──sign-in──▶ backend: device token (vault)
 *                        ──wss /relay──▶ backend relay ──▶ the same account's agents
 *
 * Every online agent of the account becomes a runtime host of this manager: identities set to
 * "Run on: <agent>" start their sessions on that PC. Admin accounts additionally get the account
 * administration (proxied to the backend's admin API).
 * The backend address can only be changed with an admin account of the CURRENT backend.
 */
import os from 'node:os';
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { SuiteError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { MineflayerRuntime } from '../runtime/mineflayerRuntime.js';
import type { HostToMain, MainToHost } from '../runtime/protocol.js';
import { appRoot, currentBuild } from '../ops/updater.js';
import { refs } from '../vault/refs.js';
import type { Vault } from '../vault/vault.js';
import { DEFAULT_BACKEND, normalizeBackendUrl, openWebSocket, probeCertificate, requestJson, type ServerCertificate, type TransportOptions } from '../agent/transport.js';

const log = createLogger('backend');

/** Backend answers become user-facing errors (4xx from the backend → 400, network problems → 502). */
function userError(e: unknown, prefix = ''): SuiteError {
  if (e instanceof SuiteError) return e;
  const status = (e as { status?: number }).status;
  const msg = `${prefix}${(e as Error).message}`;
  return new SuiteError(status && status < 500 ? msg : `Backend not reachable or failed: ${msg}`, status && status < 500 ? 400 : 502);
}
const TOKEN_REF = refs.app('backend-token');
const PROXY_REF = refs.app('backend-proxy');

/** socks5://user:secret@host:port → socks5://user:•••@host:port (never show proxy passwords). */
export function maskProxy(url: string | null): string {
  if (!url) return '';
  return url.replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:•••@');
}

/** A request of a remote controller for the active PC's API (same paths as the suite's own UI). */
export interface RemoteRequest {
  method: string;
  path: string;
  body?: unknown;
  /** Name of the controlling device (shown in the audit log). */
  by?: string;
}
export interface RemoteResponse {
  status: number;
  body: unknown;
}

/** Events the active PC sends to its controllers (enough to keep their screens live). */
const FORWARDED_EVENTS = new Set(['identity.changed', 'session.state', 'session.chat', 'session.game', 'session.stats', 'reward.changed', 'link.state', 'macro', 'auth.devicecode', 'accounts.changed', 'mail.updated', 'network.checked', 'stars.alert']);

export interface AgentInfo {
  id: number;
  name: string;
  info: Record<string, string>;
  paused: boolean;
  ip: string | null;
  connectedAt: string | null;
  online: boolean;
}

type LinkState = 'signed-out' | 'connecting' | 'online' | 'offline' | 'replaced';

export class BackendLink {
  private ws: ReturnType<typeof openWebSocket> | null = null;
  private retry = 1000;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly agents = new Map<number, AgentInfo>();
  private readonly hosts = new Map<number, { deliver: (m: HostToMain) => void; detach: (why: string) => void }>();
  private closed = false;
  /** Proxy for the backend connection – kept in the vault (may contain a password), cached here. */
  private proxy: string | null = null;
  private readonly ready: Promise<void>;
  /** Called after every successful connection to the backend (e.g. to adopt its update distribution). */
  onConnected: () => void = () => undefined;
  /** Called when an agent becomes usable (online and not paused) – wired to the session manager. */
  onAgentAvailable: (agentId: number) => void = () => undefined;
  /** This PC became active (null) or standby (reason: which PC runs the sessions) – wired to the sessions. */
  onRoleChanged: (standbyReason: string | null) => void = () => undefined;
  /** Another suite of the account stored new settings (version) – wired to the settings sync. */
  onSyncChanged: (version: number) => void = () => undefined;
  /** Active PC: answers a remote-control request (another PC in standby or the "Hoelni Control" app). */
  onRpc: (req: RemoteRequest) => Promise<RemoteResponse> = async () => ({ status: 503, body: { error: 'Remote control not available' } });
  /** Standby PC: a live event of the active PC (shown here as if it happened on this PC). */
  onRemoteEvent: (ev: Record<string, unknown>) => void = () => undefined;
  /** Standby PCs + control apps following this (active) PC – live events are only sent while > 0. */
  private controllers = 0;
  private rpcSeq = 0;
  private readonly rpcWaiting = new Map<number, { resolve: (r: RemoteResponse) => void; timer: NodeJS.Timeout }>();
  private readonly statsSentAt = new Map<string, number>();
  /** Other suites (PCs) of this account connected to the backend right now. */
  private managers: Array<{ deviceId: number; name: string; ip: string | null; publicIp: string | null; connectedAt: string; active: boolean; self: boolean }> = [];
  /** Public IP of this PC (own detection), told to the backend for the account's other devices. */
  private publicIp: string | null = null;
  state: LinkState = 'signed-out';
  lastError: string | null = null;

  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly runtime: MineflayerRuntime | null,
  ) {
    this.ready = this.loadProxy();
  }

  private async loadProxy(): Promise<void> {
    // Older versions stored the proxy URL in SQLite – move it into the vault.
    const legacy = this.repo.getSetting('backend.proxy');
    if (legacy) {
      await this.vault.store.set(PROXY_REF, legacy);
      this.repo.setSetting('backend.proxy', '');
    }
    this.proxy = (await this.vault.store.get(PROXY_REF)) || null;
  }

  // ------------------------------------------------------------------ settings

  get url(): string {
    return this.repo.getSetting('backend.url') || DEFAULT_BACKEND;
  }

  private transport(): TransportOptions {
    return { pinnedCert: this.repo.getSetting('backend.cert') || null, proxy: this.proxy };
  }

  private async token(): Promise<string | null> {
    return this.vault.store.get(TOKEN_REF);
  }

  status() {
    return {
      url: this.url,
      updatesUrl: this.updatesUrl,
      isDefault: !this.repo.getSetting('backend.url'),
      state: this.state,
      lastError: this.lastError,
      username: this.repo.getSetting('backend.username') || null,
      role: (this.repo.getSetting('backend.role') || null) as 'admin' | 'user' | null,
      pinnedCert: !!this.repo.getSetting('backend.cert'),
      proxy: maskProxy(this.proxy),
      agents: [...this.agents.values()].map((a) => ({ ...a, sessions: this.runtime?.agentSessions(a.id) ?? [] })),
      /** 'active' = this PC runs the sessions; 'standby' = another PC of the account does (see activePc) */
      pcRole: this.standbyFor() ? ('standby' as const) : ('active' as const),
      activePc: this.standbyFor(),
      pcs: this.managers,
    };
  }

  /** This PC's public IP changed (or became known) – the backend shows it to the account's devices. */
  setPublicIp(ip: string | null): void {
    if (!ip || ip === this.publicIp) return;
    this.publicIp = ip;
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'info', publicIp: ip }));
  }

  /** Name of the PC that runs the sessions while this one is in standby (null = this PC is active). */
  standbyFor(): string | null {
    return this.repo.getSetting('backend.standbyFor') || null;
  }

  private setRole(standbyFor: string | null): void {
    if ((this.standbyFor() ?? null) === standbyFor) return;
    this.repo.setSetting('backend.standbyFor', standbyFor ?? '');
    this.audit.record(null, standbyFor ? 'Standby – another PC runs the sessions' : 'This PC runs the sessions', standbyFor ? { pc: standbyFor } : {});
    this.onRoleChanged(standbyFor ? `the sessions run on "${standbyFor}"` : null);
  }

  /** "Take over here": this PC becomes the active one – the other PC stops its sessions. */
  claim(): void {
    if (this.ws?.readyState !== 1) throw new SuiteError('Not connected to the backend – try again in a moment', 409);
    this.ws.send(JSON.stringify({ t: 'claim' }));
    this.audit.record(null, 'Took over the sessions on this PC');
  }

  /** Standby PC: a request for the active PC of the account (remote control through the backend). */
  rpc(req: RemoteRequest, timeoutMs = 30_000): Promise<RemoteResponse> {
    if (this.ws?.readyState !== 1) return Promise.resolve({ status: 503, body: { error: 'Not connected to the backend' } });
    const id = ++this.rpcSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.rpcWaiting.delete(id);
        resolve({ status: 504, body: { error: 'The active PC did not answer in time' } });
      }, timeoutMs);
      this.rpcWaiting.set(id, { resolve, timer });
      this.ws!.send(JSON.stringify({ t: 'rpc', id, req }));
    });
  }

  /** Remote control is possible: this PC is in standby and connected (the active PC answers). */
  get remoteControl(): boolean {
    return !!this.standbyFor() && this.ws?.readyState === 1 && this.managers.some((m) => m.active && !m.self);
  }

  /** Active PC: live events for the controllers (standby PCs, control apps) – stats at most every 3 s per session. */
  forwardEvent(ev: { type: string; [k: string]: unknown }): void {
    if (!this.controllers || this.standbyFor() || this.ws?.readyState !== 1 || !FORWARDED_EVENTS.has(ev.type)) return;
    if (ev.type === 'session.stats') {
      const key = String((ev as any).sessionId ?? (ev as any).data?.sessionId ?? '');
      const last = this.statsSentAt.get(key) ?? 0;
      if (Date.now() - last < 3000) return;
      this.statsSentAt.set(key, Date.now());
    }
    this.ws.send(JSON.stringify({ t: 'event', ev }));
  }

  /** Device token of this suite (for the settings sync). */
  async deviceToken(): Promise<string | null> {
    await this.ready;
    return this.token();
  }

  get transportOptions(): TransportOptions {
    return this.transport();
  }

  private changed(): void {
    if (this.closed) return;
    this.bus.emit({ type: 'agents.changed', data: this.status() });
  }

  // ------------------------------------------------------------------ sign-in

  /** Certificate check before the first sign-in: a self-signed certificate must be confirmed by fingerprint. */
  async checkCertificate(): Promise<ServerCertificate | null> {
    await this.ready;
    return probeCertificate(this.url, { proxy: this.transport().proxy }).catch((e) => {
      throw userError(e);
    });
  }

  async login(username: string, password: string, trustCertPem?: string | null): Promise<ReturnType<BackendLink['status']>> {
    await this.ready;
    if (trustCertPem) this.repo.setSetting('backend.cert', trustCertPem);
    const r = await requestJson<{ token: string; deviceId: number; user: { username: string; role: 'admin' | 'user' } }>(
      `${this.url}/api/login`,
      'POST',
      { username, password, client: 'manager', name: `Manager on ${os.hostname()}`, info: { hostname: os.hostname(), os: `${os.platform()} ${os.release()}` } },
      this.transport(),
    ).catch((e) => {
      throw userError(e);
    });
    await this.vault.store.set(TOKEN_REF, r.token);
    this.repo.setSetting('backend.username', r.user.username);
    this.repo.setSetting('backend.role', r.user.role);
    this.audit.record(null, 'Signed in to the backend', { backend: this.url, user: r.user.username });
    this.start();
    return this.status();
  }

  async logout(): Promise<void> {
    await this.ready;
    const token = await this.token();
    if (token) await requestJson(`${this.url}/api/logout`, 'POST', {}, this.transport(), { Authorization: `Bearer ${token}` }).catch(() => undefined);
    await this.vault.store.delete(TOKEN_REF);
    this.repo.setSetting('backend.role', '');
    this.disconnect('signed-out');
    this.managers = [];
    this.setRole(null); // without the backend this PC runs its sessions on its own
    this.audit.record(null, 'Signed out from the backend');
  }

  /** Changing the backend address needs valid admin credentials of the CURRENT backend. */
  async changeBackend(newUrl: string, adminUser: string, adminPassword: string, opts: { proxy?: string } = {}): Promise<ReturnType<BackendLink['status']>> {
    await this.ready;
    let target: string;
    try {
      target = normalizeBackendUrl(newUrl);
    } catch (e) {
      throw new SuiteError(`Invalid address: ${(e as Error).message}`);
    }
    await requestJson(`${this.url}/api/verify-admin`, 'POST', { username: adminUser, password: adminPassword }, this.transport()).catch((e) => {
      throw userError(e, `The current backend (${this.url}) did not confirm the admin account: `);
    });
    await this.logout().catch(() => undefined);
    this.repo.setSetting('backend.url', target === DEFAULT_BACKEND ? '' : target);
    this.repo.setSetting('backend.cert', '');
    if (opts.proxy !== undefined) await this.storeProxy(opts.proxy);
    this.audit.record(null, 'Backend address changed', { to: target, confirmedBy: adminUser });
    this.changed();
    return this.status();
  }

  /** The backend's update distribution (pass-through to its local update server). */
  get updatesUrl(): string {
    return `${this.url}/updates`;
  }

  /** Sign-in header for requests to this backend's /updates (never sent to other hosts). */
  async authHeadersFor(url: string): Promise<Record<string, string>> {
    if (!(url === this.updatesUrl || url.startsWith(`${this.updatesUrl}/`))) return {};
    const token = await this.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** Manual reconnect (after "another manager took over" or a long outage). */
  reconnect(): void {
    this.disconnect(this.state === 'signed-out' ? 'signed-out' : 'offline');
    this.retry = 1000;
    void this.start();
  }

  private async storeProxy(proxy: string): Promise<void> {
    await this.ready;
    if (proxy) await this.vault.store.set(PROXY_REF, proxy);
    else await this.vault.store.delete(PROXY_REF);
    this.proxy = proxy || null;
  }

  async setProxy(proxy: string): Promise<void> {
    if (proxy && !/^(https?|socks5h?):\/\//i.test(proxy)) throw new SuiteError('Proxy must look like http://host:port or socks5://user:pass@host:port');
    await this.storeProxy(proxy);
    this.disconnect(this.state === 'signed-out' ? 'signed-out' : 'offline');
    void this.start();
  }

  /** All agents of this account (also offline ones) with live state – for "Run on" and the Agents page. */
  async agentList(): Promise<Array<AgentInfo & { sessions: string[]; lastSeenAt: string | null; outdated: boolean; suiteBuild: number | null }>> {
    await this.ready;
    const token = await this.token();
    const known = token
      ? await requestJson<Array<{ id: number; name: string; info: Record<string, string>; lastSeenAt: string | null; lastIp: string | null }>>(`${this.url}/api/agents`, 'GET', undefined, { ...this.transport(), timeoutMs: 5000 }, { Authorization: `Bearer ${token}` }).catch(() => [])
      : [];
    const out = new Map<number, AgentInfo & { sessions: string[]; lastSeenAt: string | null }>();
    for (const d of known) out.set(d.id, { id: d.id, name: d.name, info: d.info ?? {}, paused: false, ip: d.lastIp, connectedAt: null, online: false, sessions: [], lastSeenAt: d.lastSeenAt });
    for (const a of this.agents.values()) out.set(a.id, { ...(out.get(a.id) ?? { lastSeenAt: null }), ...a, sessions: this.runtime?.agentSessions(a.id) ?? [] });
    // an agent on an older build than this suite (e.g. still waiting for its automatic update)
    const own = currentBuild(appRoot()).build;
    const buildOf = (v: string | undefined) => Number(/build (\d+)/.exec(v ?? '')?.[1] ?? 0);
    return [...out.values()]
      .map((a) => ({ ...a, outdated: own > 0 && buildOf(a.info?.version) > 0 && buildOf(a.info?.version) < own, suiteBuild: own || null }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  /** The account owner pauses / resumes one of the account's agents (its sessions stop / may start again). */
  pauseAgent(agentId: number, paused: boolean): void {
    const a = this.agents.get(agentId);
    if (!a?.online) throw new SuiteError('The agent is offline', 409);
    this.sendTo(agentId, { t: 'host', m: { cmd: paused ? 'agent.pause' : 'agent.resume' } });
    this.audit.record(null, paused ? 'Agent paused' : 'Agent resumed', { agent: a.name });
  }

  /** The account owner updates an agent now (it restarts into the new version; its sessions reconnect). */
  updateAgent(agentId: number): void {
    const a = this.agents.get(agentId);
    if (!a?.online) throw new SuiteError('The agent is offline', 409);
    this.sendTo(agentId, { t: 'host', m: { cmd: 'agent.update' } });
    this.audit.record(null, 'Agent update requested', { agent: a.name });
  }

  /** Account administration (admins only) – proxied to the backend's admin API. */
  async admin(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.ready;
    const token = await this.token();
    if (!token) throw new SuiteError('Not signed in to the backend');
    if (this.repo.getSetting('backend.role') !== 'admin') throw new SuiteError('Only admins can manage accounts', 403);
    return requestJson(`${this.url}/api/admin/${path.replace(/^\/+/, '')}`, method, method === 'GET' || method === 'DELETE' ? undefined : body ?? {}, this.transport(), { Authorization: `Bearer ${token}` }).catch((e) => {
      throw userError(e);
    });
  }

  // ------------------------------------------------------------------ relay connection

  async start(): Promise<void> {
    await this.ready;
    if (this.closed) return;
    this.stopped = false;
    if (this.ws) return;
    const token = await this.token();
    if (this.closed || this.ws) return;
    if (!token) {
      this.state = 'signed-out';
      this.changed();
      return;
    }
    this.state = 'connecting';
    this.changed();
    let ws: ReturnType<typeof openWebSocket>;
    try {
      ws = openWebSocket(this.url, token, this.transport(), '/relay');
    } catch (e) {
      return this.reconnectLater((e as Error).message);
    }
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 1000;
      this.state = 'online';
      this.lastError = null;
      log.info(`Connected to the backend ${this.url}`);
      this.changed();
      this.onConnected();
      if (this.publicIp) ws.send(JSON.stringify({ t: 'info', publicIp: this.publicIp }));
      // Role may have changed on the backend (e.g. admin revoked) – the admin pages follow it.
      void requestJson<{ user: { username: string; role: 'admin' | 'user' } }>(`${this.url}/api/me`, 'GET', undefined, this.transport(), { Authorization: `Bearer ${token}` })
        .then((me) => {
          if (this.closed) return;
          this.repo.setSetting('backend.username', me.user.username);
          this.repo.setSetting('backend.role', me.user.role);
          this.changed();
        })
        .catch(() => undefined);
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        this.lastError = 'The backend signed this manager out – sign in again';
        void this.vault.store.delete(TOKEN_REF);
        this.stopped = true;
        this.state = 'signed-out';
      }
    });
    ws.on('message', (data) => this.onFrame(String(data)));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      for (const [id, w] of this.rpcWaiting) {
        this.rpcWaiting.delete(id);
        clearTimeout(w.timer);
        w.resolve({ status: 503, body: { error: 'Connection to the backend lost' } });
      }
      this.controllers = 0;
      for (const id of [...this.hosts.keys()]) this.agentOffline(id);
      if (this.stopped) {
        this.changed();
        return;
      }
      this.reconnectLater(this.lastError ?? 'Connection closed');
    });
    ws.on('error', (e) => {
      this.lastError = e.message;
    });
  }

  private reconnectLater(error: string): void {
    this.lastError = error;
    if (this.state !== 'signed-out' && this.state !== 'replaced') this.state = 'offline';
    this.changed();
    if (this.stopped) return;
    clearTimeout(this.timer!);
    this.timer = setTimeout(() => void this.start(), this.retry);
    this.retry = Math.min(this.retry * 2, 60_000);
  }

  private disconnect(state: LinkState): void {
    this.stopped = true;
    clearTimeout(this.timer!);
    this.ws?.close();
    this.ws = null;
    for (const id of [...this.hosts.keys()]) this.agentOffline(id);
    this.agents.clear();
    this.state = state;
    this.changed();
  }

  private sendTo(agentId: number, frame: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'to', agentId, frame }));
  }

  private onFrame(text: string): void {
    if (this.closed) return;
    let f: any;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    switch (f?.t) {
      case 'agent.online': {
        const a = f.agent;
        const known = this.agents.get(a.id);
        this.agents.set(a.id, { id: a.id, name: a.name, info: a.info ?? {}, paused: !!a.paused, ip: a.ip ?? null, connectedAt: a.connectedAt ?? null, online: true });
        if (!known?.online || !this.hosts.has(a.id)) this.agentOnline(a.id, a.name);
        this.runtime?.setAgentPaused(a.id, !!a.paused);
        if (!a.paused) this.onAgentAvailable(a.id);
        break;
      }
      case 'agent.offline':
        this.agentOffline(f.id);
        break;
      case 'agent.paused': {
        const a = this.agents.get(f.id);
        if (a) a.paused = !!f.value;
        this.runtime?.setAgentPaused(f.id, !!f.value);
        if (!f.value) this.onAgentAvailable(f.id);
        break;
      }
      case 'from': {
        const m = f.frame?.t === 'host' ? (f.frame.m as HostToMain) : null;
        if (m && typeof m.evt === 'string') this.hosts.get(Number(f.agentId))?.deliver(m);
        return;
      }
      case 'active':
        this.setRole(null);
        break;
      case 'standby':
        this.setRole(String(f.active?.name ?? 'another PC').slice(0, 120));
        break;
      case 'managers':
        this.managers = Array.isArray(f.list)
          ? f.list.slice(0, 20).map((m: any) => ({ deviceId: Number(m.deviceId), name: String(m.name ?? ''), ip: m.ip ?? null, publicIp: typeof m.publicIp === 'string' ? m.publicIp : null, connectedAt: String(m.connectedAt ?? ''), active: !!m.active, self: Number(m.deviceId) === Number(f.self) }))
          : [];
        break;
      case 'sync':
        this.onSyncChanged(Number(f.version) || 0);
        return;
      case 'controllers':
        this.controllers = Number(f.n) || 0;
        return;
      case 'rpc': {
        // remote control: only the active PC answers, every request is checked by onRpc (allowlist)
        const id = f.id;
        const reply = (r: RemoteResponse) => {
          if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'rpc.res', id, status: r.status, body: r.body }));
        };
        if (this.standbyFor()) reply({ status: 409, body: { error: 'This PC is in standby' } });
        else void this.onRpc(f.req as RemoteRequest).then(reply, (e) => reply({ status: 500, body: { error: (e as Error).message } }));
        return;
      }
      case 'rpc.res': {
        const w = this.rpcWaiting.get(Number(f.id));
        if (!w) return;
        this.rpcWaiting.delete(Number(f.id));
        clearTimeout(w.timer);
        w.resolve({ status: Number(f.status) || 500, body: f.body ?? null });
        return;
      }
      case 'event':
        if (this.standbyFor() && f.ev && typeof f.ev.type === 'string') this.onRemoteEvent(f.ev);
        return;
      case 'bye':
        this.lastError = String(f.reason ?? 'Disconnected by the backend');
        if (/another manager/i.test(this.lastError)) {
          this.stopped = true;
          this.state = 'replaced';
        }
        if (/revoked|signed out|disabled|deleted/i.test(this.lastError)) {
          this.stopped = true;
          this.state = 'signed-out';
          void this.vault.store.delete(TOKEN_REF);
        }
        break;
      default:
        return;
    }
    this.changed();
  }

  private agentOnline(id: number, name: string): void {
    if (!this.runtime) return;
    this.hosts.get(id)?.detach('agent reconnected');
    const link = this.runtime.attachRemoteHost({
      agentId: id,
      name,
      send: (m: MainToHost) => this.sendTo(id, { t: 'host', m }),
      close: () => undefined,
    });
    this.hosts.set(id, link);
    log.info(`Agent "${name}" (#${id}) available`);
  }

  private agentOffline(id: number): void {
    this.hosts.get(id)?.detach('agent offline');
    this.hosts.delete(id);
    const a = this.agents.get(id);
    if (a) a.online = false;
    this.runtime?.setAgentPaused(id, false);
  }

  shutdown(): void {
    this.disconnect(this.state === 'signed-out' ? 'signed-out' : 'offline');
    this.closed = true;
  }
}
