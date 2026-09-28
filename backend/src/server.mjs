/**
 * HTTP(S) server of the Hoelni backend.
 *
 * Apps (Bearer device token):
 *   POST /api/login            { username, password, client: 'manager'|'agent', name, info } → { token, deviceId, user }
 *   POST /api/verify-admin     { username, password } → { ok }   (apps ask this before changing their backend address)
 *   GET  /api/me               → { user, device }
 *   POST /api/logout           revokes this device
 *   GET  /api/agents           the user's agents (manager)
 *   WS   /relay                manager / agent relay
 * Admin API (Bearer token of a MANAGER signed in with an ADMIN account – the manager shows the
 * account administration only then):
 *   GET    /api/admin/overview            accounts, signed-in devices, activity
 *   POST   /api/admin/users               { username, password, role }
 *   PATCH  /api/admin/users/:id           { password?, role?, disabled? }
 *   DELETE /api/admin/users/:id
 *   DELETE /api/admin/devices/:id         revoke a manager/agent sign-in
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { HttpError } from './accounts.mjs';


function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createBackendServer({ accounts, relay, config, version = '1.0.0', log = console }) {
  // Behind a reverse proxy the LAST X-Forwarded-For entry is the one the proxy added (earlier
  // entries come from the client and can be forged – they must not bypass the sign-in lockout).
  const clientIp = (req) => (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() : '') || req.socket.remoteAddress || '';
  const bearer = (req) => /^Bearer\s+(.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];

  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string';
    res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(json ? JSON.stringify(body) : body);
  };

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const ip = clientIp(req);
    try {
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, service: 'hoelni-backend', version });

      // ------------------------------------------------------------ app API
      if (req.method === 'POST' && p === '/api/login') {
        const b = await readBody(req);
        const user = accounts.authenticate(b.username, b.password, ip);
        const info = b.info && typeof b.info === 'object' ? Object.fromEntries(Object.entries(b.info).slice(0, 12).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 200)])) : {};
        const { deviceId, token } = accounts.registerDevice(user, b.client, b.name, info, ip);
        accounts.audit(user.username, `${b.client} signed in`, String(b.name ?? ''), ip);
        return send(res, 200, { token, deviceId, user: { username: user.username, role: user.role } });
      }
      if (req.method === 'POST' && p === '/api/verify-admin') {
        const b = await readBody(req);
        const user = accounts.authenticate(b.username, b.password, ip);
        if (user.role !== 'admin') throw new HttpError(403, 'An admin account is required');
        accounts.audit(user.username, 'Admin confirmed a backend address change in an app', '', ip);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/me' || p === '/api/logout' || p === '/api/agents') {
        const device = accounts.deviceByToken(bearer(req));
        if (!device) throw new HttpError(401, 'Signed out – sign in again');
        if (p === '/api/me') return send(res, 200, { user: { username: device.username, role: device.role }, device: { id: device.id, kind: device.kind, name: device.name } });
        if (p === '/api/logout' && req.method === 'POST') {
          accounts.revokeDevice(device.id);
          relay.kickDevice(device.id, 'Signed out');
          return send(res, 200, { ok: true });
        }
        if (p === '/api/agents') {
          const online = new Set(relay.online().agents.map((a) => a.deviceId));
          return send(res, 200, accounts.listDevices(device.userId).filter((d) => d.kind === 'agent' && !d.revoked).map((d) => ({ ...d, online: online.has(d.id) })));
        }
      }

      // ------------------------------------------------------------ admin API (used by the manager of an admin account)
      if (p.startsWith('/api/admin/')) {
        const device = accounts.deviceByToken(bearer(req));
        if (!device) throw new HttpError(401, 'Signed out – sign in again');
        if (device.role !== 'admin' || device.kind !== 'manager') throw new HttpError(403, 'Only an admin signed in to the manager can manage accounts');
        const actor = device.username;
        const b = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
        let m;
        if (p === '/api/admin/overview' && req.method === 'GET') {
          const online = relay.online();
          const onlineIds = new Set([...online.agents, ...online.managers].map((x) => x.deviceId));
          return send(res, 200, {
            users: accounts.listUsers(),
            devices: accounts.listDevices().filter((d) => !d.revoked).map((d) => ({ ...d, online: onlineIds.has(d.id), self: d.id === device.id })),
            audit: accounts.auditLog(100),
          });
        }
        if (p === '/api/admin/users' && req.method === 'POST') {
          const u = accounts.createUser(String(b.username ?? '').trim(), String(b.password ?? ''), b.role === 'admin' ? 'admin' : 'user');
          accounts.audit(actor, 'User created', `${u.username} (${u.role})`, ip);
          return send(res, 200, u);
        }
        if ((m = /^\/api\/admin\/users\/(\d+)$/.exec(p))) {
          if (req.method === 'PATCH') {
            const u = accounts.updateUser(m[1], { password: b.password, role: b.role, disabled: b.disabled });
            if (b.disabled) relay.kickUser(u.id, 'Account disabled');
            else if (b.password) relay.kickUser(u.id, 'Password changed – signed out, sign in again');
            accounts.audit(actor, 'User changed', `${u.username}${b.password ? ' password' : ''}${b.role ? ` role=${b.role}` : ''}${b.disabled !== undefined ? ` disabled=${b.disabled}` : ''}`, ip);
            return send(res, 200, u);
          }
          if (req.method === 'DELETE') {
            const u = accounts.getUser(m[1]);
            if (u.id === device.userId) throw new HttpError(400, 'You cannot delete your own account');
            relay.kickUser(u.id, 'Account deleted');
            accounts.deleteUser(u.id);
            accounts.audit(actor, 'User deleted', u.username, ip);
            return send(res, 200, { ok: true });
          }
        }
        if ((m = /^\/api\/admin\/devices\/(\d+)$/.exec(p)) && req.method === 'DELETE') {
          const d = accounts.getDevice(m[1]);
          accounts.revokeDevice(d.id);
          relay.kickDevice(d.id, 'Access revoked by the admin');
          accounts.audit(actor, 'Device revoked', `${d.username}/${d.kind}/${d.name}`, ip);
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!(e instanceof HttpError)) log.error?.(`${req.method} ${p}: ${e.stack ?? e}`);
      return send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Internal error' });
    }
  };

  const server = config.tls?.cert
    ? https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }, handler)
    : http.createServer(handler);
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/relay') return socket.destroy();
    relay.handleUpgrade(req, socket, head, clientIp(req));
  });
  return server;
}
