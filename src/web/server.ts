import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Suite } from '../app.js';
import { SuiteError, ValidationError } from '../core/errors.js';
import { describeSchedule, normalizeSchedule } from '../core/schedule.js';
import { createLogger, onLogEntry, recentLogs, type Level } from '../core/logger.js';
import type { LinkState, MailAccountKind } from '../core/types.js';
import { DISCORD_APP_URL } from '../discord/discordService.js';
import type { BulkAction } from '../ops/bulk.js';
import { refs } from '../vault/refs.js';

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

export async function buildServer(suite: Suite, opts: ServerOptions = {}): Promise<{ app: FastifyInstance; apiToken: string }> {
  const apiToken = opts.apiToken ?? crypto.randomBytes(32).toString('base64url');
  const port = suite.config.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

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

  // ------------------------------------------------------------------ OAuth callback (state-validated, no token)
  app.get('/oauth/callback', async (req: Req, reply) => {
    const { code, state, error } = req.query;
    const page = (title: string, msg: string, ok: boolean) =>
      reply
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/static/styles.css">` +
            `<div class="oauth-result ${ok ? 'ok' : 'err'}"><h1>${title}</h1><p>${msg.replace(/</g, '&lt;')}</p><p>You can close this tab and return to the Hoelni Client Suite.</p></div>`,
        );
    if (error) return page('Authorization cancelled', String(error), false);
    if (!code || !state) return page('Invalid callback', 'Missing code or state', false);
    try {
      const result = await suite.oauth.complete(state, code);
      if (result.purpose.type === 'discord') {
        const d = await suite.discord.completeConnect(result.purpose.identityId, result.tokens);
        return page('Discord connected', `Connected @${d.username} to identity ${result.purpose.identityId}.`, true);
      }
      await suite.mail.storeMailboxOAuth(result.purpose.mailboxId, result.provider, result.tokens);
      return page('Mailbox connected', `OAuth access for mailbox ${result.purpose.mailboxId} stored in the vault.`, true);
    } catch (e) {
      return page('Connection failed', (e as Error).message, false);
    }
  });

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
    const providers = ['microsoft', 'google', 'discord'] as const;
    const oauth: Record<string, boolean> = {};
    for (const p of providers) oauth[p] = await suite.oauth.isConfigured(p);
    const rules = suite.getRules();
    return {
      name: 'Hoelni Client Suite',
      version: suite.updater.status().current.version,
      build: suite.updater.status().current.build,
      vaultBackend: suite.vault.backend,
      identities: suite.repo.listIdentities().length,
      oauth,
      rules: { mail: rules.mailRules.length, chat: rules.chatRules.length },
      discordAppUrl: DISCORD_APP_URL,
    };
  });

  // ------------------------------------------------------------------ backend (afk.hoelni.de): sign-in, agents, account administration
  app.get('/api/backend', async () => suite.backend.status());
  app.get('/api/backend/agents', async () => suite.backend.agentList());
  app.post('/api/backend/certificate', async () => suite.backend.checkCertificate());
  app.post('/api/backend/login', async (req: Req) => {
    const b = bodyOf(req);
    return suite.backend.login(String(b.username ?? ''), String(b.password ?? ''), b.trustCert ? String(b.trustCert) : null);
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

  app.get('/api/settings', async () => {
    const out: Record<string, unknown> = {};
    for (const p of ['microsoft', 'google', 'discord'] as const) {
      out[p] = {
        clientId: suite.repo.getSetting(`oauth.${p}.clientId`) || (suite.config.oauth as any)[p]?.clientId || '',
        hasClientSecret: (await suite.vault.store.get(refs.app(`oauth-${p}`))) !== null,
        ...(p === 'microsoft' ? { tenant: suite.repo.getSetting('oauth.microsoft.tenant') || suite.config.oauth.microsoft.tenant } : {}),
      };
    }
    return { oauth: out, redirectUri: `http://127.0.0.1:${port}/oauth/callback`, automation: suite.config.automation };
  });

  app.put('/api/settings/oauth/:provider', async (req: Req) => {
    const p = req.params.provider;
    if (!['microsoft', 'google', 'discord'].includes(p)) throw new ValidationError('Unknown provider');
    const { clientId, clientSecret, tenant } = bodyOf(req);
    if (clientId !== undefined) suite.repo.setSetting(`oauth.${p}.clientId`, String(clientId).trim());
    if (tenant !== undefined && p === 'microsoft') suite.repo.setSetting('oauth.microsoft.tenant', String(tenant).trim());
    if (clientSecret) await suite.vault.store.set(refs.app(`oauth-${p}`), String(clientSecret));
    if (clientSecret === null) await suite.vault.store.delete(refs.app(`oauth-${p}`));
    suite.audit.record(null, 'OAuth client settings changed', { provider: p });
    return { ok: true };
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

  app.get('/api/identities/:id', async (req: Req) => {
    const id = num(req.params.id);
    const identity = suite.repo.getIdentity(id);
    const mail = suite.repo.getMailIdentity(id);
    return {
      identity,
      minecraft: suite.repo.getMinecraft(id),
      deviceCode: suite.auth.pendingDeviceCode(id),
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
    const updated = suite.repo.updateIdentity(id, { label, settings, networkProfileId });
    suite.bus.emit({ type: 'identity.changed', identityId: id });
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
  app.post('/api/mailboxes/:id/oauth', async (req: Req) => {
    const account = suite.repo.getMailAccount(num(req.params.id));
    if (account.kind === 'imap') throw new ValidationError('Generic IMAP mailboxes use a password');
    return suite.oauth.begin(account.kind, { type: 'mailbox', mailboxId: account.id }, { loginHint: account.username });
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
  app.post('/api/identities/:id/discord/connect', async (req: Req) => suite.discord.beginConnect(num(req.params.id)));
  app.post('/api/identities/:id/discord/verify', async (req: Req) => suite.discord.verify(num(req.params.id)));
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
  app.patch('/api/servers/:id', async (req: Req) => suite.repo.upsertServer({ ...bodyOf(req), id: num(req.params.id) }));
  app.delete('/api/servers/:id', async (req: Req) => {
    suite.repo.deleteServer(num(req.params.id));
    return { ok: true };
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
  app.get('/api/sessions/:sessionId', async (req: Req) => suite.sessions.getState(req.params.sessionId));
  app.post('/api/sessions/:sessionId/stop', async (req: Req) => suite.sessions.stopSession(req.params.sessionId));
  app.post('/api/sessions/:sessionId/reconnect', async (req: Req) => suite.sessions.reconnect(req.params.sessionId));
  app.get('/api/sessions/:sessionId/chat', async (req: Req) =>
    suite.sessions.getChat(req.params.sessionId, {
      limit: req.query.limit ? num(req.query.limit, 'limit') : 200,
      before: req.query.before ? num(req.query.before, 'before') : undefined,
    }),
  );
  app.post('/api/sessions/:sessionId/chat', async (req: Req) => {
    await suite.sessions.sendChat(req.params.sessionId, String(bodyOf(req).text ?? ''));
    return { ok: true };
  });
  app.get('/api/sessions/:sessionId/events', async (req: Req) => suite.repo.sessionEvents({ sessionId: req.params.sessionId, limit: 200 }));
  // Real Minecraft client window: open (handover / restore) and back to AFK
  app.post('/api/sessions/:sessionId/game', async (req: Req) => suite.sessions.openGame(req.params.sessionId));
  app.delete('/api/sessions/:sessionId/game', async (req: Req) => suite.sessions.closeGame(req.params.sessionId));
  app.post('/api/identities/:id/servers/:serverId/game', async (req: Req) => {
    const identityId = num(req.params.id);
    const serverId = num(req.params.serverId);
    suite.sessions.list(identityId);
    return suite.sessions.openGame(`${identityId}:${serverId}`);
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
    for (const p of ['discord', 'microsoft', 'google'] as const) {
      const ok = await suite.oauth.isConfigured(p);
      checks.push({
        key: `oauth-${p}`,
        label: `${p[0].toUpperCase()}${p.slice(1)} OAuth client`,
        status: ok ? 'ok' : p === 'discord' ? 'warn' : 'warn',
        detail: ok ? 'Client ID configured' : p === 'discord' ? 'Required to connect Discord accounts' : 'Only needed for Outlook/Gmail mailboxes via OAuth2',
        action: '#/settings',
      });
    }
    const servers = suite.repo.listServers();
    checks.push({ key: 'servers', label: 'Minecraft servers', status: servers.length ? 'ok' : 'error', detail: servers.length ? servers.map((x) => `${x.name} (${x.host}:${x.port})`).join(', ') : 'No server configured', action: '#/servers' });
    const ids = suite.repo.listIdentities();
    checks.push({ key: 'identities', label: 'Identities', status: ids.length ? 'ok' : 'warn', detail: `${ids.length} identities`, action: '#/wizard' });
    const withMc = ids.filter((i) => suite.repo.getMinecraft(i.id)).length;
    checks.push({ key: 'minecraft', label: 'Minecraft accounts', status: withMc === ids.length && ids.length ? 'ok' : 'warn', detail: `${withMc}/${ids.length} identities have a Minecraft account` });
    const mb = suite.repo.listMailAccounts();
    checks.push({ key: 'mail', label: 'Mailboxes', status: mb.length ? (mb.every((m) => m.credentialRef) ? 'ok' : 'warn') : 'warn', detail: mb.length ? `${mb.filter((m) => m.credentialRef).length}/${mb.length} with credentials` : 'No mailbox configured', action: '#/mailboxes' });
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

  return { app, apiToken };
}
