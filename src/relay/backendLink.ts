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
  /** Called when an agent becomes usable (online and not paused) – wired to the session manager. */
  onAgentAvailable: (agentId: number) => void = () => undefined;
  state: LinkState = 'signed-out';
  lastError: string | null = null;

  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly runtime: MineflayerRuntime | null,
  ) {}

  // ------------------------------------------------------------------ settings

  get url(): string {
    return this.repo.getSetting('backend.url') || DEFAULT_BACKEND;
  }

  private transport(): TransportOptions {
    return { pinnedCert: this.repo.getSetting('backend.cert') || null, proxy: this.repo.getSetting('backend.proxy') || null };
  }

  private async token(): Promise<string | null> {
    return this.vault.store.get(TOKEN_REF);
  }

  status() {
    return {
      url: this.url,
      isDefault: !this.repo.getSetting('backend.url'),
      state: this.state,
      lastError: this.lastError,
      username: this.repo.getSetting('backend.username') || null,
      role: (this.repo.getSetting('backend.role') || null) as 'admin' | 'user' | null,
      pinnedCert: !!this.repo.getSetting('backend.cert'),
      proxy: this.repo.getSetting('backend.proxy') || '',
      agents: [...this.agents.values()].map((a) => ({ ...a, sessions: this.runtime?.agentSessions(a.id) ?? [] })),
    };
  }

  private changed(): void {
    if (this.closed) return;
    this.bus.emit({ type: 'agents.changed', data: this.status() });
  }

  // ------------------------------------------------------------------ sign-in

  /** Certificate check before the first sign-in: a self-signed certificate must be confirmed by fingerprint. */
  async checkCertificate(): Promise<ServerCertificate | null> {
    return probeCertificate(this.url, { proxy: this.transport().proxy }).catch((e) => {
      throw userError(e);
    });
  }

  async login(username: string, password: string, trustCertPem?: string | null): Promise<ReturnType<BackendLink['status']>> {
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
    const token = await this.token();
    if (token) await requestJson(`${this.url}/api/logout`, 'POST', {}, this.transport(), { Authorization: `Bearer ${token}` }).catch(() => undefined);
    await this.vault.store.delete(TOKEN_REF);
    this.repo.setSetting('backend.role', '');
    this.disconnect('signed-out');
    this.audit.record(null, 'Signed out from the backend');
  }

  /** Changing the backend address needs valid admin credentials of the CURRENT backend. */
  async changeBackend(newUrl: string, adminUser: string, adminPassword: string, opts: { proxy?: string } = {}): Promise<ReturnType<BackendLink['status']>> {
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
    if (opts.proxy !== undefined) this.repo.setSetting('backend.proxy', opts.proxy);
    this.audit.record(null, 'Backend address changed', { to: target, confirmedBy: adminUser });
    this.changed();
    return this.status();
  }

  setProxy(proxy: string): void {
    if (proxy && !/^(https?|socks5h?):\/\//i.test(proxy)) throw new SuiteError('Proxy must look like http://host:port or socks5://user:pass@host:port');
    this.repo.setSetting('backend.proxy', proxy);
    this.disconnect(this.state === 'signed-out' ? 'signed-out' : 'offline');
    void this.start();
  }

  /** All agents of this account (also offline ones) with live state – for "Run on" and the Agents page. */
  async agentList(): Promise<Array<AgentInfo & { sessions: string[]; lastSeenAt: string | null }>> {
    const token = await this.token();
    const known = token
      ? await requestJson<Array<{ id: number; name: string; info: Record<string, string>; lastSeenAt: string | null; lastIp: string | null }>>(`${this.url}/api/agents`, 'GET', undefined, this.transport(), { Authorization: `Bearer ${token}` }).catch(() => [])
      : [];
    const out = new Map<number, AgentInfo & { sessions: string[]; lastSeenAt: string | null }>();
    for (const d of known) out.set(d.id, { id: d.id, name: d.name, info: d.info ?? {}, paused: false, ip: d.lastIp, connectedAt: null, online: false, sessions: [], lastSeenAt: d.lastSeenAt });
    for (const a of this.agents.values()) out.set(a.id, { ...(out.get(a.id) ?? { lastSeenAt: null }), ...a, sessions: this.runtime?.agentSessions(a.id) ?? [] });
    return [...out.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  /** Account administration (admins only) – proxied to the backend's admin API. */
  async admin(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.token();
    if (!token) throw new SuiteError('Not signed in to the backend');
    if (this.repo.getSetting('backend.role') !== 'admin') throw new SuiteError('Only admins can manage accounts', 403);
    return requestJson(`${this.url}/api/admin/${path.replace(/^\/+/, '')}`, method, method === 'GET' || method === 'DELETE' ? undefined : body ?? {}, this.transport(), { Authorization: `Bearer ${token}` }).catch((e) => {
      throw userError(e);
    });
  }

  // ------------------------------------------------------------------ relay connection

  async start(): Promise<void> {
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
