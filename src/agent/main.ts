/**
 * Hoelni Agent – command line / background process.
 *
 *   node dist/agent/main.js login --user NAME [--name "Living room PC"] [--trust-cert SHA256-FINGERPRINT]
 *        (password: HOELNI_AGENT_PASSWORD or --password)
 *   node dist/agent/main.js change-backend --backend https://… --admin-user A   (HOELNI_ADMIN_PASSWORD or --admin-password)
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
import { AgentUpdater } from './agentUpdater.js';
import { appRoot, currentBuild } from '../ops/updater.js';
import { RESTART_FOR_UPDATE } from '../ops/updateApply.js';
import { DEFAULT_BACKEND, normalizeBackendUrl, probeCertificate, requestJson, type TransportOptions } from './transport.js';
import { createKeyProvider } from '../vault/keyProviders.js';
import { refs } from '../vault/refs.js';
import { EncryptedFileVault, type SecretStore } from '../vault/vault.js';

interface Stored {
  backendUrl: string;
  /** Only when no OS key protection is available (e.g. Linux without keyring) – file mode 0600. */
  token?: string;
  tokenInVault?: boolean;
  deviceId?: number;
  username?: string;
  name?: string;
  pinnedCert?: string | null;
  /** Only without OS key protection; otherwise the proxy URL (may contain a password) is in the vault. */
  proxy?: string | null;
  proxyInVault?: boolean;
  /** Update signing key of the backend (pinned on first contact, reset on a new sign-in). */
  updatesKey?: string;
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

// ------------------------------------------------------------------ device token (never in plain text on Windows)
const TOKEN_REF = refs.app('agent-token');
const PROXY_REF = refs.app('agent-proxy');

async function vault(): Promise<SecretStore | null> {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    return await EncryptedFileVault.open(path.join(dataDir, 'agent-vault.json'), createKeyProvider('auto', path.join(dataDir, 'agent-key.dpapi')));
  } catch {
    return null;
  }
}

async function storeToken(s: Stored, token: string): Promise<Stored> {
  const v = await vault();
  if (v) {
    await v.set(TOKEN_REF, token);
    return { ...s, token: undefined, tokenInVault: true };
  }
  return { ...s, token, tokenInVault: false };
}

async function readToken(s: Stored): Promise<string | null> {
  if (!s.tokenInVault) return s.token ?? null;
  return (await (await vault())?.get(TOKEN_REF)) ?? null;
}

async function forgetToken(s: Stored): Promise<void> {
  if (s.tokenInVault) await (await vault())?.delete(TOKEN_REF);
}

const signedIn = (s: Stored) => !!(s.tokenInVault || s.token) && !!s.deviceId;

async function readProxy(s: Stored): Promise<string | null> {
  if (!s.proxyInVault) return s.proxy ?? null;
  return (await (await vault())?.get(PROXY_REF)) ?? null;
}

const proxyFields = (s: Stored) => ({ proxy: s.proxy ?? null, proxyInVault: !!s.proxyInVault });

const transport = async (s: Stored): Promise<TransportOptions> => ({ pinnedCert: s.pinnedCert ?? null, proxy: await readProxy(s) });

function out(result: unknown, text: string): void {
  console.log(json ? JSON.stringify(result) : text);
}

function fail(message: string, extra: Record<string, unknown> = {}, code = 1): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  else console.error(`hoelni-agent: ${message}`);
  process.exit(code);
}

function version(): string {
  const b = currentBuild(appRoot());
  return b.build ? `${b.version} (build ${b.build})` : b.version;
}

async function login(): Promise<void> {
  const s = load();
  if (process.env.HOELNI_AGENT_BACKEND) s.backendUrl = normalizeBackendUrl(process.env.HOELNI_AGENT_BACKEND); // development / tests
  const user = flag('user');
  const password = flag('password') ?? process.env.HOELNI_AGENT_PASSWORD;
  if (!user || !password) fail('usage: login --user NAME --password PW [--name NAME] [--trust-cert FINGERPRINT]');
  // Self-signed backend certificate: the user confirms its fingerprint once (--trust-cert <fingerprint>).
  if (!s.pinnedCert) {
    const cert = await probeCertificate(s.backendUrl, { proxy: await readProxy(s) }).catch((e) => fail(`Backend not reachable: ${(e as Error).message}`));
    if (cert && !cert.trusted) {
      const confirmed = flag('trust-cert');
      if (!confirmed) fail('The backend uses a certificate that is not publicly trusted – compare the fingerprint and confirm', { needsTrust: true, fingerprint: cert.fingerprint256, subject: cert.subject }, 4);
      if (confirmed!.toUpperCase() !== cert.fingerprint256.toUpperCase()) fail('The backend certificate changed since you confirmed it – check again', { needsTrust: true, fingerprint: cert.fingerprint256, subject: cert.subject }, 4);
      s.pinnedCert = cert.pem;
    }
  }
  const name = flag('name') ?? os.hostname();
  const r = await requestJson<{ token: string; deviceId: number; user: { username: string } }>(
    `${s.backendUrl}/api/login`,
    'POST',
    { username: user, password, client: 'agent', name, info: { hostname: os.hostname(), os: `${os.platform()} ${os.release()}`, version: version() } },
    await transport(s),
  ).catch((e) => fail((e as Error).message));
  await forgetToken(s);
  save(await storeToken({ ...s, deviceId: r.deviceId, username: r.user.username, name, updatesKey: undefined }, r.token));
  out({ ok: true, username: r.user.username, backendUrl: s.backendUrl }, `Signed in as ${r.user.username} at ${s.backendUrl}`);
}

