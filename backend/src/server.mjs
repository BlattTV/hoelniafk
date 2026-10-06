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
 * Updates (optional, config.updatesUpstream = local hoelni-updates server, e.g. http://127.0.0.1:8787):
 *   GET  /updates/api/public-key, /updates/api/channels/<ch>/latest, /updates/files/<build>/<file>
 *        read-only pass-through for signed-in managers/agents (Bearer device token); the update
 *        server's admin API is never exposed. Releases stay Ed25519-signed end to end.
 * Downloads (public, with updatesUpstream): GET /download (page), GET /download/<installer>.exe –
 *   the Windows installers of suite and agent that the update server built.
 * Admin API (Bearer token of a MANAGER signed in with an ADMIN account – the manager shows the
 * account administration only then):
 *   GET    /api/admin/overview            accounts, signed-in devices, activity
 *   POST   /api/admin/users               { username, password, role }
 *   PATCH  /api/admin/users/:id           { password?, role?, disabled? }
 *   DELETE /api/admin/users/:id
 *   DELETE /api/admin/devices/:id         revoke a manager/agent sign-in
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { HttpError, SYNC_MAX_BYTES } from './accounts.mjs';


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

/** Streams one GET from the local update server (no request headers are forwarded). */
function proxyUpdates(target, res) {
  return new Promise((resolve) => {
    const up = http.get(target, { timeout: 15_000 }, (r) => {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      for (const h of ['content-type', 'content-length', 'content-disposition']) if (r.headers[h]) headers[h] = r.headers[h];
      res.writeHead(r.statusCode ?? 502, headers);
      r.pipe(res);
      r.on('end', resolve);
      r.on('error', () => { res.destroy(); resolve(); });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Update server not reachable' }));
      } else res.destroy();
      resolve();
    });
  });
}

