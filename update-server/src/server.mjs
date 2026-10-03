/**
 * HTTP API of the update server.
 *
 * Public (read-only, used by the suites):
 *   GET  /health
 *   GET  /api/public-key                      { publicKey, keyId }
 *   GET  /api/channels/:channel/latest         signed envelope { manifest, signature, keyId }
 *   GET  /api/releases                         manifests (newest first)
 *   GET  /files/:build/:file                   bundle / installer
 *   GET  /api/downloads                        latest installers (Windows suite + agent, Android agent app) for new devices
 *   GET  /downloads/:file                      installer download
 *   GET  /                                     status page
 * Admin (Authorization: Bearer <admin token>):
 *   POST /api/build            { channel?, ifChanged? }   build from git now
 *   GET  /api/build                                       build status
 *   PUT  /api/releases/:build/installer?name=<file.exe>&desktopVersion=<v>   raw body upload
 *   POST /api/channels/:channel { build }                 promote / roll back a channel
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fingerprint } from './sign.mjs';

const MAX_INSTALLER = 600 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function statusPage(store, builder, publicKey) {
  const ch = store.channels;
  const rows = store
    .list()
    .slice(0, 30)
    .map((m) => {
      const tags = Object.entries(ch).filter(([, b]) => b === m.build).map(([c]) => `<span class="tag">${esc(c)}</span>`).join(' ');
      return `<tr><td>${m.build} ${tags}</td><td>${esc(m.version)}</td><td>${esc(m.createdAt.replace('T', ' ').slice(0, 19))}</td><td><a href="/files/${m.build}/${esc(m.backend.file)}">backend</a> (${(m.backend.size / 1e6).toFixed(1)} MB)${m.installer ? ` · <a href="/files/${m.build}/${esc(m.installer.file)}">installer</a>` : ''}</td><td>${m.notes.slice(0, 5).map(esc).join('<br>')}</td></tr>`;
    })
    .join('');
  const b = builder?.status();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hoelni Updates</title>
<style>body{font:14px system-ui;background:#0f1115;color:#e6e6e6;margin:24px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #2a2f3a;text-align:left;vertical-align:top}a{color:#6cb6ff}.tag{background:#23452e;color:#8fe39e;border-radius:4px;padding:1px 6px;font-size:12px}code{background:#1b1f27;padding:2px 6px;border-radius:4px}.muted{color:#8b93a1}</style></head>
<body><h1>Hoelni Client Suite – update server</h1>
<p>Signing key fingerprint: <code>${esc(fingerprint(publicKey))}</code></p>
<p class="muted">Builder: ${b ? `${esc(b.repo)} @ ${esc(b.branch)} · last commit <code>${esc((b.lastCommit ?? '–').slice(0, 7))}</code> · ${b.running ? 'building…' : b.last ? (b.last.ok ? (b.last.skipped ? 'up to date' : `built #${b.last.build}`) : `last build failed: ${esc(b.last.error.slice(-300))}`) : 'idle'}` : 'disabled'}</p>
<p>Installers: ${Object.values(store.downloads.items).map((i) => `<a href="/downloads/${esc(i.file)}">${esc(i.file)}</a> (${(i.size / 1e6).toFixed(0)} MB)`).join(' · ') || '<span class="muted">none yet (built with the next release, or: hoelni-updates build-installers)</span>'}</p>
<table><thead><tr><th>Build</th><th>Version</th><th>Created (UTC)</th><th>Files</th><th>Changes</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No releases yet</td></tr>'}</tbody></table></body></html>`;
}

export function createServer({ store, builder, publicKey, adminTokenHash }) {
  const isAdmin = (req) => {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !adminTokenHash) return false;
    const got = crypto.createHash('sha256').update(m[1]).digest();
    const want = Buffer.from(adminTokenHash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      let m;
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && p === '/') return send(res, 200, statusPage(store, builder, publicKey));
      if (req.method === 'GET' && p === '/api/public-key') return send(res, 200, { publicKey, keyId: fingerprint(publicKey), algorithm: 'ed25519' });
      if (req.method === 'GET' && (m = /^\/api\/channels\/([a-z][a-z0-9-]{0,30})\/latest$/.exec(p))) {
        const env = store.latest(m[1]);
        return env ? send(res, 200, env) : send(res, 404, { error: `No release in channel "${m[1]}"` });
      }
      if (req.method === 'GET' && p === '/api/releases') return send(res, 200, { channels: store.channels, releases: store.list() });
      if (req.method === 'GET' && p === '/api/downloads') return send(res, 200, { items: store.downloads.items });
      if (req.method === 'GET' && (m = /^\/downloads\/([^/]+)$/.exec(p))) {
        const file = store.downloadPath(decodeURIComponent(m[1]));
        if (!file) return send(res, 404, { error: 'Not found' });
        const st = fs.statSync(file);
        const type = /\.apk$/i.test(file) ? 'application/vnd.android.package-archive' : /\.tar\.gz$/i.test(file) ? 'application/gzip' : 'application/octet-stream'; // phones offer to install it
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${m[1]}"`, 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (req.method === 'GET' && (m = /^\/files\/(\d+)\/([^/]+)$/.exec(p))) {
        const file = store.filePath(Number(m[1]), decodeURIComponent(m[2]));
        if (!file) return send(res, 404, { error: 'Not found' });
        const st = fs.statSync(file);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${m[2]}"`, 'Cache-Control': 'public, max-age=31536000, immutable' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      // ---------------------------------------------------------------- admin
      if (p.startsWith('/api/') && !isAdmin(req)) return send(res, 401, { error: 'Admin token required' });
      if (p === '/api/build' && req.method === 'GET') return send(res, 200, builder ? builder.status() : { error: 'builder disabled' });
      if (p === '/api/build' && req.method === 'POST') {
        if (!builder) return send(res, 400, { error: 'Builder is not configured' });
        const body = JSON.parse((await readBody(req, 10_000)).toString() || '{}');
        const job = builder.build({ ifChanged: !!body.ifChanged, channel: body.channel });
        job.catch(() => undefined);
        if (body.wait) return send(res, 200, await job);
        return send(res, 202, { started: true });
      }
      if (req.method === 'PUT' && (m = /^\/api\/releases\/(\d+)\/installer$/.exec(p))) {
        const bytes = await readBody(req, MAX_INSTALLER);
        const manifest = store.attachInstaller(Number(m[1]), url.searchParams.get('name') ?? '', bytes, url.searchParams.get('desktopVersion'));
        return send(res, 200, manifest);
      }
      if (req.method === 'POST' && (m = /^\/api\/channels\/([a-z][a-z0-9-]{0,30})$/.exec(p))) {
        const body = JSON.parse((await readBody(req, 10_000)).toString() || '{}');
        store.promote(m[1], Number(body.build));
        return send(res, 200, { channels: store.channels });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      return send(res, e.status ?? 400, { error: String(e.stderr || e.message).slice(-1000) });
    }
  });
}
