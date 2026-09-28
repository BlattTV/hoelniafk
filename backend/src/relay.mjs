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
 *   manager → relay:  { t:'to', agentId, frame }            (only to agents of the same user)
 *   relay → agent:    { t:'host', m } | { t:'reset' } (manager (re)connected or gone: start clean)
 *                     | { t:'manager', online } | { t:'bye', reason }
 * One manager per user is active at a time; a new manager sign-in replaces the old connection.
 */
import { WebSocketServer } from 'ws';

export class Relay {
  constructor(accounts, log = console) {
    this.accounts = accounts;
    this.log = log;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    this.managers = new Map(); // userId → conn
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
  onManager(ws, device, ip) {
    const old = this.managers.get(device.userId);
    if (old) {
      this.send(old.ws, { t: 'bye', reason: 'Another manager of this account signed in' });
      setTimeout(() => old.ws.terminate(), 200);
    }
    const conn = { ws, device, ip };
    this.managers.set(device.userId, conn);
    this.accounts.touchDevice(device.id, ip);
    this.keepAlive(ws, device);
    this.log.info?.(`manager "${device.name}" of ${device.username} connected from ${ip}`);
    for (const a of this.agentsOf(device.userId)) {
      this.send(ws, { t: 'agent.online', agent: this.agentView(a) });
      this.send(a.ws, { t: 'reset' });
      this.send(a.ws, { t: 'manager', online: true });
    }
    ws.on('message', (data) => {
      let f;
      try {
        f = JSON.parse(String(data));
      } catch {
        return;
      }
      if (f?.t !== 'to' || f.frame?.t !== 'host') return; // managers can only send runtime commands
      const a = this.agents.get(Number(f.agentId));
      if (!a || a.device.userId !== device.userId) return; // never across accounts
      this.send(a.ws, { t: 'host', m: f.frame.m });
    });
    ws.on('close', () => {
      if (this.managers.get(device.userId) !== conn) return;
      this.managers.delete(device.userId);
      this.accounts.touchDevice(device.id, ip);
      this.log.info?.(`manager "${device.name}" of ${device.username} disconnected`);
      // Without a manager nobody controls the sessions: agents stop them.
      for (const a of this.agentsOf(device.userId)) {
        this.send(a.ws, { t: 'reset' });
        this.send(a.ws, { t: 'manager', online: false });
      }
    });
    ws.on('error', () => undefined);
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
    const manager = () => this.managers.get(device.userId);
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
    for (const m of this.managers.values()) {
      if (m.device.id === deviceId) {
        this.send(m.ws, { t: 'bye', reason });
        setTimeout(() => m.ws.terminate(), 200);
      }
    }
  }

  kickUser(userId, reason) {
    for (const a of this.agentsOf(userId)) this.kickDevice(a.device.id, reason);
    const m = this.managers.get(userId);
    if (m) this.kickDevice(m.device.id, reason);
  }

  online() {
    return {
      managers: [...this.managers.values()].map((m) => ({ deviceId: m.device.id, userId: m.device.userId, ip: m.ip })),
      agents: [...this.agents.values()].map((a) => ({ deviceId: a.device.id, userId: a.device.userId, ip: a.ip, paused: a.paused })),
    };
  }

  close() {
    for (const c of [...this.agents.values(), ...this.managers.values()]) {
      this.send(c.ws, { t: 'bye', reason: 'Backend restarting' });
      c.ws.terminate();
    }
    this.wss.close();
  }
}