function upstreamJson(target) {
  return new Promise((resolve) => {
    const up = http.get(target, { timeout: 10_000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        try {
          resolve(r.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
        } catch {
          resolve(null);
        }
      });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => resolve(null));
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let logoUri;
function logo() {
  if (logoUri === undefined) {
    try {
      logoUri = `data:image/png;base64,${fs.readFileSync(new URL('../../public/img/logo-card.png', import.meta.url)).toString('base64')}`;
    } catch {
      logoUri = '';
    }
  }
  return logoUri;
}

/** Public download page for new PCs: the installers the update server built (no sign-in needed – they contain no secrets). */
function downloadPage(items, publicUrl) {
  const card = (it, title, text) =>
    it
      ? `<section><h2>${esc(title)}</h2><p>${text}</p><a class="btn" href="/download/${encodeURIComponent(it.file)}">Herunterladen</a>
        <p class="meta">${esc(it.file)} · ${(it.size / 1e6).toFixed(0)} MB · Version ${esc(it.version)}${it.build ? ` · Build ${esc(it.build)}` : ''}<br>SHA-256 <code>${esc(it.sha256)}</code></p></section>`
      : `<section><h2>${esc(title)}</h2><p class="meta">Noch nicht gebaut – er entsteht beim nächsten <code>hoelni-updates build</code>.</p></section>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hoelni – Download</title>
<meta name="color-scheme" content="light dark"><link rel="stylesheet" href="/app/download.css"><link rel="icon" href="/app/icon-192.png"></head>
<body><main>${logo() ? `<img class="logo" src="/app/icon-192.png" alt="Hoelni">` : ''}<h1>Hoelni herunterladen</h1><p class="sub">Einmal installieren – danach aktualisieren sich die Programme selbst.</p>
${card(items.suite, 'Hoelni Client Suite', 'Das Hauptprogramm für deinen PC: Identitäten, AFK-Sessions, Discord, Outlook und das Minecraft-Fenster.')}
${card(items.agent, 'Hoelni Agent', `Für PCs in anderen Haushalten: installieren, mit dem Hoelni-Konto anmelden, fertig. Startet mit Windows im Hintergrund.${publicUrl ? ` Verbindet sich mit <code>${esc(publicUrl)}</code>.` : ''}`)}
${items['linux-x64'] || items['linux-arm64'] ? `<section><h2>Hoelni Agent für Linux</h2><p>Für Server, VMs, Mini-PCs und Raspberry Pi (64 Bit) – läuft als Dienst und aktualisiert sich selbst. Dieser Befehl lädt automatisch das passende Paket für den Rechner:</p>
<p><code>curl -fL ${esc(publicUrl ? publicUrl.replace(/\/+$/, '') : '')}/download/latest/linux-$(uname -m) | tar xz &amp;&amp; sudo hoelni-agent/install.sh</code><br>danach <code>sudo hoelni-agent login --user NAME</code>.</p></section>` : ''}
${card(items['linux-x64'], 'Linux x64 (Intel/AMD)', 'Paket für Intel- und AMD-Rechner – auch die meisten VMs.')}
${card(items['linux-arm64'], 'Linux ARM64 (z. B. Raspberry Pi 4/5)', 'Paket für 64-Bit-ARM.')}
${card(items['android-control'], 'Hoelni Control (Android)', `Steuert deine Suite vom Handy aus: Sessions starten und stoppen, Chat, Makros, Agents – mit Widgets für den Startbildschirm. Die Sessions laufen dabei weiter auf deinem PC. Ohne App geht es auch im Browser: <a href="/app/">${esc(publicUrl ? `${publicUrl.replace(/\/+$/, '')}/app` : '/app')}</a>.`)}
${card(items.android, 'Hoelni Agent für Android', 'Das Handy als Agent: APK auf dem Handy herunterladen und öffnen (Installation aus dieser Quelle einmal erlauben), mit dem Hoelni-Konto anmelden – die AFK-Sessions laufen dann im Hintergrund, auch bei ausgeschaltetem Bildschirm. Am besten am Ladekabel und im WLAN. Neue Versionen meldet die App selbst.')}
<p class="meta">Windows zeigt bei nicht signierten Programmen evtl. „Der Computer wurde durch Windows geschützt“ → <b>Weitere Informationen</b> → <b>Trotzdem ausführen</b>.</p>
</main></body></html>`;
}

const CONTROL_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.woff2': 'font/woff2' };
const CONTROL_DIR = new URL('../../control-app/', import.meta.url);

/** Short hash over the files of the Control app (changes with every new version of it). */
function controlBuild() {
  const h = crypto.createHash('sha256');
  for (const f of ['app.js', 'app.css', 'index.html']) {
    try {
      h.update(fs.readFileSync(new URL(f, CONTROL_DIR)));
    } catch {
      /* missing file: 404 later */
    }
  }
  return h.digest('hex').slice(0, 10);
}

/** The "Hoelni Control" web app (also inside the Android app) – static files, same origin as the API. */
function serveControlApp(p, res, search = '') {
  if (p === '/app') {
    // relative file names in the page need the trailing slash
    res.writeHead(302, { Location: `/app/${search}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  const rel = p === '/app/' ? 'index.html' : p.slice('/app/'.length);
  if (!/^[a-z0-9_-]+(\.[a-z0-9]+)+$/i.test(rel)) throw new HttpError(404, 'Not found');
  const type = CONTROL_TYPES[rel.slice(rel.lastIndexOf('.'))];
  let data;
  try {
    data = type ? fs.readFileSync(new URL(rel, CONTROL_DIR)) : null;
  } catch {
    data = null;
  }
  if (!data) throw new HttpError(404, 'Not found');
  let cache = 'no-cache';
  if (rel === 'index.html') {
    // The page names its script and styles with a hash of their content: a changed app gets new
    // addresses, so no cache on the way (reverse proxy "cache assets", WebView) can keep the old one.
    const build = controlBuild();
    data = Buffer.from(
      data
        .toString('utf8')
        .replace('href="app.css"', `href="app.css?v=${build}"`)
        .replace('src="app.js"', `src="app.js?v=${build}"`)
        .replace('</head>', `<meta name="hoelni-build" content="${build}">\n</head>`),
    );
    cache = 'no-store';
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://mc-heads.net; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(data);
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
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, service: 'hoelni-backend', version, updates: !!config.updatesUpstream });

      // ------------------------------------------------------------ updates pass-through
      if (p === '/updates' || p.startsWith('/updates/')) {
        if (!config.updatesUpstream) throw new HttpError(404, 'This backend does not distribute updates');
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        const sub = p.slice('/updates'.length) || '/';
        const allowed = sub === '/health' || sub === '/api/public-key' || /^\/api\/channels\/[a-z][a-z0-9-]{0,30}\/latest$/.test(sub) || /^\/files\/\d+\/[^/]+$/.test(sub);
        if (!allowed) throw new HttpError(404, 'Not found');
        if (sub !== '/health' && !accounts.deviceByToken(bearer(req))) throw new HttpError(401, 'Sign in to the backend to receive updates');
        return proxyUpdates(`${config.updatesUpstream.replace(/\/+$/, '')}${sub}`, res);
      }

      // ------------------------------------------------------------ downloads for new PCs (public)
      if (req.method === 'GET' && (p === '/download' || p === '/download/')) {
        const data = config.updatesUpstream ? await upstreamJson(`${config.updatesUpstream.replace(/\/+$/, '')}/api/downloads`) : null;
        return send(res, 200, downloadPage(data?.items ?? {}, config.publicUrl), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" });
      }
      if (req.method === 'GET' && p === '/download.json') {
        // the same list as the page – the Android app checks it for a newer version of itself
        const data = config.updatesUpstream ? await upstreamJson(`${config.updatesUpstream.replace(/\/+$/, '')}/api/downloads`) : null;
        const items = Object.fromEntries(Object.entries(data?.items ?? {}).map(([k, v]) => [k, { file: v.file, version: v.version, build: v.build ?? null, size: v.size, sha256: v.sha256 }]));
        return send(res, 200, { items });
      }
      // stable link for scripts: /download/latest/linux-x64 → the current file
      if (req.method === 'GET' && /^\/download\/latest\/[a-z0-9_-]{1,40}$/.test(p)) {
        const data = config.updatesUpstream ? await upstreamJson(`${config.updatesUpstream.replace(/\/+$/, '')}/api/downloads`) : null;
        const ALIAS = { 'linux-x86_64': 'linux-x64', 'linux-amd64': 'linux-x64', 'linux-aarch64': 'linux-arm64' };
        const kind = p.slice('/download/latest/'.length);
        const it = data?.items?.[ALIAS[kind] ?? kind];
        if (!it?.file) throw new HttpError(404, 'Not built yet');
        res.writeHead(302, { Location: `/download/${encodeURIComponent(it.file)}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && /^\/download\/[A-Za-z0-9._-]{1,120}\.(exe|apk|tar\.gz)$/.test(p)) {
        if (!config.updatesUpstream) throw new HttpError(404, 'Not found');
        return proxyUpdates(`${config.updatesUpstream.replace(/\/+$/, '')}/downloads/${p.slice('/download/'.length)}`, res);
      }

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
      // ------------------------------------------------------------ "Hoelni Control": phone / browser controls the active PC
      if (req.method === 'GET' && (p === '/app' || p.startsWith('/app/'))) return serveControlApp(p, res, url.search);
      if (p.startsWith('/api/remote/')) {
        const device = accounts.deviceByToken(bearer(req));
        if (!device) throw new HttpError(401, 'Signed out – sign in again');
        if (device.kind === 'agent') throw new HttpError(403, 'Agents cannot control the suite');
        accounts.touchDevice(device.id, ip);
        if (req.method === 'GET' && p === '/api/remote/status') {
          const g = relay.managers.get(device.userId);
          const pcs = g ? [...g.list].map((c) => relay.managerView(c, g)) : [];
          return send(res, 200, { user: { username: device.username, role: device.role }, device: { id: device.id, name: device.name }, active: pcs.find((x) => x.active) ?? null, pcs });
        }
        if (req.method === 'POST' && p === '/api/remote/rpc') {
          const b = await readBody(req, 256 * 1024);
          const method = String(b.method ?? 'GET').toUpperCase();
          const path = String(b.path ?? '');
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !/^\/api\/[A-Za-z0-9/_.:%?=&,-]{1,400}$/.test(path) || path.includes('..')) throw new HttpError(400, 'Invalid request');
          const r = await relay.rpc(device.userId, { method, path, body: b.body ?? null, by: device.name });
          return send(res, r.status, r.body ?? {});
        }
        if (req.method === 'GET' && p === '/api/remote/events') {
          // live events of the active PC (server-sent events; the app reads them with fetch + Authorization)
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(': hello\n\n');
          const stop = relay.addListener(device.userId, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
          const beat = setInterval(() => {
            if (!accounts.isDeviceActive(device.id)) return res.end();
            res.write(': ping\n\n');
          }, 20_000);
          req.on('close', () => {
            clearInterval(beat);
            stop();
          });
          return;
        }
        throw new HttpError(404, 'Not found');
      }
      if (p === '/api/sync') {
        // settings sync between the suites of this account – the backend only stores the encrypted blob
        const device = accounts.deviceByToken(bearer(req));
        if (!device) throw new HttpError(401, 'Signed out – sign in again');
        if (device.kind !== 'manager') throw new HttpError(403, 'Only the Hoelni Client Suite synchronizes settings');
        if (req.method === 'GET') {
          const cur = accounts.getSync(device.userId);
          return send(res, 200, cur ? { version: cur.version, data: cur.data.toString('base64'), updatedAt: cur.updatedAt, updatedBy: cur.updatedBy } : { version: 0, data: null });
        }
        if (req.method === 'POST') {
          // the suite checks the account password before it derives the sync key from it (no new device)
          const b = await readBody(req);
          accounts.authenticate(device.username, String(b.password ?? ''), ip);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'PUT') {
          const b = await readBody(req, Math.ceil((SYNC_MAX_BYTES * 4) / 3) + 4096);
          const r = accounts.putSync(device.userId, b.expected, Buffer.from(String(b.data ?? ''), 'base64'), device.name);
          relay.syncChanged(device.userId, r.version, device.id);
          return send(res, 200, r);
        }
        throw new HttpError(405, 'Method not allowed');
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
