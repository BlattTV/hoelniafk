/**
 * Hoelni Agent for Android – runs inside the app (Node.js embedded via nodejs-mobile, in the app's
 * own background process next to its foreground service).
 *
 *   node android.js --data <dir> [--vault-key <hex>] [--device-name <name>] [--app-version <v>]
 *
 * The app screen talks to this process over a control server on 127.0.0.1 (random port, random
 * token – both in <dir>/control.json, readable only by the app):
 *
 *   GET  /status          sign-in, agent state, sessions, log, available app update
 *   POST /login           { user, password, name?, trustCert?, backend? }
 *   POST /logout | /pause | /resume
 *   POST /proxy           { proxy }  ("" = none)
 *
 * Signed in, the agent runs by itself – the backend starts and stops the AFK sessions here.
 * The device token and proxy are in the vault; its key comes from the Android keystore
 * (--vault-key, never written to disk by this process).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AgentCore, type AgentStatus } from './agentCore.js';
import { AgentError, agentVersion, AgentStore } from './agentStore.js';
import { requestJson } from './transport.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dataDir = arg('data') ?? process.env.HOELNI_AGENT_DIR ?? path.join(process.cwd(), 'agent-data');
fs.mkdirSync(dataDir, { recursive: true });
const vaultKey = arg('vault-key');
if (vaultKey) process.env.HOELNI_VAULT_PASSPHRASE = vaultKey;
const deviceName = arg('device-name') ?? 'Android';
const appVersion = arg('app-version') ?? null;
const store = new AgentStore(dataDir);

// ------------------------------------------------------------------ log (file + last lines for the screen)
const LOG_FILE = path.join(dataDir, 'agent.log');
const LOG_MAX = 512 * 1024;
const recent: string[] = [];
function log(line: string): void {
  const text = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${line}`;
  recent.push(text);
  if (recent.length > 80) recent.shift();
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, `${text}\n`);
  } catch {
    /* no log is no reason to stop */
  }
}
console.log = (...a: unknown[]) => log(a.map(String).join(' '));
console.warn = console.log;
console.error = (...a: unknown[]) => log(`ERROR ${a.map((x) => (x instanceof Error ? x.stack ?? x.message : String(x))).join(' ')}`);
process.on('uncaughtException', (e) => log(`ERROR uncaught: ${e.stack ?? e.message}`));
process.on('unhandledRejection', (e) => log(`ERROR unhandled: ${(e as Error)?.stack ?? String(e)}`));

// ------------------------------------------------------------------ agent
let agent: AgentCore | null = null;
let status: AgentStatus | null = null;
let lastState = '';

async function startAgent(): Promise<void> {
  if (agent) return;
  const s = store.load();
  const token = store.signedIn(s) ? await store.readToken(s) : null;
  if (!token || !s.deviceId) return;
  const a: AgentCore = new AgentCore(
    { backendUrl: s.backendUrl, token, agentId: s.deviceId, name: s.name ?? deviceName, transport: await store.transport(s), dataDir, version: agentVersion(), noGame: true, allowPrivateTargets: process.env.HOELNI_AGENT_ALLOW_LAN === '1' /* local tests only */ },
    (st) => {
      if (agent !== a) return; // a stopped agent reports its shutdown – not shown any more
      status = st;
      const line = `${st.state}${st.managerOnline ? '' : ' (manager offline)'} – ${st.sessions.length} session(s)${st.lastError ? ` – ${st.lastError}` : ''}`;
      if (line !== lastState) log(line);
      lastState = line;
    },
  );
  agent = a;
  a.start();
  log(`agent started for ${s.username} at ${s.backendUrl}`);
}

async function stopAgent(): Promise<void> {
  const a = agent;
  agent = null;
  status = null;
  await a?.stop();
}

// ------------------------------------------------------------------ app updates (new APK on the backend's download page)
let update: { version: string; build: number | null; url: string } | null = null;
async function checkUpdate(): Promise<void> {
  try {
    const s = store.load();
    const r = await requestJson<{ items: Record<string, { file: string; version: string; build: number | null }> }>(`${s.backendUrl}/download.json`, 'GET', undefined, await store.transport(s));
    const apk = r.items?.android;
    const mine = Number(/build (\d+)/.exec(agentVersion())?.[1] ?? 0);
    update = apk && apk.build && apk.build > mine ? { version: apk.version, build: apk.build, url: `${s.backendUrl}/download/${apk.file}` } : null;
  } catch {
    /* backend without downloads – try again later */
  }
}

// ------------------------------------------------------------------ control server for the app screen
const token = crypto.randomBytes(24).toString('hex');
const sameToken = (t: unknown) => typeof t === 'string' && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) req.destroy(new Error('too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new AgentError('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function view() {
  const s = store.load();
  return {
    ok: true,
    version: agentVersion(),
    appVersion,
    signedIn: store.signedIn(s),
    username: s.username ?? null,
    name: s.name ?? deviceName,
    backendUrl: s.backendUrl,
    proxy: !!(s.proxy || s.proxyInVault),
    agent: status,
    update,
    log: recent.slice(-40),
  };
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-token',
      'Access-Control-Allow-Methods': 'GET, POST',
    });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204, {});
  if (!sameToken(req.headers['x-token'])) return send(401, { ok: false, error: 'unauthorized' });
  try {
    const p = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && p === '/status') return send(200, view());
    if (req.method !== 'POST') return send(404, { ok: false, error: 'not found' });
    const b = await readBody(req);
    if (p === '/login') {
      await stopAgent();
      const r = await store.login({ user: String(b.user ?? '').trim(), password: String(b.password ?? ''), name: String(b.name ?? '').trim() || deviceName, trustCert: b.trustCert ? String(b.trustCert) : undefined, backend: b.backend ? String(b.backend) : undefined });
      log(`signed in as ${r.username} at ${r.backendUrl}`);
      await startAgent();
      void checkUpdate();
      return send(200, view());
    }
    if (p === '/logout') {
      await stopAgent();
      await store.logout();
      log('signed out');
      return send(200, view());
    }
    if (p === '/pause') {
      agent?.pause();
      return send(200, view());
    }
    if (p === '/resume') {
      agent?.resume();
      return send(200, view());
    }
    if (p === '/proxy') {
      const masked = await store.setProxy(String(b.proxy ?? '').trim());
      log(masked ? `proxy set: ${masked}` : 'proxy removed');
      if (agent) {
        await stopAgent();
        await startAgent();
      }
      return send(200, view());
    }
    return send(404, { ok: false, error: 'not found' });
  } catch (e) {
    const err = e instanceof AgentError ? e : new AgentError((e as Error).message);
    return send(400, { ok: false, error: err.message, ...err.extra });
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = (server.address() as { port: number }).port;
  const file = path.join(dataDir, 'control.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  log(`Hoelni Agent ${agentVersion()} on Android (Node ${process.versions.node}) – control port ${port}`);
  void startAgent().catch((e) => log(`ERROR agent: ${(e as Error).message}`));
  void checkUpdate();
  setInterval(() => void checkUpdate(), 6 * 3600_000).unref();
});

const shutdown = () => void stopAgent().finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
