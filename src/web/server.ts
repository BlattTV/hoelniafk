import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Suite } from '../app.js';
import { SuiteError, ValidationError } from '../core/errors.js';
import { describeSchedule, generateRestSchedule, normalizeSchedule, spreadRestTimes } from '../core/schedule.js';
import { createLogger, onLogEntry, recentLogs, type Level } from '../core/logger.js';
import type { LinkState, MailAccountKind } from '../core/types.js';
import { DISCORD_APP_URL, isDiscordUrl, type DiscordTarget } from '../discord/discordService.js';
import { isMicrosoftUrl, type MicrosoftTarget } from '../identity/microsoftAccount.js';
import type { BulkAction } from '../ops/bulk.js';
import { refs } from '../vault/refs.js';
import { STAR_RANGES, type StarRange, starSeries, starStats } from '../minecraft/starStats.js';
import { parseScoreboard } from '../core/rules.js';

const log = createLogger('web');
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Remote images (tracking pixels in mails) are blocked on purpose.
  "img-src 'self' data: https://cdn.discordapp.com",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: any }>;

const bodyOf = (req: { body: unknown }): any => (req.body && typeof req.body === 'object' ? req.body : {});

const num = (v: unknown, name = 'id'): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(`Invalid ${name}`);
  return n;
};

function publicMailbox(suite: Suite, id: number) {
  const a = suite.repo.getMailAccount(id);
  return { ...a, hasCredentials: !!a.credentialRef, webmailUrl: suite.mail.webmailUrl(a) };
}

export interface ServerOptions {
  apiToken?: string;
}

/** Never sent to another device: things of this PC, secrets, windows (see remote control). */
const REMOTE_DENY = [
  /^\/api\/(backend|sync|vault|updates|settings|events|status\/restart)(\/|\?|$)/,
  /\/(window|open|password|recovery|export)(\/|\?|$)/,
  /^\/api\/(rules|demo)(\/|\?|$)/,
];
export function remoteAllowed(method: string, path: string): boolean {
  if (!path.startsWith('/api/') || path.includes('..')) return false;
  if (method === 'GET' && /^\/api\/backend\/agents(\?|$)/.test(path)) return true; // the agents list is fine to see
  if (method === 'POST' && /^\/api\/backend\/agents\/\d+\/(pause|update)$/.test(path)) return true; // the owner pauses / resumes / updates an agent
  if (REMOTE_DENY.some((r) => (r.source.includes('rules') ? method !== 'GET' && r.test(path) : r.test(path)))) return false;
  // opening the game window on another PC makes no sense remotely ("Back to AFK" does)
  if (method === 'POST' && /\/game(\?|$)/.test(path)) return false;
  return true;
}
const stripToken = (url: string) => url.replace(/([?&])token=[^&]*&?/, '$1').replace(/[?&]$/, '');

