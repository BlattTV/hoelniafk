/**
 * Hoelni Agent – command line / background process.
 *
 *   node dist/agent/main.js login --user NAME --password PW [--name "Living room PC"] [--trust-cert]
 *   node dist/agent/main.js change-backend --backend https://… --admin-user A --admin-password P
 *   node dist/agent/main.js set-proxy socks5://user:pass@host:1080     (connection to the backend; "" = none)
 *   node dist/agent/main.js run          (with an IPC channel: controlled by the Hoelni Agent window)
 *   node dist/agent/main.js status | logout
 *   add --json for machine-readable output (used by the agent window)
 *
 * Data: HOELNI_AGENT_DIR, default %APPDATA%\Hoelni Agent (Windows) or ~/.hoelni-agent.
 * The backend address is https://afk.hoelni.de unless an admin of the current backend changed it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCore, type AgentStatus } from './agentCore.js';
import { DEFAULT_BACKEND, normalizeBackendUrl, probeCertificate, requestJson, type TransportOptions } from './transport.js';

interface Stored {
  backendUrl: string;
  token?: string;
  deviceId?: number;
  username?: string;
  name?: string;
  pinnedCert?: string | null;
  proxy?: string | null;
}

const dataDir = process.env.HOELNI_AGENT_DIR ?? (process.platform === 'win32' ? path.join(process.env.APPDATA ?? os.homedir(), 'Hoelni Agent') : path.join(os.homedir(), '.hoelni-agent'));
const file = path.join(dataDir, 'agent.json');
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);
const json = has('json');

function load(): Stored {
  try {
    return { backendUrl: DEFAULT_BACKEND, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { backendUrl: DEFAULT_BACKEND };
  }
}

function save(s: Stored): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

const transport = (s: Stored): TransportOptions => ({ pinnedCert: s.pinnedCert ?? null, proxy: s.proxy ?? null });

function out(result: unknown, text: string): void {
  console.log(json ? JSON.stringify(result) : text);
}

function fail(message: string, extra: Record<string, unknown> = {}, code = 1): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  else console.error(`hoelni-agent: ${message}`);
  process.exit(code);
}

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')).version;
  } catch {
    return '';
  }
}

async function login(): Promise<void> {
  const s = load();
  if (process.env.HOELNI_AGENT_BACKEND) s.backendUrl = normalizeBackendUrl(process.env.HOELNI_AGENT_BACKEND); // development / tests
  const user = flag('user');
  const password = flag('password') ?? process.env.HOELNI_AGENT_PASSWORD;
  if (!user || !password) fail('usage: login --user NAME --password PW [--name NAME] [--trust-cert]');
  // Self-signed backend certificate: the user confirms its fingerprint once (--trust-cert).
  if (!s.pinnedCert) {
    const cert = await probeCertificate(s.backendUrl, { proxy: s.proxy }).catch((e) => fail(`Backend not reachable: ${(e as Error).message}`));
    if (cert && !cert.trusted) {
      if (!has('trust-cert')) fail('The backend uses a certificate that is not publicly trusted – compare the fingerprint and confirm', { needsTrust: true, fingerprint: cert.fingerprint256, subject: cert.subject }, 4);
      s.pinnedCert = cert.pem;
    }
  }
  const name = flag('name') ?? os.hostname();
  const r = await requestJson<{ token: string; deviceId: number; user: { username: string } }>(
    `${s.backendUrl}/api/login`,
    'POST',
    { username: user, password, client: 'agent', name, info: { hostname: os.hostname(), os: `${os.platform()} ${os.release()}`, version: version() } },
    transport(s),
  ).catch((e) => fail((e as Error).message));
  save({ ...s, token: r.token, deviceId: r.deviceId, username: r.user.username, name });
  out({ ok: true, username: r.user.username, backendUrl: s.backendUrl }, `Signed in as ${r.user.username} at ${s.backendUrl}`);
}

async function changeBackend(): Promise<void> {
  const s = load();
  const target = flag('backend');
  const adminUser = flag('admin-user');
  const adminPassword = flag('admin-password') ?? process.env.HOELNI_ADMIN_PASSWORD;
  if (!target || !adminUser || !adminPassword) fail('usage: change-backend --backend URL --admin-user NAME --admin-password PW');
  await requestJson(`${s.backendUrl}/api/verify-admin`, 'POST', { username: adminUser, password: adminPassword }, transport(s)).catch((e) =>
    fail(`The current backend (${s.backendUrl}) did not confirm the admin account: ${(e as Error).message}`),
  );
  const url = normalizeBackendUrl(target);
  save({ backendUrl: url, proxy: s.proxy ?? null, pinnedCert: null });
  out({ ok: true, backendUrl: url }, `Backend changed to ${url} – sign in again`);
}

async function logout(): Promise<void> {
  const s = load();
  if (s.token) await requestJson(`${s.backendUrl}/api/logout`, 'POST', {}, transport(s), { Authorization: `Bearer ${s.token}` }).catch(() => undefined);
  save({ backendUrl: s.backendUrl, proxy: s.proxy ?? null, pinnedCert: s.pinnedCert ?? null });
  out({ ok: true }, 'Signed out');
}

async function run(): Promise<void> {
  const s = load();
  if (!s.token || !s.deviceId) fail('not signed in – run "login" first', { needsLogin: true }, 3);
  const report = (st: AgentStatus) => {
    if (process.send) process.send({ type: 'status', status: { ...st, username: s.username } });
    else if (!json) console.log(`${new Date().toISOString()} ${st.state}${st.managerOnline ? '' : ' (manager offline)'} – ${st.sessions.length} session(s)${st.lastError ? ` – ${st.lastError}` : ''}`);
  };
  const agent = new AgentCore(
    { backendUrl: s.backendUrl, token: s.token!, agentId: s.deviceId!, name: s.name ?? os.hostname(), transport: transport(s), dataDir, version: version() },
    report,
  );
  agent.start();
  process.on('message', (m: any) => {
    if (m?.cmd === 'pause') agent.pause();
    else if (m?.cmd === 'resume') agent.resume();
    else if (m?.cmd === 'status') report(agent.status);
    else if (m?.cmd === 'stop') void agent.stop().then(() => process.exit(0));
  });
  const stop = () => void agent.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
}

switch (argv[0]) {
  case 'login':
    await login();
    break;
  case 'change-backend':
    await changeBackend();
    break;
  case 'set-proxy': {
    const proxy = argv[1] ?? '';
    if (proxy && !/^(https?|socks5h?):\/\//i.test(proxy)) fail('proxy must look like http://host:port or socks5://user:pass@host:port');
    save({ ...load(), proxy: proxy || null });
    out({ ok: true, proxy }, proxy ? `Proxy set: ${proxy.replace(/\/\/[^@]*@/, '//***@')}` : 'Proxy removed');
    break;
  }
  case 'logout':
    await logout();
    break;
  case 'status': {
    const s = load();
    out({ ok: true, backendUrl: s.backendUrl, signedIn: !!s.token, username: s.username ?? null, name: s.name ?? null, proxy: !!s.proxy }, `${s.backendUrl} – ${s.token ? `signed in as ${s.username}` : 'not signed in'}`);
    break;
  }
  case 'run':
    await run();
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    if (argv[0]) process.exit(1);
}
