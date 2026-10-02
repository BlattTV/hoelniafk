/**
 * Relay: connects a user's manager (AFK suite) with the same user's agents.
 *
 *   manager ──wss /relay (device token)──┐
 *                                         ├── Relay (per user)
 *   agent A ──wss /relay (device token)──┤
 *   agent B ──wss /relay (device token)──┘
 *
 * Frames (JSON):
 *   agent → relay:    { t:'hello', info } | { t:'paused', value } | { t:'host', m }
 *   relay → manager:  { t:'agent.online', agent } | { t:'agent.offline', id } | { t:'agent.paused', id, value }
 *                     | { t:'from', agentId, frame }
 *                     | { t:'active' } | { t:'standby', active } | { t:'managers', list } | { t:'sync', version }
 *                     | { t:'rpc', id, req } (to the active manager: a request of a controller) | { t:'controllers', n }
 *                     | { t:'rpc.res', id, status, body } (to a standby manager: answer of the active PC) | { t:'event', ev }
 *   manager → relay:  { t:'to', agentId, frame }            (only to agents of the same user; active manager only)
 *                     | { t:'claim' }                        (this PC takes over: becomes the active manager)
 *                     | { t:'rpc', id, req }                 (standby PC: request for the active PC – remote control)
 *                     | { t:'rpc.res', id, status, body }    (active PC: answer) | { t:'event', ev } (active PC: live event)
 *
 * Remote control: standby PCs and the "Hoelni Control" app (phone / browser, REST + event stream on
 * the backend) send API requests to the ACTIVE PC – the sessions keep running where they are, only
 * the control moves. The active PC checks every request against its own list of allowed actions.
 *   relay → agent:    { t:'host', m } | { t:'reset' } (manager (re)connected or gone: start clean)
 *                     | { t:'manager', online } | { t:'bye', reason }
 *
 * Several suites (managers) of one account can be connected – e.g. a desktop and a laptop that share
 * their settings. Exactly one is ACTIVE: it runs the sessions and controls the agents. The others
 * are in STANDBY (they see and edit everything, but start nothing) until one of them claims.
 * A suite that connects while no suite of the account is active becomes active by itself.
 */
import { WebSocketServer } from 'ws';

export class Relay {
  constructor(accounts, log = console) {
    this.accounts = accounts;
    this.log = log;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    this.managers = new Map(); // userId → { active, list }
    this.listeners = new Map(); // userId → Set<fn(event)> – "Hoelni Control" apps following the live events
    this.pending = new Map(); // rpc id → { resolve, reject, timer }
    this.rpcSeq = 0;
    this.agents = new Map(); // deviceId → conn
  }

  handleUpgrade = (req, socket, head, ip) => {
    const token = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const device = this.accounts.deviceByToken(token);
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    if (device.kind !== 'manager' && device.kind !== 'agent') {
      // the control app uses the REST API + event stream, never the relay
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => (device.kind === 'manager' ? this.onManager(ws, device, ip) : this.onAgent(ws, device, ip)));
  };