export async function buildServer(suite: Suite, opts: ServerOptions = {}): Promise<{ app: FastifyInstance; apiToken: string }> {
  const apiToken = opts.apiToken ?? crypto.randomBytes(32).toString('base64url');
  const port = suite.config.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  /** The identity's e-mail: its mailbox address (IMAP, optional) or its Microsoft account. */
  const identityEmail = (id: number): string | null => suite.repo.getMailIdentity(id)?.address ?? suite.microsoft.status(id).email;

  const tokenOk = (value: string | undefined) => {
    if (!value) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(apiToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  app.addHook('onRequest', async (req, reply) => {
    // DNS-rebinding protection: only loopback host names are accepted.
    if (!allowedHosts.has(String(req.headers.host ?? ''))) {
      reply.code(421).send({ error: 'Invalid host' });
      return reply;
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      reply.code(403).send({ error: 'Cross-origin request rejected' });
      return reply;
    }
    if (req.url.startsWith('/api/')) {
      const q = (req.query as Record<string, string>) ?? {};
      const provided = (req.headers['x-hoelni-token'] as string | undefined) ?? (req.method === 'GET' ? q.token : undefined);
      if (!tokenOk(provided)) {
        reply.code(401).send({ error: 'Missing or invalid API token' });
        return reply;
      }
    }
  });

  // ------------------------------------------------------------------ remote control (several PCs, Hoelni Control app)
  // A standby PC hands its controls to the active PC of the account: requests go there through the
  // backend, the sessions keep running where they are. Things of THIS PC stay local.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.headers['x-hoelni-remote'] || !suite.backend.remoteControl) return;
    const path = stripToken(req.url);
    if (!remoteAllowed(req.method, path)) return;
    const r = await suite.backend.rpc({ method: req.method, path, body: req.body ?? null, by: suite.backend.status().pcs.find((p) => p.self)?.name ?? 'standby PC' });
    // active PC unreachable: reading falls back to this PC's synchronized data
    if ((r.status === 503 || r.status === 504) && req.method === 'GET') return;
    reply.code(r.status).send(r.body ?? {});
    return reply;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof SuiteError) {
      reply.code(err.status).send({ error: err.message, type: err.name });
      return;
    }
    if (err?.validation || err?.statusCode === 400) {
      reply.code(400).send({ error: err.message });
      return;
    }
    log.error('Unhandled error:', err);
    reply.code(500).send({ error: 'Internal error – see log' });
  });

  // ------------------------------------------------------------------ UI
  const indexHtml = () =>
    fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replace('__HOELNI_TOKEN__', apiToken);
  app.get('/', async (_req, reply) => reply.type('text/html').send(indexHtml()));
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/static/', index: false });

  // Warnings/errors are pushed live to the UI.
  const offLog = onLogEntry((e) => {
    if (e.level === 'warn' || e.level === 'error') suite.bus.emit({ type: 'log', identityId: e.identityId ?? null, data: e });
  });
  app.addHook('onClose', async () => offLog());

  // ------------------------------------------------------------------ SSE
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Security-Policy': CSP,
    });
    reply.raw.write(': connected\n\n');
    const off = suite.bus.on((ev) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });

  // ------------------------------------------------------------------ status & settings
  app.get('/api/status', async () => {
    const rules = suite.getRules();
    return {
      name: 'Hoelni Client Suite',
      version: suite.updater.status().current.version,
      build: suite.updater.status().current.build,
      vaultBackend: suite.vault.backend,
      identities: suite.repo.listIdentities().length,
      rules: { mail: rules.mailRules.length, chat: rules.chatRules.length },
      discordAppUrl: DISCORD_APP_URL,
    };
  });

  // ------------------------------------------------------------------ backend (afk.hoelni.de): sign-in, agents, account administration
  app.get('/api/backend', async () => suite.backend.status());
  app.get('/api/backend/agents', async () => suite.backend.agentList());
  app.post('/api/backend/agents/:id/update', async (req: Req) => {
    suite.backend.updateAgent(num(req.params.id));
    return { ok: true };
  });
  app.post('/api/backend/agents/:id/pause', async (req: Req) => {
    suite.backend.pauseAgent(num(req.params.id), bodyOf(req).paused !== false);
    return { ok: true };
  });
  // Public IPs of this PC, the account's other PCs and its agents (sessions without proxy use them)
  const publicIps = () => {
    const st = suite.backend.status();
    const own = suite.publicIp.state;
    const pcs = st.pcs.map((p) => ({
      deviceId: p.deviceId,
      name: p.name,
      active: p.active,
      responding: p.self,
      publicIp: p.self ? own.ip ?? p.publicIp : p.publicIp,
      seenIp: p.ip,
      checkedAt: p.self ? own.checkedAt : null,
      error: p.self ? own.error : null,
    }));
    if (!pcs.some((p) => p.responding)) pcs.unshift({ deviceId: 0, name: os.hostname(), active: true, responding: true, publicIp: own.ip, seenIp: null, checkedAt: own.checkedAt, error: own.error });
    const agents = st.agents.map((a) => ({
      id: a.id,
      name: a.name,
      online: a.online,
      paused: a.paused,
      publicIp: a.info?.publicIp ?? null,
      seenIp: a.ip,
      checkedAt: a.info?.publicIpAt ?? null,
      sessions: a.sessions.length,
    }));
    return { pcs, agents };
  };
  app.get('/api/public-ips', async () => publicIps());
  app.post('/api/public-ips/refresh', async () => {
    await suite.publicIp.refresh();
    return publicIps();
  });
  app.post('/api/backend/certificate', async () => suite.backend.checkCertificate());
  app.post('/api/backend/login', async (req: Req) => {
    const b = bodyOf(req);
    const st = await suite.backend.login(String(b.username ?? ''), String(b.password ?? ''), b.trustCert ? String(b.trustCert) : null);
    // settings sync: the password unlocks the account's synchronized settings (or creates the key on the first PC)
    void suite.sync.setup(st.username ?? String(b.username ?? ''), String(b.password ?? ''), { verified: true }).catch((e) => log.warn(`Sync setup: ${(e as Error).message}`));
    return st;
  });
  // ------------------------------------------------------------------ several PCs: settings sync + active PC
  app.get('/api/sync', async () => ({ ...suite.sync.status(), standby: suite.sessions.standby, pcs: suite.backend.status().pcs, pcRole: suite.backend.status().pcRole }));
  app.post('/api/sync/setup', async (req: Req) => {
    const user = suite.backend.status().username;
    if (!user || suite.backend.status().state === 'signed-out') throw new ValidationError('Sign in to the backend first');
    await suite.sync.setup(user, String(bodyOf(req).password ?? ''));
    return suite.sync.status();
  });
  app.post('/api/sync/now', async () => {
    suite.sync.schedule(true);
    await suite.sync.syncNow();
    return suite.sync.status();
  });
  app.post('/api/backend/claim', async () => {
    suite.backend.claim();
    return suite.backend.status();
  });
  app.post('/api/backend/logout', async () => {
    await suite.backend.logout();
    return suite.backend.status();
  });
  app.post('/api/backend/change', async (req: Req) => {
    const b = bodyOf(req);
    return suite.backend.changeBackend(String(b.url ?? ''), String(b.adminUser ?? ''), String(b.adminPassword ?? ''), b.proxy !== undefined ? { proxy: String(b.proxy) } : {});
  });
  app.post('/api/backend/reconnect', async () => {
    suite.backend.reconnect();
    return suite.backend.status();
  });
  app.put('/api/backend/proxy', async (req: Req) => {
    await suite.backend.setProxy(String(bodyOf(req).proxy ?? '').trim());
    return suite.backend.status();
  });
  app.get('/api/backend/admin/overview', async () => suite.backend.admin('GET', 'overview'));
  app.post('/api/backend/admin/users', async (req: Req) => suite.backend.admin('POST', 'users', bodyOf(req)));
  app.patch('/api/backend/admin/users/:id', async (req: Req) => suite.backend.admin('PATCH', `users/${num(req.params.id)}`, bodyOf(req)));
  app.delete('/api/backend/admin/users/:id', async (req: Req) => suite.backend.admin('DELETE', `users/${num(req.params.id)}`));
  app.delete('/api/backend/admin/devices/:id', async (req: Req) => suite.backend.admin('DELETE', `devices/${num(req.params.id)}`));

  // ------------------------------------------------------------------ macro builder
  app.get('/api/macros', async () => ({ macros: suite.macros.list(), log: suite.macros.recent(100) }));
  app.post('/api/macros', async (req: Req) => suite.macros.save(bodyOf(req)));
  app.put('/api/macros/:id', async (req: Req) => suite.macros.save(bodyOf(req), num(req.params.id)));
  app.delete('/api/macros/:id', async (req: Req) => {
    suite.macros.remove(num(req.params.id));
    return { ok: true };
  });
  app.post('/api/macros/:id/run', async (req: Req) => {
    const sid = String(bodyOf(req).sessionId ?? '');
    if (sid === 'all') return { ok: true, sessions: suite.macros.runAll(num(req.params.id)) };
    suite.macros.run(num(req.params.id), sid);
    return { ok: true, sessions: [sid] };
  });
  app.post('/api/macros/:id/stop', async (req: Req) => {
    const sid = String(bodyOf(req).sessionId ?? '');
    if (sid === 'all') suite.macros.stopAll(num(req.params.id));
    else suite.macros.stop(num(req.params.id), sid);
    return { ok: true };
  });

  // ------------------------------------------------------------------ proxy pool
  app.get('/api/proxies', async () => suite.proxies.list());
  app.post('/api/proxies/import', async (req: Req) => {
    const b = bodyOf(req);
    const kind = b.kind === 'HTTP' ? 'HTTP' : 'SOCKS5';
    return suite.proxies.import(String(b.text ?? ''), { kind, label: b.label ? String(b.label) : undefined });
  });
  app.post('/api/proxies/test', async (req: Req) => {
    const ids = bodyOf(req).ids;
    return suite.proxies.testAll(Array.isArray(ids) ? ids.map(Number) : undefined);
  });
  app.post('/api/proxies/:id/test', async (req: Req) => suite.proxies.test(num(req.params.id)));
  app.post('/api/proxies/auto-assign', async (req: Req) => {
    const ids = bodyOf(req).identityIds;
    return suite.proxies.autoAssign(Array.isArray(ids) ? ids.map(Number) : undefined);
  });
  app.post('/api/proxies/:id/assign', async (req: Req) => suite.proxies.assign(num(bodyOf(req).identityId), num(req.params.id)));
  app.post('/api/proxies/:id/release', async (req: Req) => {
    await suite.proxies.release(num(req.params.id));
    return { ok: true };
  });
  app.delete('/api/proxies/:id', async (req: Req) => {
    await suite.proxies.remove(num(req.params.id));
    return { ok: true };
  });

  // ------------------------------------------------------------------ updates (self-hosted update server)
  app.get('/api/updates', async () => suite.updater.status());
  app.get('/api/updates/installer', async (_req: Req, reply: FastifyReply) => {
    const { file, content } = await suite.updater.downloadInstaller();
    reply.header('Content-Disposition', `attachment; filename="${file.replace(/[^\w.\- ]+/g, '_')}"`);
    reply.type('application/octet-stream');
    return reply.send(content);
  });
  app.post('/api/updates/probe', async (req: Req) => suite.updater.probe(String(bodyOf(req).url ?? '')));
  app.put('/api/updates/settings', async (req: Req) => {
    const b = bodyOf(req);
    suite.updater.configure({
      url: b.url !== undefined ? String(b.url) : undefined,
      channel: b.channel !== undefined ? String(b.channel) : undefined,
      publicKey: b.publicKey !== undefined ? (b.publicKey ? String(b.publicKey) : null) : undefined,
      autoCheck: b.autoCheck !== undefined ? !!b.autoCheck : undefined,
      autoInstall: b.autoInstall !== undefined ? !!b.autoInstall : undefined,
    });
    return suite.updater.status();
  });
  app.post('/api/updates/check', async () => suite.updater.check());
  app.post('/api/updates/download', async () => suite.updater.download());
  app.post('/api/updates/install', async () => suite.updater.install());
  app.post('/api/updates/rollback', async () => suite.updater.rollback());

  app.get('/api/settings', async () => ({ automation: suite.config.automation, startSpacing: suite.sessions.startSpacing(), rejoinSpacing: suite.sessions.rejoinSpacing(), bootSpacing: suite.sessions.bootSpacing(), onlineSpacing: suite.sessions.onlineSpacing(), offlineSpacing: suite.sessions.offlineSpacing() }));
  app.put('/api/settings/offline-spacing', async (req: Req) => {
    const b = bodyOf(req);
    return suite.sessions.setOfflineSpacing(Number(b.min), Number(b.max));
  });
  app.put('/api/settings/online-spacing', async (req: Req) => {
    const b = bodyOf(req);
    return suite.sessions.setOnlineSpacing(Number(b.min), Number(b.max));
  });
  app.put('/api/settings/boot-spacing', async (req: Req) => {
    const b = bodyOf(req);
    return suite.sessions.setBootSpacing(Number(b.min), Number(b.max));
  });
  app.put('/api/settings/rejoin-spacing', async (req: Req) => {
    const b = bodyOf(req);
    return suite.sessions.setRejoinSpacing(Number(b.min), Number(b.max));
  });
  app.put('/api/settings/start-spacing', async (req: Req) => {
    const b = bodyOf(req);
    return suite.sessions.setStartSpacing(Number(b.min), Number(b.max));
  });

  // UI language (the desktop tray menu follows it too)
  app.get('/api/settings/ui', async () => ({ language: suite.repo.getSetting('ui.language') === 'de' ? 'de' : 'en' }));
  app.put('/api/settings/ui', async (req: Req) => {
    const language = String(bodyOf(req).language ?? '');
    if (language !== 'en' && language !== 'de') throw new ValidationError('language must be en or de');
    suite.repo.setSetting('ui.language', language);
    return { language };
  });

  app.get('/api/rules', async () => suite.getRules());
  app.post('/api/rules/reload', async () => {
    const r = suite.reloadRules();
    return { mail: r.mailRules.length, chat: r.chatRules.length };
  });

  app.get('/api/vault', async () => ({ backend: suite.vault.backend, refs: await suite.vault.store.list() }));
  app.post('/api/vault/recovery-kit', async (req: Req, reply: FastifyReply) => {
    const store = suite.vault.store as any;
    if (typeof store.exportRecoveryKit !== 'function') throw new ValidationError('This vault backend does not support recovery kits');
    const kit = store.exportRecoveryKit(String(bodyOf(req).passphrase ?? ''));
    suite.repo.setSetting('vault.recoveryKitExportedAt', new Date().toISOString());
    suite.audit.record(null, 'Vault recovery kit exported');
    reply.header('Content-Disposition', 'attachment; filename="hoelni-vault-recovery.json"');
    return kit;
  });

  app.get('/api/network/interfaces', async () =>
    Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
      (addrs ?? []).filter((a) => !a.internal).map((a) => ({ name, address: a.address, family: a.family })),
    ),
  );

  // ------------------------------------------------------------------ identities
  app.get('/api/dashboard', async () => ({ rows: suite.identities.dashboard() }));
  /** Short overview for the "Hoelni Control" app and its home-screen widgets. */
  app.get('/api/summary', async () => {
    const sessions = suite.sessions.list();
    const rows = suite.identities.dashboard();
    const name = (identityId: number) => {
      const r = rows.find((x) => x.id === identityId);
      return r?.minecraft.username || r?.label || `#${identityId}`;
    };
    const st = suite.backend.status();
    return {
      pc: st.pcs.find((p) => p.self)?.name ?? null,
      sessions: {
        online: sessions.filter((x) => x.state === 'ONLINE').length,
        wanted: sessions.filter((x) => x.desiredState === 'ONLINE').length,
        problems: sessions.filter((x) => x.state === 'BLOCKED' || x.state === 'RECONNECTING').length,
        list: sessions
          .filter((x) => x.desiredState === 'ONLINE' || x.state !== 'STOPPED')
          .slice(0, 12)
          .map((x) => ({ id: x.id, name: name(x.identityId), server: x.serverName, state: x.state })),
      },
      identities: { total: rows.length, ready: rows.filter((r) => r.ready).length },
      agents: { online: st.agents.filter((a) => a.online).length, total: st.agents.length },
      stars: rows.reduce((a, r) => a + (Number(r.stars) || 0), 0),
      starsGained24h: suite.repo.starHistory(new Date(Date.now() - 86_400_000).toISOString()).reduce((a, x) => a + Math.max(0, x.delta), 0),
      // star alerts of the last 24 h (the Control app turns new ones into phone notifications)
      starAlerts: suite.starAlerts.list().filter((a) => Date.now() - Date.parse(a.ts) < 86_400_000).slice(0, 10),
      at: new Date().toISOString(),
    };
  });

  // Star statistics: balance of all / the online identities, gained per 24 h / 7 / 30 / 365 days, charts
  app.get('/api/stars', async () => {
    const online = new Set(suite.sessions.list().filter((x) => x.state === 'ONLINE').map((x) => x.identityId));
    const rows = suite.identities.dashboard();
    const counted = suite.repo.starServerIds();
    const names = new Map(suite.repo.listServers().map((s) => [s.id, s.name]));
    return {
      ...starStats(
        suite.repo,
        rows.map((r) => ({
          id: r.id,
          name: r.minecraft.username || r.label || `#${r.id}`,
          stars: Number(r.stars) || 0,
          online: online.has(r.id),
          servers: suite.repo
            .listServerRewards(r.id)
            .filter((x) => counted.has(x.serverId))
            .map((x) => ({ serverId: x.serverId, name: names.get(x.serverId) ?? `#${x.serverId}`, stars: x.stars, source: suite.repo.hasScoreboardHistory(r.id, x.serverId) ? ('scoreboard' as const) : x.stars ? ('chat' as const) : null })),
        })),
      ),
      servers: suite.repo.listServers().map((s) => ({ id: s.id, name: s.name, trackStars: s.trackStars })),
    };
  });
  // "portfolio" for the Control app: balance over a range (like a share price) for all and per identity
  const starRange = (v: unknown): StarRange => (STAR_RANGES.includes(v as StarRange) ? (v as StarRange) : '1d');
  const starRows = () => {
    const online = new Map<number, string[]>();
    for (const x of suite.sessions.list()) if (x.state === 'ONLINE') online.set(x.identityId, [...(online.get(x.identityId) ?? []), x.serverName]);
    return suite.identities.dashboard().map((r) => ({ id: r.id, number: r.number, name: r.minecraft.username || r.label || `#${r.id}`, label: r.label, stars: Number(r.stars) || 0, online: online.get(r.id) ?? [] }));
  };
  app.get('/api/stars/portfolio', async (req: Req) => {
    const range = starRange(req.query.range);
    const history = suite.repo.starHistory(new Date(0).toISOString());
    const rows = starRows();
    const total = rows.reduce((a, r) => a + r.stars, 0);
    const now = Date.now();
    return {
      range,
      total,
      ...starSeries(history, total, range, now),
      identities: rows
        .map((r) => {
          const s = starSeries(history, r.stars, range, now, r.id);
          return { ...r, change: s.change, changePct: s.changePct };
        })
        .sort((a, b) => b.stars - a.stars),
      at: new Date(now).toISOString(),
    };
  });
  app.get('/api/stars/identity/:id', async (req: Req) => {
    const id = num(req.params.id, 'id');
    const range = starRange(req.query.range);
    const row = starRows().find((r) => r.id === id);
    if (!row) throw new ValidationError('Unknown identity');
    const history = suite.repo.starHistory(new Date(0).toISOString());
    const since = (ms: number) => history.filter((x) => x.identityId === id && x.delta > 0 && Date.now() - Date.parse(x.ts) <= ms).reduce((a, x) => a + x.delta, 0);
    return { ...row, range, ...starSeries(history, row.stars, range, Date.now(), id), gained: { h24: since(86_400_000), d7: since(7 * 86_400_000), d30: since(30 * 86_400_000) } };
  });
  // abnormal star earning: alerts + their settings (also from the Control app)
  app.get('/api/stars/alerts', async () => ({ alerts: suite.starAlerts.list(), settings: suite.starAlerts.settings() }));
  app.put('/api/stars/alerts/settings', async (req: Req) => suite.starAlerts.setSettings(bodyOf(req) as any));
  app.post('/api/stars/alerts/test', async () => suite.starAlerts.test());
  app.post('/api/stars/alerts/check', async () => ({ raised: suite.starAlerts.check() }));
  app.delete('/api/stars/alerts', async () => {
    suite.starAlerts.clear();
    return { ok: true };
  });
  // the sidebar scoreboard of a session as the player sees it (to set up the star recognition)
  app.get('/api/sessions/:sessionId/scoreboard', async (req: Req) => {
    const sb = suite.sessions.getScoreboard(req.params.sessionId) ?? { title: '', lines: [], at: null };
    // why the stars are (not) taken over – shown under the scoreboard
    const [identityId, serverId] = String(req.params.sessionId).split(':').map(Number);
    let recognition: { stars: number | null; line: string | null; stored: number | null; problem: string | null } = { stars: null, line: null, stored: null, problem: null };
    try {
      const server = suite.repo.getServer(serverId);
      const parsers = suite.repo.getIdentity(identityId).settings.parsers;
      const rewardSets = suite.getRules().chatRules.filter((r) => r.type === 'rewards').map((r) => r.id);
      const hit = sb.lines.length ? parseScoreboard(suite.getRules(), parsers, sb.lines) : null;
      recognition = {
        stars: hit?.stars ?? null,
        line: hit?.line ?? null,
        stored: suite.repo.getServerReward(identityId, serverId).stars,
        problem: !server.trackStars
          ? 'Stars are not counted on this server (Servers → Count stars).'
          : !parsers.some((p) => rewardSets.includes(p))
            ? `The identity has no star rules active (active: ${parsers.join(', ') || 'none'}; star rules: ${rewardSets.join(', ') || 'none in rules.yaml'}).`
            : sb.lines.length && !hit
              ? 'No line with stars recognised (rules.yaml → scoreboard).'
              : null,
      };
    } catch {
      /* session of a removed identity / server */
    }
    return { ...sb, recognition };
  });

  app.get('/api/identities/:id', async (req: Req) => {
    const id = num(req.params.id);
    const identity = suite.repo.getIdentity(id);
    const mail = suite.repo.getMailIdentity(id);
    return {
      identity,
      minecraft: suite.repo.getMinecraft(id),
      deviceCode: suite.auth.pendingDeviceCode(id),
      microsoft: suite.microsoft.status(id),
      mail,
      mailbox: mail ? publicMailbox(suite, mail.mailAccountId) : null,
      discord: suite.repo.getDiscord(id),
      pendingLink: suite.linking.pendingFor(id),
      networkProfiles: suite.repo.listNetworkProfiles(id),
      networkConflicts: suite.network.conflicts(id),
      assignments: suite.repo.listAssignments(id),
      rewards: suite.repo.getRewards(id),
      serverRewards: suite.repo.listAssignments(id).map((a) => ({ ...suite.repo.getServerReward(id, a.serverId), serverName: suite.repo.getServer(a.serverId).name })),
      rewardHistory: suite.repo.rewardHistory(id, 30),
      sessions: suite.sessions.list(id),
      health: suite.identities.health(id),
      vaultRefs: await suite.vault.forIdentity(id).list(),
    };
  });

  app.post('/api/identities', async (req: Req) => suite.identities.create(bodyOf(req)));
  app.patch('/api/identities/:id', async (req: Req) => {
    const id = num(req.params.id);
    const { label, settings, networkProfileId } = bodyOf(req);
    const gc = settings?.gameClient;
    if (gc) {
      if (gc.mode !== undefined && !['takeover', 'handover', 'background'].includes(gc.mode)) throw new ValidationError('gameClient.mode must be takeover, handover or background');
      if (gc.loader !== undefined && !['vanilla', 'fabric'].includes(gc.loader)) throw new ValidationError('gameClient.loader must be vanilla or fabric');
      if (gc.version !== undefined && !/^(auto|latest-release|latest-snapshot|[0-9A-Za-z._-]{1,40})$/.test(String(gc.version))) throw new ValidationError('gameClient.version is invalid');
      if (gc.memoryMb !== undefined && (!Number.isInteger(gc.memoryMb) || gc.memoryMb < 1024 || gc.memoryMb > 32768)) throw new ValidationError('gameClient.memoryMb must be 1024–32768');
    }
    if (settings && settings.agentId !== undefined && settings.agentId !== null && !(Number.isInteger(settings.agentId) && settings.agentId > 0)) throw new ValidationError('agentId must be an agent id or null (this PC)');
    const placedBefore = suite.repo.getIdentity(id).settings.agentId ?? null;
    const updated = suite.repo.updateIdentity(id, { label, settings, networkProfileId });
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    // "Run on" changed: move running sessions to the new place right away
    if ((updated.settings.agentId ?? null) !== placedBefore) void suite.sessions.placementChanged(id).catch(() => undefined);
    return updated;
  });
  app.delete('/api/identities/:id', async (req: Req) => {
    await suite.identities.delete(num(req.params.id));
    return { ok: true };
  });
  app.post('/api/identities/:id/clone', async (req: Req) => suite.identities.clone(num(req.params.id), bodyOf(req).label));
  app.post('/api/identities/:id/save-template', async (req: Req) => suite.identities.saveAsTemplate(num(req.params.id), String(bodyOf(req).name ?? '')));
  app.get('/api/identities/:id/health', async (req: Req) => suite.identities.health(num(req.params.id)));

  // ------------------------------------------------------------------ minecraft
  app.put('/api/identities/:id/minecraft', async (req: Req) => {
    const id = num(req.params.id);
    const { username, authType, msaAccount } = bodyOf(req);
    const cur = suite.repo.getMinecraft(id);
    const accountChanged = cur && ((msaAccount ?? cur.msaAccount) !== cur.msaAccount || (authType ?? cur.authType) !== cur.authType);
    if (accountChanged) await suite.auth.logout(id);
    const mc = suite.repo.upsertMinecraft(id, {
      username,
      authType,
      msaAccount: msaAccount === undefined ? undefined : String(msaAccount).trim().toLowerCase() || null,
      ...(accountChanged ? { uuid: null, authStatus: 'NONE' as const } : {}),
    });
    suite.audit.record(id, 'Minecraft account configured', { username: mc.username, authType: mc.authType });
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    return mc;
  });
  app.post('/api/identities/:id/minecraft/auth', async (req: Req) => {
    const id = num(req.params.id);
    // Runs in the background – the device code (first login) is delivered via SSE.
    suite.auth.authenticate(id).catch((e) => log.warn(`auth ${id}: ${(e as Error).message}`));
    await new Promise((r) => setTimeout(r, 300));
    return { started: true, deviceCode: suite.auth.pendingDeviceCode(id) };
  });
  app.post('/api/identities/:id/minecraft/logout', async (req: Req) => {
    await suite.auth.logout(num(req.params.id));
    return { ok: true };
  });

  // ------------------------------------------------------------------ mailboxes
  app.get('/api/mailboxes', async () =>
    suite.repo.listMailAccounts().map((a) => ({
      ...publicMailbox(suite, a.id),
      identities: suite.repo.listMailIdentitiesForAccount(a.id).map((m) => ({ identityId: m.identityId, address: m.address })),
    })),
  );
  app.post('/api/mailboxes', async (req: Req) => {
    const b = bodyOf(req);
    const kind = (b.kind ?? 'imap') as MailAccountKind;
    const presets: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
      microsoft: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587 },
      google: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
    };
    const p = presets[kind];
    const account = suite.repo.createMailAccount({
      label: b.label,
      kind,
      imapHost: b.imapHost || p?.imapHost,
      imapPort: Number(b.imapPort || p?.imapPort || 993),
      imapSecure: b.imapSecure !== false,
      username: String(b.username ?? '').trim(),
      smtpHost: b.smtpHost || p?.smtpHost || null,
      smtpPort: b.smtpPort ? Number(b.smtpPort) : p?.smtpPort ?? null,
      webmailUrl: b.webmailUrl || null,
      exclusiveIdentityId: b.exclusiveIdentityId ? num(b.exclusiveIdentityId) : null,
      aliasProviderId: b.aliasProviderId ? num(b.aliasProviderId) : null,
    });
    if (b.password) await suite.mail.setMailboxPassword(account.id, String(b.password));
    suite.audit.record(null, 'Mailbox added', { mailbox: account.id, kind });
    return publicMailbox(suite, account.id);
  });
  app.patch('/api/mailboxes/:id', async (req: Req) => {
    const id = num(req.params.id);
    const { credentialRef: _ignored, id: _id, ...patch } = bodyOf(req);
    suite.repo.updateMailAccount(id, patch);
    return publicMailbox(suite, id);
  });
  app.delete('/api/mailboxes/:id', async (req: Req) => {
    const id = num(req.params.id);
    await suite.vault.store.delete(refs.mailbox(id));
    suite.repo.deleteMailAccount(id);
    suite.audit.record(null, 'Mailbox removed', { mailbox: id });
    return { ok: true };
  });
  app.post('/api/mailboxes/:id/password', async (req: Req) => {
    await suite.mail.setMailboxPassword(num(req.params.id), String(bodyOf(req).password ?? ''));
    return { ok: true };
  });
  app.post('/api/mailboxes/:id/test', async (req: Req) => suite.mail.providerFor(num(req.params.id)).test());
  app.post('/api/mailboxes/:id/sync', async (req: Req) => suite.mail.syncMailbox(num(req.params.id)));
  app.get('/api/mailboxes/:id/unassigned', async (req: Req) => suite.mail.unassigned(num(req.params.id), { q: req.query.q }));
  app.get('/api/mailboxes/:id/messages/:mid', async (req: Req) => suite.mail.getMailboxMessage(num(req.params.id), num(req.params.mid)));
  app.get('/api/mailboxes/:id/aliases', async (req: Req) => suite.mail.listAliases(num(req.params.id)));
  app.post('/api/mailboxes/:id/aliases', async (req: Req) =>
    suite.mail.createAlias(num(req.params.id), String(bodyOf(req).localPart ?? ''), bodyOf(req).identityId ? num(bodyOf(req).identityId) : undefined),
  );
  app.delete('/api/mailboxes/:id/aliases/:address', async (req: Req) => {
    await suite.mail.deleteAlias(num(req.params.id), req.params.address);
    return { ok: true };
  });

  app.get('/api/alias-providers', async () => suite.mail.listAliasProviders().map(({ credentialRef, ...p }) => ({ ...p, hasToken: !!credentialRef })));
  app.post('/api/alias-providers', async (req: Req) => {
    const { credentialRef, ...p } = await suite.mail.createAliasProvider(bodyOf(req));
    return { ...p, hasToken: !!credentialRef };
  });
  app.delete('/api/alias-providers/:id', async (req: Req) => {
    await suite.mail.deleteAliasProvider(num(req.params.id));
    return { ok: true };
  });

  // ------------------------------------------------------------------ identity mail
  app.put('/api/identities/:id/mail', async (req: Req) => {
    const id = num(req.params.id);
    const m = suite.repo.assignMail(id, { mailAccountId: num(bodyOf(req).mailAccountId, 'mailbox'), address: String(bodyOf(req).address ?? ''), isAlias: !!bodyOf(req).isAlias });
    suite.audit.record(id, 'Mailbox assigned', { address: m.address });
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    return m;
  });
  app.delete('/api/identities/:id/mail', async (req: Req) => {
    const id = num(req.params.id);
    suite.repo.unassignMail(id);
    suite.audit.record(id, 'Mailbox unassigned');
    return { ok: true };
  });
  app.post('/api/identities/:id/mail/check', async (req: Req) => suite.mail.checkIdentity(num(req.params.id)));
  app.get('/api/identities/:id/mail/messages', async (req: Req) => {
    const q = req.query;
    return suite.mail.listForIdentity(num(req.params.id), {
      q: q.q,
      sender: q.sender,
      subject: q.subject,
      unread: q.unread === '1' || q.unread === 'true',
      category: (q.category as any) || undefined,
      provider: q.provider || undefined,
    });
  });
  app.get('/api/identities/:id/mail/messages/:mid', async (req: Req) =>
    suite.mail.getMessage(num(req.params.id), num(req.params.mid), { markSeen: req.query.markSeen !== '0' }),
  );
  app.post('/api/identities/:id/mail/messages/:mid/seen', async (req: Req) => {
    await suite.mail.setSeen(num(req.params.id), num(req.params.mid), bodyOf(req).seen !== false);
    return { ok: true };
  });
  app.get('/api/identities/:id/mail/messages/:mid/attachments/:idx', async (req: Req, reply: FastifyReply) => {
    const a = await suite.mail.getAttachment(num(req.params.id), num(req.params.mid), num(req.params.idx, 'index'));
    const safeName = a.filename.replace(/[^\w.\- ]+/g, '_');
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    reply.type('application/octet-stream');
    return reply.send(a.content);
  });
  app.post('/api/identities/:id/mail/send', async (req: Req) => {
    await suite.mail.sendMail(num(req.params.id), { to: String(bodyOf(req).to ?? ''), subject: String(bodyOf(req).subject ?? ''), text: String(bodyOf(req).text ?? '') });
    return { ok: true };
  });
  app.get('/api/inbox', async (req: Req) => {
    const q = req.query;
    return suite.mail.globalInbox({
      identityId: q.identityId ? num(q.identityId) : undefined,
      provider: q.provider || undefined,
      unread: q.unread === '1' || q.unread === 'true',
      category: (q.category as any) || undefined,
      q: q.q || undefined,
    });
  });
  app.post('/api/messages/:mid/assign', async (req: Req) =>
    suite.mail.assignMessage(num(req.params.mid), bodyOf(req).identityId === null ? null : num(bodyOf(req).identityId)),
  );

  // ------------------------------------------------------------------ discord
  app.post('/api/identities/:id/discord/signup', async (req: Req) => suite.discord.beginSignup(num(req.params.id)));
  /**
   * Opens a page in the identity's own Discord profile. The desktop program opens this URL in a
   * separate, persistent browser profile per identity (own Discord login = switch accounts by
   * switching windows); a normal browser just follows the redirect.
   */
  app.get('/api/identities/:id/discord/open', async (req: Req, reply: FastifyReply) => {
    const to = String(req.query.to ?? 'app') as DiscordTarget;
    if (!['register', 'login', 'app'].includes(to)) throw new ValidationError('Unknown Discord page');
    const url = suite.discord.target(num(req.params.id), to);
    if (!isDiscordUrl(url)) throw new ValidationError('Refusing to open a non-Discord page');
    return reply.header('Referrer-Policy', 'no-referrer').redirect(url, 302);
  });
  app.get('/api/identities/:id/discord/signup-kit', async (req: Req) => {
    const id = num(req.params.id);
    return suite.discord.signupKit(id, identityEmail(id), suite.repo.getMinecraft(id)?.username ?? null);
  });
  /** Copy-to-clipboard only (the UI never displays it); every copy is audited without the value. */
  app.post('/api/identities/:id/discord/password', async (req: Req) => {
    const id = num(req.params.id);
    const password = await suite.discord.password(id);
    suite.audit.record(id, 'Discord password copied');
    return { password };
  });
  app.get('/api/discord', async () =>
    suite.repo.listIdentities().map((i) => ({
      identityId: i.id,
      label: i.label,
      minecraft: suite.repo.getMinecraft(i.id)?.username ?? null,
      email: identityEmail(i.id),
      microsoft: suite.microsoft.status(i.id),
      minecraftStatus: suite.repo.getMinecraft(i.id)?.authStatus ?? 'NONE',
      discord: suite.repo.getDiscord(i.id),
    })),
  );
  app.post('/api/identities/:id/discord/ready', async (req: Req) => suite.discord.markReady(num(req.params.id), bodyOf(req).username ? String(bodyOf(req).username) : null));

  // ------------------------------------------------------------------ account library (Microsoft / Discord)
  app.get('/api/accounts', async () => suite.accounts.list());
  app.post('/api/accounts', async (req: Req) => {
    const b = bodyOf(req);
    return suite.accounts.create({ kind: b.kind, label: b.label, email: b.email, username: b.username });
  });
  app.patch('/api/accounts/:id', async (req: Req) => {
    const b = bodyOf(req);
    return suite.accounts.update(num(req.params.id), { label: b.label, username: b.username, ready: b.ready });
  });
  app.delete('/api/accounts/:id', async (req: Req) => {
    await suite.accounts.remove(num(req.params.id));
    return { ok: true };
  });
  app.post('/api/accounts/:id/link', async (req: Req) => {
    const target = bodyOf(req).identityId;
    return suite.accounts.link(num(req.params.id), target === null || target === undefined || target === '' ? null : num(target));
  });
  /** Window data for the desktop program (browser profile of the account). */
  app.post('/api/accounts/login-pending', async () => ({ count: suite.accounts.markAllLoginPending() }));
  app.post('/api/accounts/:id/login-done', async (req: Req) => {
    suite.accounts.loginDone(num(req.params.id));
    return { ok: true };
  });
  app.get('/api/accounts/:id/window', async (req: Req) => suite.accounts.window(num(req.params.id)));
  /** Desktop program: the window of an identity's account (created for Discord / an existing Microsoft e-mail). */
  app.post('/api/identities/:id/accounts/:kind/window', async (req: Req) => {
    const kind = String(req.params.kind);
    if (kind !== 'microsoft' && kind !== 'discord') throw new ValidationError('kind must be microsoft or discord');
    return suite.accounts.window(suite.accounts.ensureFor(num(req.params.id), kind).id);
  });
  /** Opens a page in the account's window (a normal browser just follows the redirect). */
  app.get('/api/accounts/:id/open', async (req: Req, reply: FastifyReply) => {
    const url = suite.accounts.target(num(req.params.id), String(req.query.to ?? 'app'));
    if (!isMicrosoftUrl(url) && !isDiscordUrl(url)) throw new ValidationError('Refusing to open this page');
    return reply.header('Referrer-Policy', 'no-referrer').redirect(url, 302);
  });

  // ------------------------------------------------------------------ Microsoft: Minecraft sign-in + Outlook, no app registration
  app.get('/api/identities/:id/microsoft', async (req: Req) => suite.microsoft.status(num(req.params.id)));
  app.post('/api/identities/:id/microsoft/connect', async (req: Req) => suite.microsoft.connect(num(req.params.id), String(bodyOf(req).email ?? '')));
  /**
   * Opens a page in the identity's own Microsoft window (desktop program: persistent browser profile
   * per identity – the Minecraft confirmation page with the code filled in, or Outlook). A normal
   * browser just follows the redirect.
   */
  app.get('/api/identities/:id/microsoft/open', async (req: Req, reply: FastifyReply) => {
    const to = String(req.query.to ?? 'outlook') as MicrosoftTarget;
    if (!['link', 'outlook'].includes(to)) throw new ValidationError('Unknown Microsoft page');
    const url = suite.microsoft.target(num(req.params.id), to);
    if (!isMicrosoftUrl(url)) throw new ValidationError('Refusing to open a non-Microsoft page');
    return reply.header('Referrer-Policy', 'no-referrer').redirect(url, 302);
  });
  app.delete('/api/identities/:id/microsoft', async (req: Req) => {
    await suite.microsoft.unlink(num(req.params.id));
    return { ok: true };
  });
  app.post('/api/identities/:id/discord/disconnect', async (req: Req) => {
    await suite.discord.disconnect(num(req.params.id));
    return { ok: true };
  });
  app.post('/api/identities/:id/discord/link-state', async (req: Req) => {
    const state = String(bodyOf(req).state ?? '') as LinkState;
    if (!['UNKNOWN', 'WAITING', 'LINKED', 'ERROR'].includes(state)) throw new ValidationError('Invalid link state');
    suite.linking.setManual(num(req.params.id), state);
    return { ok: true };
  });

  // ------------------------------------------------------------------ network
  app.post('/api/identities/:id/network', async (req: Req) => {
    const id = num(req.params.id);
    const { password, makeDefault, ...b } = bodyOf(req);
    const profile = suite.repo.createNetworkProfile(id, {
      name: b.name || 'default',
      kind: b.kind,
      localBindIp: b.localBindIp || null,
      proxyHost: b.proxyHost || null,
      proxyPort: b.proxyPort ? Number(b.proxyPort) : null,
      proxyUsername: b.proxyUsername || null,
      expectedPublicIp: b.expectedPublicIp || null,
      exitLabel: b.exitLabel || null,
    });
    if (password) await suite.network.setProxyPassword(id, profile.id, String(password));
    if (makeDefault) suite.repo.updateIdentity(id, { networkProfileId: profile.id });
    suite.audit.record(id, 'Network profile created', { profile: profile.name, kind: profile.kind });
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    return suite.repo.getNetworkProfile(profile.id);
  });
  app.patch('/api/identities/:id/network/:pid', async (req: Req) => {
    const id = num(req.params.id);
    const pid = num(req.params.pid);
    const before = suite.repo.getNetworkProfileFor(id, pid);
    const { password, credentialRef: _c, identityId: _i, id: _p, actualPublicIp: _a, checkStatus: _s, ...patch } = bodyOf(req);
    for (const k of ['localBindIp', 'proxyHost', 'proxyUsername', 'expectedPublicIp', 'exitLabel']) if (patch[k] === '') patch[k] = null;
    if (patch.proxyPort !== undefined) patch.proxyPort = patch.proxyPort ? Number(patch.proxyPort) : null;
    const p = suite.repo.updateNetworkProfile(id, pid, patch);
    if (password) await suite.network.setProxyPassword(id, pid, String(password));
    if (before.expectedPublicIp !== p.expectedPublicIp || before.localBindIp !== p.localBindIp || before.proxyHost !== p.proxyHost) {
      suite.audit.record(id, 'Network profile changed', { profile: p.name, expected: p.expectedPublicIp ?? '-', bind: p.localBindIp ?? '-' });
    }
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    return p;
  });
  app.delete('/api/identities/:id/network/:pid', async (req: Req) => {
    await suite.network.deleteProfile(num(req.params.id), num(req.params.pid));
    return { ok: true };
  });
  app.get('/api/identities/:id/network/diagnose', async (req: Req) =>
    suite.network.diagnose(num(req.params.id), req.query.profileId ? num(req.query.profileId) : undefined),
  );
  app.post('/api/identities/:id/network/verify', async (req: Req) => {
    const id = num(req.params.id);
    const r = await suite.network.verify(id, bodyOf(req).profileId ? num(bodyOf(req).profileId) : undefined);
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    return r;
  });

  // ------------------------------------------------------------------ servers & sessions
  app.get('/api/servers', async () => suite.repo.listServers());
  app.post('/api/servers', async (req: Req) => {
    const s = suite.repo.upsertServer(bodyOf(req));
    suite.audit.record(null, 'Server saved', { server: s.name });
    return s;
  });
  app.patch('/api/servers/:id', async (req: Req) => {
    const id = num(req.params.id);
    const b = bodyOf(req);
    let s = b.name !== undefined || b.host !== undefined ? suite.repo.upsertServer({ ...suite.repo.getServer(id), ...b, id }) : suite.repo.getServer(id);
    if (typeof b.trackStars === 'boolean' && b.trackStars !== s.trackStars) {
      s = suite.repo.setServerTrackStars(id, b.trackStars);
      // totals only count servers with stars
      for (const i of suite.repo.listIdentities()) suite.rewards.recalc(i.id);
      suite.audit.record(null, b.trackStars ? 'Stars counted on server' : 'Stars no longer counted on server', { server: s.name });
    }
    return s;
  });
  app.delete('/api/servers/:id', async (req: Req) => {
    suite.repo.deleteServer(num(req.params.id));
    return { ok: true };
  });
  /**
   * This server's session without proxy / bind address: the device it runs on connects with its own IP
   * (this PC or the agent). Uses the identity's "direct" network profile (created once, never its default).
   */
  app.post('/api/identities/:id/servers/:sid/direct', async (req: Req) => {
    const id = num(req.params.id);
    const sid = num(req.params.sid);
    const a = suite.repo.getAssignment(id, sid);
    if (!a) throw new ValidationError('This server is not assigned to the identity');
    let p = suite.repo.listNetworkProfiles(id).find((x) => x.kind === 'DIRECT');
    if (!p) {
      const before = suite.repo.getIdentity(id).networkProfileId;
      p = suite.repo.createNetworkProfile(id, { kind: 'DIRECT', name: 'Direct (own IP)' });
      if (before === null) suite.repo.updateIdentity(id, { networkProfileId: null }); // stays a per-server choice
    }
    suite.repo.assignServer(id, { serverId: sid, enabled: a.enabled, autoStart: a.autoStart, networkProfileId: p.id, desiredState: a.desiredState });
    suite.audit.record(id, 'Server uses the direct connection', { server: suite.repo.getServer(sid).name });
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    // a running / retrying session switches right away
    try {
      const st = suite.sessions.getState(`${id}:${sid}`);
      if (st && st.state !== 'STOPPED') await suite.sessions.reconnect(`${id}:${sid}`);
    } catch {
      /* no session yet */
    }
    void suite.sessions.reconcile();
    return { ok: true, networkProfileId: p.id };
  });
  app.put('/api/identities/:id/servers/:sid', async (req: Req) => {
    const id = num(req.params.id);
    const b = bodyOf(req);
    const a = suite.repo.assignServer(id, {
      serverId: num(req.params.sid),
      enabled: b.enabled !== false,
      autoStart: !!b.autoStart,
      networkProfileId: b.networkProfileId ? num(b.networkProfileId) : null,
      desiredState: b.desiredState === 'ONLINE' || b.desiredState === 'OFFLINE' ? b.desiredState : undefined,
    });
    void suite.sessions.reconcile();
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    return a;
  });
  /** Where this identity's session on this server runs: 'default' (like the identity), 'local' or an agent id. */
  app.put('/api/identities/:id/servers/:sid/placement', async (req: Req) => {
    const id = num(req.params.id);
    const sid = num(req.params.sid);
    const v = bodyOf(req).placement;
    const placement = v === 'default' || v === 'local' ? v : { agentId: num(v, 'agent') };
    const a = suite.repo.setPlacement(id, sid, placement);
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    void suite.sessions.placementChanged(id, sid).catch(() => undefined);
    return a;
  });
  app.delete('/api/identities/:id/servers/:sid', async (req: Req) => {
    const id = num(req.params.id);
    suite.repo.unassignServer(id, num(req.params.sid));
    void suite.sessions.reconcile();
    suite.bus.emit({ type: 'identity.changed', identityId: id });
    return { ok: true };
  });
  app.get('/api/sessions', async () => suite.sessions.list());
  app.post('/api/identities/:id/sessions/:sid/start', async (req: Req) => suite.sessions.startSession(num(req.params.id), num(req.params.sid)));
  app.put('/api/identities/:id/servers/:sid/desired', async (req: Req) => {
    const state = String(bodyOf(req).state ?? '');
    if (state !== 'ONLINE' && state !== 'OFFLINE') throw new ValidationError('state must be ONLINE or OFFLINE');
    return suite.sessions.setDesired(num(req.params.id), num(req.params.sid), state);
  });
  // Weekly online schedules (identity × server)
  const parseSchedule = (b: any) => {
    if (b === null || b?.enabled === false && !Array.isArray(b?.hours)) return null;
    if (!Array.isArray(b?.hours) || b.hours.length !== 7 || !b.hours.every((m: unknown) => Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 0xffffff)) {
      throw new ValidationError('schedule.hours must be 7 integers (24-bit hour masks, Monday first)');
    }
    return normalizeSchedule(b);
  };
  const applySchedule = (identityId: number, serverId: number, schedule: ReturnType<typeof parseSchedule>) => {
    suite.repo.setSchedule(identityId, serverId, schedule);
    suite.audit.record(identityId, 'Session schedule changed', { server: suite.repo.getServer(serverId).name, schedule: describeSchedule(schedule) });
  };
  app.get('/api/schedules', async () =>
    suite.repo.listAssignments().map((a) => ({
      identityId: a.identityId,
      serverId: a.serverId,
      serverName: suite.repo.getServer(a.serverId).name,
      desiredState: a.desiredState,
      enabled: a.enabled,
      schedule: a.schedule,
      text: describeSchedule(a.schedule),
    })),
  );
  app.put('/api/identities/:id/servers/:sid/schedule', async (req: Req) => {
    applySchedule(num(req.params.id), num(req.params.sid), parseSchedule(bodyOf(req).schedule));
    void suite.sessions.reconcile();
    return suite.repo.getAssignment(num(req.params.id), num(req.params.sid));
  });
  app.put('/api/schedules/bulk', async (req: Req) => {
    const b = bodyOf(req);
    const schedule = parseSchedule(b.schedule);
    const targets = Array.isArray(b.targets) ? b.targets : [];
    if (!targets.length || targets.length > 5000) throw new ValidationError('targets required');
    for (const t of targets) applySchedule(num(t.identityId), num(t.serverId), schedule);
    void suite.sessions.reconcile();
    return { updated: targets.length };
  });
  /**
   * Rest times (online limit): every selected session gets its own generated week – different online
   * hours, rest blocks and minute offset per account; switching uses the start / stop spacing.
   */
  app.post('/api/schedules/rest', async (req: Req) => {
    const b = bodyOf(req);
    const targets = Array.isArray(b.targets) ? b.targets : [];
    if (!targets.length || targets.length > 5000) throw new ValidationError('targets required');
    const onlineMin = Number(b.onlineMin);
    const onlineMax = Number(b.onlineMax);
    if (!(onlineMin >= 1 && onlineMax <= 23 && onlineMin <= onlineMax)) throw new ValidationError('online hours per day: 1–23, min ≤ max');
    const restAt = spreadRestTimes(targets.length);
    targets.forEach((t: any, i: number) => applySchedule(num(t.identityId), num(t.serverId), generateRestSchedule({ onlineMin, onlineMax, restAt: restAt[i] })));
    void suite.sessions.reconcile();
    return { updated: targets.length };
  });
  app.get('/api/sessions/:sessionId', async (req: Req) => suite.sessions.getState(req.params.sessionId));
  app.post('/api/sessions/:sessionId/stop', async (req: Req) => suite.sessions.stopSession(req.params.sessionId));
  app.post('/api/sessions/:sessionId/reconnect', async (req: Req) => suite.sessions.reconnect(req.params.sessionId));
  app.get('/api/sessions/:sessionId/chat', async (req: Req) =>
    suite.sessions.getChat(req.params.sessionId, {
      limit: req.query.limit ? num(req.query.limit, 'limit') : 200,
      before: req.query.before ? num(req.query.before, 'before') : undefined,
    }),
  );
  app.get('/api/sessions/:sessionId/chat/raw', async (req: Req) => suite.sessions.getRawChat(req.params.sessionId));
  app.post('/api/sessions/:sessionId/chat', async (req: Req) => {
    await suite.sessions.sendChat(req.params.sessionId, String(bodyOf(req).text ?? ''));
    return { ok: true };
  });
  app.get('/api/sessions/:sessionId/events', async (req: Req) => suite.repo.sessionEvents({ sessionId: req.params.sessionId, limit: 200 }));
  // Real Minecraft client window: open (handover / restore) and back to AFK
  app.post('/api/sessions/:sessionId/game', async (req: Req) => suite.sessions.openGame(req.params.sessionId, { method: bodyOf(req).method === 'stable' ? 'stable' : 'auto' }));
  app.delete('/api/sessions/:sessionId/game', async (req: Req) => suite.sessions.closeGame(req.params.sessionId));
  app.post('/api/identities/:id/servers/:serverId/game', async (req: Req) => {
    const identityId = num(req.params.id);
    const serverId = num(req.params.serverId);
    suite.sessions.list(identityId);
    return suite.sessions.openGame(`${identityId}:${serverId}`, { method: bodyOf(req).method === 'stable' ? 'stable' : 'auto' });
  });

  // Global chat across all sessions
  app.get('/api/chat', async (req: Req) =>
    suite.repo.chatLog({
      identityId: req.query.identityId ? num(req.query.identityId) : undefined,
      serverId: req.query.serverId ? num(req.query.serverId) : undefined,
      q: req.query.q || undefined,
      before: req.query.before ? num(req.query.before, 'before') : undefined,
      limit: req.query.limit ? num(req.query.limit, 'limit') : 300,
    }),
  );
  app.post('/api/chat/send', async (req: Req) => {
    const b = bodyOf(req);
    const ids: string[] = Array.isArray(b.sessionIds) ? b.sessionIds.map(String) : [];
    if (!ids.length) throw new ValidationError('No sessions selected');
    const results = [];
    for (const id of ids) {
      try {
        await suite.sessions.sendChat(id, String(b.text ?? ''));
        results.push({ sessionId: id, ok: true });
      } catch (e) {
        results.push({ sessionId: id, ok: false, error: (e as Error).message });
      }
    }
    return { results };
  });

  // Account × Server matrix
  app.get('/api/matrix', async () => {
    const sessions = new Map(suite.sessions.list().map((x) => [x.id, x]));
    const servers = suite.repo.listServers();
    return {
      servers,
      rows: suite.repo.listIdentities().map((i) => ({
        id: i.id,
        number: i.number,
        label: i.label,
        username: suite.repo.getMinecraft(i.id)?.username ?? null,
        cells: servers.map((srv) => {
          const a = suite.repo.getAssignment(i.id, srv.id);
          const sess = sessions.get(`${i.id}:${srv.id}`);
          const rw = a ? suite.repo.getServerReward(i.id, srv.id) : null;
          return a
            ? {
                serverId: srv.id,
                assigned: true,
                enabled: a.enabled,
                desiredState: a.desiredState,
                state: sess?.state ?? 'STOPPED',
                lastError: sess?.lastError ?? null,
                nextAttemptAt: sess?.nextAttemptAt ?? null,
                runtime: sess?.runtime ?? 'lightweight',
                gameStatus: sess?.game?.status ?? null,
                stars: rw?.stars ?? 0,
              }
            : { serverId: srv.id, assigned: false };
        }),
      })),
    };
  });

  // ------------------------------------------------------------------ rewards
  app.patch('/api/identities/:id/rewards', async (req: Req) => {
    const id = num(req.params.id);
    const r = suite.repo.setRewards(
      id,
      { stars: bodyOf(req).stars !== undefined ? Number(bodyOf(req).stars) : undefined, eligible: bodyOf(req).eligible },
      'manual',
    );
    suite.bus.emit({ type: 'reward.changed', identityId: id, data: r });
    return r;
  });

  app.get('/api/identities/:id/rewards/servers', async (req: Req) => {
    const id = num(req.params.id);
    return suite.repo.listAssignments(id).map((a) => ({ ...suite.repo.getServerReward(id, a.serverId), serverName: suite.repo.getServer(a.serverId).name }));
  });
  app.patch('/api/identities/:id/rewards/servers/:sid', async (req: Req) => {
    const b = bodyOf(req);
    const patch: Record<string, unknown> = {};
    if (b.stars !== undefined) patch.stars = Number(b.stars);
    for (const k of ['eligible', 'received', 'waiting', 'discordLinked']) if (k in b) patch[k] = b[k] === null ? null : !!b[k];
    return suite.rewards.setServerState(num(req.params.id), num(req.params.sid), patch as any);
  });

  // ------------------------------------------------------------------ templates
  app.get('/api/templates', async () => suite.repo.listTemplates());
  app.post('/api/templates', async (req: Req) => suite.repo.saveTemplate(bodyOf(req)));
  app.put('/api/templates/:id', async (req: Req) => suite.repo.saveTemplate({ ...bodyOf(req), id: num(req.params.id) }));
  app.delete('/api/templates/:id', async (req: Req) => {
    suite.repo.deleteTemplate(num(req.params.id));
    return { ok: true };
  });

  // ------------------------------------------------------------------ setup / configuration validation
  app.get('/api/setup/checks', async () => {
    type Check = { key: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string; action?: string };
    const checks: Check[] = [];
    checks.push({ key: 'vault', label: 'Credential vault', status: 'ok', detail: `Backend ${suite.vault.backend}` });
    const kitAt = suite.repo.getSetting('vault.recoveryKitExportedAt');
    checks.push({
      key: 'recovery',
      label: 'Vault recovery kit',
      status: kitAt ? 'ok' : 'warn',
      detail: kitAt ? `Exported ${kitAt}` : 'Not exported yet – without it, secrets are lost if the Windows user/PC changes',
      action: '#/settings',
    });
    const rules = suite.getRules();
    checks.push({ key: 'rules', label: 'Recognition rules', status: rules.chatRules.length && rules.mailRules.length ? 'ok' : 'warn', detail: `${rules.mailRules.length} mail rules, ${rules.chatRules.length} chat rule-sets, ${rules.reconnect.rules.length} reconnect rules` });
    const servers = suite.repo.listServers();
    checks.push({ key: 'servers', label: 'Minecraft servers', status: servers.length ? 'ok' : 'error', detail: servers.length ? servers.map((x) => `${x.name} (${x.host}:${x.port})`).join(', ') : 'No server configured', action: '#/servers' });
    const ids = suite.repo.listIdentities();
    checks.push({ key: 'identities', label: 'Identities', status: ids.length ? 'ok' : 'warn', detail: `${ids.length} identities`, action: '#/wizard' });
    const withMc = ids.filter((i) => suite.repo.getMinecraft(i.id)).length;
    checks.push({ key: 'minecraft', label: 'Minecraft accounts', status: withMc === ids.length && ids.length ? 'ok' : 'warn', detail: `${withMc}/${ids.length} identities have a Minecraft account` });
    const mb = suite.repo.listMailAccounts();
    if (mb.length) checks.push({ key: 'mail', label: 'IMAP mailboxes (optional)', status: mb.every((m) => m.credentialRef) ? 'ok' : 'warn', detail: `${mb.filter((m) => m.credentialRef).length}/${mb.length} with credentials`, action: '#/mailboxes' });
    const noNet = ids.filter((i) => i.settings.networkMode !== 'DIRECT' && !i.networkProfileId).length;
    checks.push({ key: 'network', label: 'Network profiles', status: noNet ? 'warn' : 'ok', detail: noNet ? `${noNet} identities without a network profile` : 'All identities have a network profile' });
    const g = suite.game;
    checks.push({
      key: 'game',
      label: 'Minecraft game client',
      status: g ? (g.windowControl === 'none' ? 'warn' : 'ok') : 'error',
      detail: g
        ? `Official client, installed on first "Open game" into ${suite.config.client.rootDir || 'data/minecraft'}; Java: ${suite.config.client.javaPath || 'Mojang runtime (automatic)'}; window control: ${g.windowControl === 'none' ? 'not available on this system (use Alt-Tab)' : g.windowControl}`
        : 'Game client disabled (client.enabled: false)',
    });
    const hosts = suite.runtime.stats().hosts.length;
    checks.push({ key: 'runtime', label: 'Minecraft runtime', status: 'ok', detail: `${suite.config.runtime.mode} mode, ${suite.config.runtime.sessionsPerHost} sessions/host, ${hosts} host process(es) running` });
    return { checks, ok: !checks.some((c) => c.status === 'error') };
  });

  // ------------------------------------------------------------------ monitoring & logs
  app.get('/api/monitoring', async () => ({ ...suite.metrics.snapshot(), sessions: suite.sessions.list() }));
  app.get('/api/logs', async (req: Req) => {
    const q = req.query;
    const level = (['debug', 'info', 'warn', 'error'].includes(q.level) ? q.level : 'info') as Level;
    return recentLogs({
      level,
      scope: q.scope || undefined,
      q: q.q || undefined,
      sessionId: q.sessionId || undefined,
      identityId: q.identityId ? num(q.identityId) : undefined,
      before: q.before ? num(q.before, 'before') : undefined,
      limit: q.limit ? Math.min(num(q.limit, 'limit'), 1000) : 300,
    });
  });

  // ------------------------------------------------------------------ bulk & audit
  app.post('/api/bulk', async (req: Req) => {
    const b = bodyOf(req);
    return {
      results: await suite.bulk.run(String(b.action) as BulkAction, Array.isArray(b.identityIds) ? b.identityIds : [], {
        serverIds: Array.isArray(b.serverIds) ? b.serverIds.map(Number) : undefined,
      }),
    };
  });
  app.get('/api/audit', async (req: Req) =>
    suite.audit.list({
      identityId: req.query.identityId ? num(req.query.identityId) : undefined,
      limit: req.query.limit ? num(req.query.limit, 'limit') : 200,
      before: req.query.before ? num(req.query.before, 'before') : undefined,
    }),
  );

  // Active PC: requests of controllers (standby PCs, the "Hoelni Control" app) – only what makes
  // sense from another device (no vault, no sign-ins of this PC, no windows, no passwords).
  suite.backend.onRpc = async (req) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    const path = stripToken(String(req.path ?? ''));
    if (!remoteAllowed(method, path)) return { status: 403, body: { error: 'Not possible from another device – do it on the PC itself' } };
    const res = await app.inject({
      method: method as 'GET',
      url: path,
      payload: method === 'GET' || req.body === null || req.body === undefined ? undefined : (req.body as Record<string, unknown>),
      headers: { host: `127.0.0.1:${port}`, 'x-hoelni-token': apiToken, 'x-hoelni-remote': '1' },
    });
    let body: unknown = res.body;
    try {
      body = res.json();
    } catch {
      /* not JSON */
    }
    if (method !== 'GET' && res.statusCode < 400) suite.audit.record(null, 'Remote control', { by: String(req.by ?? 'remote').slice(0, 80), action: `${method} ${path.split('?')[0]}` });
    return { status: res.statusCode, body };
  };

  return { app, apiToken };
}
