/**
 * Interactive game view relay.
 *
 *  browser /view/<token>/            ── prismarine-viewer renderer (patched bundle) ──┐
 *          ├─ socket.io role=render  ◀── world/entity/position stream ── runtime host ─┘ (same session)
 *          └─ socket.io role=control ──▶ keyboard/mouse → SessionManager.control()
 *
 * The <token> is an unguessable capability created by openInteractiveView() and
 * revoked by hideInteractiveView() or when the session ends.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Server as IoServer, type Socket } from 'socket.io';
import type { Suite } from '../app.js';
import { createLogger } from '../core/logger.js';
import type { ControlInput } from '../runtime/types.js';

const log = createLogger('view');
const require = createRequire(import.meta.url);
const VIEWER_PUBLIC = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public');
const OWN_VIEW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/view');

export const VIEW_CSP = [
  "default-src 'self'",
  // The prismarine-viewer bundle compiles JSON schemas at runtime (ajv) → needs eval.
  // Only served on token-protected /view/ pages; the main UI keeps a strict policy.
  "script-src 'self' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

let patchedBundle: Buffer | null = null;
function viewerBundle(): Buffer {
  if (!patchedBundle) {
    const src = fs.readFileSync(path.join(VIEWER_PUBLIC, 'index.js'), 'utf8');
    const needle = '{path:window.location.pathname+"socket.io"}';
    if (!src.includes(needle)) throw new Error('Unsupported prismarine-viewer bundle (socket path not found)');
    patchedBundle = Buffer.from(
      src.replace(needle, '{path:"/view-io/",query:{vt:window.location.pathname.split("/")[2],role:"render"}}'),
      'utf8',
    );
  }
  return patchedBundle;
}

const CONTROL_KINDS = new Set(['state', 'look', 'lookDelta', 'attack', 'use', 'dig', 'stopDig', 'place', 'hotbar', 'clearControls']);
const CONTROLS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']);

function validControl(x: any): x is ControlInput {
  if (!x || typeof x !== 'object' || !CONTROL_KINDS.has(x.kind)) return false;
  if (x.kind === 'state') return CONTROLS.has(x.control) && typeof x.value === 'boolean';
  if (x.kind === 'look') return Number.isFinite(x.yaw) && Number.isFinite(x.pitch);
  if (x.kind === 'lookDelta') return Number.isFinite(x.dYaw) && Number.isFinite(x.dPitch) && Math.abs(x.dYaw) < 10 && Math.abs(x.dPitch) < 10;
  if (x.kind === 'hotbar') return Number.isInteger(x.slot) && x.slot >= 0 && x.slot <= 8;
  return true;
}

export function registerViewRelay(app: FastifyInstance, suite: Suite, isAllowedHost: (h: string) => boolean, isAllowedOrigin: (o: string) => boolean): void {
  // ---------------------------------------------------------------- static files of the view page
  app.get('/view/:token/*', async (req, reply) => {
    const { token } = req.params as { token: string; '*': string };
    const rel = (req.params as any)['*'] as string;
    const rec = suite.sessions.sessionForViewToken(token);
    if (!rec) return reply.code(404).type('text/plain').send('View closed');
    reply.header('Content-Security-Policy', VIEW_CSP);
    reply.header('Cache-Control', rel.startsWith('textures/') || rel.startsWith('blocksStates/') ? 'private, max-age=3600' : 'no-store');
    if (rel === '' || rel === 'index.html') return reply.type('text/html').send(fs.readFileSync(path.join(OWN_VIEW_DIR, 'index.html')));
    if (rel === 'index.js') return reply.type('application/javascript').send(viewerBundle());
    if (rel === 'controls.js' || rel === 'view.css') {
      return reply.type(rel.endsWith('.js') ? 'application/javascript' : 'text/css').send(fs.readFileSync(path.join(OWN_VIEW_DIR, rel)));
    }
    const file = path.normalize(path.join(VIEWER_PUBLIC, rel));
    if (!file.startsWith(VIEWER_PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).send('Not found');
    const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    return reply.type(type).send(fs.createReadStream(file));
  });

  // ---------------------------------------------------------------- socket.io relay
  const io = new IoServer(app.server, {
    path: '/view-io/',
    serveClient: true,
    maxHttpBufferSize: 1e6,
    allowRequest: (req, cb) => {
      const okHost = isAllowedHost(String(req.headers.host ?? ''));
      const origin = req.headers.origin;
      cb(null, okHost && (!origin || isAllowedOrigin(origin)));
    },
  });

  const socketsByToken = new Map<string, Set<Socket>>();

  io.on('connection', (socket) => {
    const token = String(socket.handshake.query.vt ?? '');
    const role = String(socket.handshake.query.role ?? 'render');
    const rec = suite.sessions.sessionForViewToken(token);
    if (!rec) {
      socket.emit('closed', 'View closed');
      socket.disconnect(true);
      return;
    }
    const sessionId = rec.id;
    let set = socketsByToken.get(token);
    if (!set) socketsByToken.set(token, (set = new Set()));
    set.add(socket);
    socket.on('disconnect', () => set!.delete(socket));

    if (role === 'render') {
      const viewId = `v-${socket.id}`;
      const off = suite.runtime.onEvent((e) => {
        if (e.type === 'view' && e.viewId === viewId) socket.emit(e.event, ...(e.args as any[]));
      });
      suite.runtime.attachView(sessionId, viewId).catch((e) => socket.emit('closed', (e as Error).message));
      socket.onAny((event: string, ...args: unknown[]) => {
        if (event === 'mouseClick') suite.runtime.viewInput(viewId, event, args.slice(0, 1));
      });
      socket.on('disconnect', () => {
        off();
        suite.runtime.detachView(viewId);
      });
      return;
    }

    // role=control
    const offBus = suite.bus.on((ev) => {
      const d = ev.data as any;
      if (ev.type === 'session.chat' && d?.sessionId === sessionId) socket.emit('chat', { ts: d.ts, text: d.text });
      if (ev.type === 'session.stats' && d?.sessionId === sessionId) socket.emit('hud', d.stats);
    });
    socket.emit('hello', { sessionId, serverName: rec.serverName, username: rec.username, stats: rec.stats, chat: rec.chat.slice(-15) });
    socket.on('control', (input: unknown) => {
      if (!validControl(input)) return;
      suite.sessions.control(sessionId, input).catch(() => undefined);
    });
    socket.on('chat', (text: unknown, ack?: (r: unknown) => void) => {
      suite.sessions
        .sendChat(sessionId, String(text ?? ''))
        .then(() => ack?.({ ok: true }))
        .catch((e) => ack?.({ ok: false, error: (e as Error).message }));
    });
    socket.on('inventory', (ack?: (r: unknown) => void) => {
      suite.sessions
        .inventory(sessionId)
        .then((items) => ack?.({ ok: true, items }))
        .catch((e) => ack?.({ ok: false, error: (e as Error).message }));
    });
    socket.on('hide', (ack?: (r: unknown) => void) => {
      // Acknowledge first: hiding disconnects every socket of this view.
      ack?.({ ok: true });
      setImmediate(() => suite.sessions.hideInteractiveView(sessionId).catch(() => undefined));
    });
    socket.on('disconnect', () => {
      offBus();
      suite.sessions.control(sessionId, { kind: 'clearControls' }).catch(() => undefined);
    });
  });

  // Closing a view (hide, session end) disconnects its browsers.
  suite.bus.on((ev) => {
    if (ev.type !== 'view.closed') return;
    const sessionId = (ev.data as any)?.sessionId;
    for (const [token, set] of socketsByToken) {
      if (suite.sessions.sessionForViewToken(token)) continue;
      for (const s of set) {
        s.emit('closed', 'View closed');
        s.disconnect(true);
      }
      socketsByToken.delete(token);
    }
    log.debug(`View of ${sessionId} closed`);
  });

  app.addHook('onClose', async () => {
    io.close();
  });
}