  send(ws, frame) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(frame));
  }

  keepAlive(ws, device) {
    let alive = true;
    ws.on('pong', () => (alive = true));
    const t = setInterval(() => {
      if (!alive) return ws.terminate();
      // Revocations from the CLI (another process) or password changes end the connection here.
      if (!this.accounts.isDeviceActive(device.id)) {
        this.send(ws, { t: 'bye', reason: 'Access revoked – signed out' });
        setTimeout(() => ws.terminate(), 200);
        return;
      }
      alive = false;
      ws.ping();
    }, Number(process.env.HOELNI_RELAY_PING_MS) || 20_000);
    ws.on('close', () => clearInterval(t));
  }

  agentView(c) {
    return { id: c.device.id, name: c.device.name, info: c.info, paused: c.paused, ip: c.ip, connectedAt: c.connectedAt };
  }

  // ---------------------------------------------------------------- manager
  group(userId) {
    let g = this.managers.get(userId);
    if (!g) {
      g = { active: null, list: new Set() };
      this.managers.set(userId, g);
    }
    return g;
  }

  /** The active manager of an account (runs the sessions, controls the agents). */
  activeManager(userId) {
    return this.managers.get(userId)?.active ?? null;
  }

  managerView(c, g) {
    return { deviceId: c.device.id, name: c.device.name, ip: c.ip, connectedAt: c.connectedAt, active: g.active === c };
  }

  announceManagers(userId) {
    const g = this.managers.get(userId);
    if (!g) return;
    const list = [...g.list].map((c) => this.managerView(c, g));
    for (const c of g.list) this.send(c.ws, { t: 'managers', list, self: c.device.id });
  }

  /** `conn` becomes the active manager; the previous one goes to standby and the agents start clean. */
  activate(userId, conn) {
    const g = this.group(userId);
    const prev = g.active;
    g.active = conn;
    if (prev && prev !== conn) this.send(prev.ws, { t: 'standby', active: { name: conn.device.name, deviceId: conn.device.id } });
    this.send(conn.ws, { t: 'active' });
    for (const a of this.agentsOf(userId)) {
      this.send(conn.ws, { t: 'agent.online', agent: this.agentView(a) });
      this.send(a.ws, { t: 'reset' });
      this.send(a.ws, { t: 'manager', online: true });
    }
    if (prev !== conn) this.log.info?.(`manager "${conn.device.name}" of ${conn.device.username} is active${prev ? ` (was "${prev.device.name}")` : ''}`);
    this.announceManagers(userId);
    this.announceControllers(userId);
  }

  onManager(ws, device, ip) {
    const g = this.group(device.userId);
    for (const old of g.list) {
      if (old.device.id !== device.id) continue;
      // the same PC reconnected: the new connection replaces the old one (keeps its role)
      g.list.delete(old);
      if (g.active === old) g.active = null;
      this.send(old.ws, { t: 'bye', reason: 'Replaced by a new connection of this PC' });
      setTimeout(() => old.ws.terminate(), 200);
    }
    const conn = { ws, device, ip, connectedAt: new Date().toISOString() };
    g.list.add(conn);
    this.accounts.touchDevice(device.id, ip);
    this.keepAlive(ws, device);
    this.log.info?.(`manager "${device.name}" of ${device.username} connected from ${ip}`);
    if (!g.active) this.activate(device.userId, conn);
    else {
      this.send(ws, { t: 'standby', active: { name: g.active.device.name, deviceId: g.active.device.id } });
      this.announceManagers(device.userId);
      this.announceControllers(device.userId);
    }
    ws.on('message', (data) => {
      let f;
      try {
        f = JSON.parse(String(data));
      } catch {
        return;
      }
      if (f?.t === 'claim') {
        if (g.list.has(conn)) this.activate(device.userId, conn);
        return;
      }
      if (f?.t === 'rpc.res') {
        const p = this.pending.get(Number(f.id));
        if (!p || p.conn !== conn) return; // only the PC that was asked answers
        this.pending.delete(Number(f.id));
        clearTimeout(p.timer);
        p.resolve({ status: Number(f.status) || 500, body: f.body ?? null });
        return;
      }
      if (f?.t === 'event') {
        if (g.active === conn && f.ev && typeof f.ev.type === 'string') this.fanOut(device.userId, f.ev);
        return;
      }
      if (f?.t === 'rpc') {
        // a standby PC controls the active one
        if (g.active === conn || !f.req) return;
        void this.rpc(device.userId, f.req).then((r) => this.send(ws, { t: 'rpc.res', id: f.id, status: r.status, body: r.body }));
        return;
      }
      if (f?.t !== 'to' || f.frame?.t !== 'host') return; // managers can only send runtime commands
      if (g.active !== conn) return; // standby PCs never control agents
      const a = this.agents.get(Number(f.agentId));
      if (!a || a.device.userId !== device.userId) return; // never across accounts
      this.send(a.ws, { t: 'host', m: f.frame.m });
    });
    ws.on('close', () => {
      if (!g.list.delete(conn)) return;
      this.accounts.touchDevice(device.id, ip);
      this.log.info?.(`manager "${device.name}" of ${device.username} disconnected`);
      for (const [id, p] of this.pending) {
        if (p.conn !== conn) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve({ status: 503, body: { error: 'The PC went offline' } });
      }
      if (g.active === conn) {
        g.active = null;
        // Without an active manager nobody controls the sessions: agents stop them. A standby PC takes
        // over only when asked (the active PC may just have lost its connection for a moment).
        for (const a of this.agentsOf(device.userId)) {
          this.send(a.ws, { t: 'reset' });
          this.send(a.ws, { t: 'manager', online: false });
        }
      }
      this.announceManagers(device.userId);
    });
    ws.on('error', () => undefined);
  }

  // ---------------------------------------------------------------- remote control

  /** Number of controllers (standby PCs + control apps) – the active PC only sends live events while there are some. */
  controllersOf(userId) {
    const g = this.managers.get(userId);
    return (g ? [...g.list].filter((c) => c !== g.active).length : 0) + (this.listeners.get(userId)?.size ?? 0);
  }

  announceControllers(userId) {
    const a = this.activeManager(userId);
    if (a) this.send(a.ws, { t: 'controllers', n: this.controllersOf(userId) });
  }

  /** A request for the active PC of the account → its answer { status, body }. */
  rpc(userId, req, timeoutMs = 30_000) {
    const a = this.activeManager(userId);
    if (!a) return Promise.resolve({ status: 503, body: { error: 'No PC of this account is active right now – start the Hoelni Client Suite on a PC' } });
    const id = ++this.rpcSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 504, body: { error: 'The PC did not answer in time' } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, conn: a });
      this.send(a.ws, { t: 'rpc', id, req });
    });
  }

  /** "Hoelni Control" follows the live events of the active PC. Returns the function that stops it. */
  addListener(userId, fn) {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(fn);
    this.announceControllers(userId);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(userId);
      this.announceControllers(userId);
    };
  }

  fanOut(userId, ev) {
    const g = this.managers.get(userId);
    if (g) for (const c of g.list) if (c !== g.active) this.send(c.ws, { t: 'event', ev });
    for (const fn of this.listeners.get(userId) ?? []) {
      try {
        fn(ev);
      } catch {
        /* a closed stream */
      }
    }
  }

  /** New settings of an account were stored: the other suites of the account fetch them. */
  syncChanged(userId, version, fromDeviceId) {
    const g = this.managers.get(userId);
    if (!g) return;
    for (const c of g.list) if (c.device.id !== fromDeviceId) this.send(c.ws, { t: 'sync', version });
  }

  // ---------------------------------------------------------------- agent
  agentsOf(userId) {
    return [...this.agents.values()].filter((a) => a.device.userId === userId);
  }

  onAgent(ws, device, ip) {
    const old = this.agents.get(device.id);
    if (old) {
      this.send(old.ws, { t: 'bye', reason: 'Replaced by a new connection of this agent' });
      setTimeout(() => old.ws.terminate(), 200);
    }
    const conn = { ws, device, ip, info: device.info ?? {}, paused: false, connectedAt: new Date().toISOString() };
    this.agents.set(device.id, conn);
    this.accounts.touchDevice(device.id, ip);
    this.keepAlive(ws, device);
    this.log.info?.(`agent "${device.name}" of ${device.username} connected from ${ip}`);
    const manager = () => this.activeManager(device.userId);
    this.send(ws, { t: 'manager', online: !!manager() });
    this.send(manager()?.ws, { t: 'agent.online', agent: this.agentView(conn) });
    ws.on('message', (data) => {
      let f;
      try {
        f = JSON.parse(String(data));
      } catch {
        return;
      }
      if (f?.t === 'host') this.send(manager()?.ws, { t: 'from', agentId: device.id, frame: f });
      else if (f?.t === 'hello' && f.info && typeof f.info === 'object') {
        conn.info = Object.fromEntries(Object.entries(f.info).slice(0, 12).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 200)]));
        this.accounts.touchDevice(device.id, ip, conn.info);
        this.send(manager()?.ws, { t: 'agent.online', agent: this.agentView(conn) });
      } else if (f?.t === 'paused') {
        conn.paused = !!f.value;
        this.send(manager()?.ws, { t: 'agent.paused', id: device.id, value: conn.paused });
      }
    });
    ws.on('close', () => {
      if (this.agents.get(device.id) !== conn) return;
      this.agents.delete(device.id);
      this.accounts.touchDevice(device.id, ip);
      this.send(manager()?.ws, { t: 'agent.offline', id: device.id });
      this.log.info?.(`agent "${device.name}" of ${device.username} disconnected`);
    });
    ws.on('error', () => undefined);
  }

  /** Admin revoked a device or disabled a user: disconnect immediately. */
  kickDevice(deviceId, reason) {
    const a = this.agents.get(deviceId);
    if (a) {
      this.send(a.ws, { t: 'bye', reason });
      setTimeout(() => a.ws.terminate(), 200);
    }
    for (const g of this.managers.values()) {
      for (const m of g.list) {
        if (m.device.id === deviceId) {
          this.send(m.ws, { t: 'bye', reason });
          setTimeout(() => m.ws.terminate(), 200);
        }
      }
    }
  }

  kickUser(userId, reason) {
    for (const a of this.agentsOf(userId)) this.kickDevice(a.device.id, reason);
    for (const m of [...(this.managers.get(userId)?.list ?? [])]) this.kickDevice(m.device.id, reason);
  }

  allManagers() {
    return [...this.managers.values()].flatMap((g) => [...g.list].map((m) => ({ m, active: g.active === m })));
  }

  online() {
    return {
      managers: this.allManagers().map(({ m, active }) => ({ deviceId: m.device.id, userId: m.device.userId, ip: m.ip, active })),
      agents: [...this.agents.values()].map((a) => ({ deviceId: a.device.id, userId: a.device.userId, ip: a.ip, paused: a.paused })),
    };
  }

  close() {
    for (const c of [...this.agents.values(), ...this.allManagers().map((x) => x.m)]) {
      this.send(c.ws, { t: 'bye', reason: 'Backend restarting' });
      c.ws.terminate();
    }
    this.wss.close();
  }
}