async function changeBackend(): Promise<void> {
  const s = load();
  const target = flag('backend');
  const adminUser = flag('admin-user');
  const adminPassword = flag('admin-password') ?? process.env.HOELNI_ADMIN_PASSWORD;
  if (!target || !adminUser || !adminPassword) fail('usage: change-backend --backend URL --admin-user NAME --admin-password PW');
  await requestJson(`${s.backendUrl}/api/verify-admin`, 'POST', { username: adminUser, password: adminPassword }, await transport(s)).catch((e) =>
    fail(`The current backend (${s.backendUrl}) did not confirm the admin account: ${(e as Error).message}`),
  );
  const url = normalizeBackendUrl(target!);
  const token = await readToken(s);
  if (token) await requestJson(`${s.backendUrl}/api/logout`, 'POST', {}, await transport(s), { Authorization: `Bearer ${token}` }).catch(() => undefined);
  await forgetToken(s);
  save({ backendUrl: url, ...proxyFields(s), pinnedCert: null });
  out({ ok: true, backendUrl: url }, `Backend changed to ${url} – sign in again`);
}

async function logout(): Promise<void> {
  const s = load();
  const token = await readToken(s);
  if (token) await requestJson(`${s.backendUrl}/api/logout`, 'POST', {}, await transport(s), { Authorization: `Bearer ${token}` }).catch(() => undefined);
  await forgetToken(s);
  save({ backendUrl: s.backendUrl, ...proxyFields(s), pinnedCert: s.pinnedCert ?? null });
  out({ ok: true }, 'Signed out');
}

async function run(): Promise<void> {
  const s = load();
  const token = signedIn(s) ? await readToken(s) : null;
  if (!token || !s.deviceId) fail('not signed in – run "login" first', { needsLogin: true }, 3);
  let updater: AgentUpdater | null = null;
  const report = (st: AgentStatus) => {
    if (process.send) process.send({ type: 'status', status: { ...st, username: s.username, update: updater?.status() ?? null } });
    else if (!json) console.log(`${new Date().toISOString()} ${st.state}${st.managerOnline ? '' : ' (manager offline)'} – ${st.sessions.length} session(s)${st.lastError ? ` – ${st.lastError}` : ''}`);
  };
  const agent = new AgentCore(
    { backendUrl: s.backendUrl, token: token!, agentId: s.deviceId!, name: s.name ?? os.hostname(), transport: await transport(s), dataDir, version: version(), allowPrivateTargets: process.env.HOELNI_AGENT_ALLOW_LAN === '1' },
    report,
  );
  agent.start();
  // Automatic updates: in the installed agent (bundled Node next to it), not in a development checkout.
  const root = appRoot();
  if (process.env.HOELNI_AGENT_UPDATES !== '0' && (fs.existsSync(path.join(root, 'node')) || process.env.HOELNI_AGENT_UPDATES === '1')) {
    updater = new AgentUpdater({
      backendUrl: s.backendUrl,
      token: token!,
      transport: await transport(s),
      root,
      getKey: () => load().updatesKey ?? null,
      setKey: (key) => save({ ...load(), updatesKey: key }),
      isIdle: () => agent.status.sessions.length === 0 && !agent.status.game,
      gameOpen: () => !!agent.status.game,
      restart: () => void agent.stop().then(() => process.exit(RESTART_FOR_UPDATE)),
      log: (m) => console.log(`${new Date().toISOString()} ${m}`),
    });
    updater.start();
  }
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
    const v = await vault();
    if (v) {
      if (proxy) await v.set(PROXY_REF, proxy);
      else await v.delete(PROXY_REF);
      save({ ...load(), proxy: null, proxyInVault: !!proxy });
    } else save({ ...load(), proxy: proxy || null, proxyInVault: false });
    const masked = proxy.replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:•••@');
    out({ ok: true, proxy: masked }, proxy ? `Proxy set: ${masked}` : 'Proxy removed');
    break;
  }
  case 'logout':
    await logout();
    break;
  case 'status': {
    const s = load();
    out({ ok: true, backendUrl: s.backendUrl, signedIn: signedIn(s), username: s.username ?? null, name: s.name ?? null, proxy: !!(s.proxy || s.proxyInVault), tokenProtected: !!s.tokenInVault }, `${s.backendUrl} – ${signedIn(s) ? `signed in as ${s.username}` : 'not signed in'}`);
    break;
  }
  case 'run':
    await run();
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    if (argv[0]) process.exit(1);
}
