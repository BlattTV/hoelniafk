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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCore, type AgentStatus } from './agentCore.js';
import { AgentError, agentVersion, AgentStore } from './agentStore.js';
import { AgentUpdater } from './agentUpdater.js';
import { appRoot } from '../ops/updater.js';
import { RESTART_FOR_UPDATE } from '../ops/updateApply.js';

const dataDir = process.env.HOELNI_AGENT_DIR ?? (process.platform === 'win32' ? path.join(process.env.APPDATA ?? os.homedir(), 'Hoelni Agent') : path.join(os.homedir(), '.hoelni-agent'));
// Linux / other systems without DPAPI: the vault key is a random file next to the data, readable only by
// the agent's user (like the Android app's keystore key) – unless a passphrase is given.
if (process.platform !== 'win32' && !process.env.HOELNI_VAULT_PASSPHRASE) {
  const keyFile = path.join(dataDir, 'vault-key');
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    process.env.HOELNI_VAULT_PASSPHRASE = fs.readFileSync(keyFile, 'utf8').trim();
  } catch (e) {
    console.error(`hoelni-agent: cannot use the vault key file ${keyFile}: ${(e as Error).message}`);
  }
}
const store = new AgentStore(dataDir);
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);
const json = has('json');
const load = () => store.load();
const save = (s: Parameters<AgentStore['save']>[0]) => store.save(s);

function out(result: unknown, text: string): void {
  console.log(json ? JSON.stringify(result) : text);
}

function fail(message: string, extra: Record<string, unknown> = {}, code = 1): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  else console.error(`hoelni-agent: ${message}`);
  process.exit(code);
}

/** Runs a store action; its AgentError becomes the usual error output. */
async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AgentError) fail(e.message, e.extra, e.code);
    fail((e as Error).message);
  }
}

/** Password typed in a terminal without echo (Linux / macOS console). */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function login(): Promise<void> {
  let password = flag('password') ?? process.env.HOELNI_AGENT_PASSWORD ?? '';
  if (!password && !json && process.stdin.isTTY) password = await askHidden(`Password for ${flag('user') ?? ''}: `);
  const r = await attempt(() =>
    store.login({
      user: flag('user') ?? '',
      password,
      name: flag('name'),
      trustCert: flag('trust-cert'),
      backend: process.env.HOELNI_AGENT_BACKEND, // development / tests
    }),
  );
  out({ ok: true, username: r.username, backendUrl: r.backendUrl }, `Signed in as ${r.username} at ${r.backendUrl}`);
}

async function changeBackend(): Promise<void> {
  const target = flag('backend');
  const adminUser = flag('admin-user');
  const adminPassword = flag('admin-password') ?? process.env.HOELNI_ADMIN_PASSWORD;
  if (!target || !adminUser || !adminPassword) fail('usage: change-backend --backend URL --admin-user NAME --admin-password PW');
  const url = await attempt(() => store.changeBackend(target!, adminUser!, adminPassword!));
  out({ ok: true, backendUrl: url }, `Backend changed to ${url} – sign in again`);
}

async function logout(): Promise<void> {
  await store.logout();
  out({ ok: true }, 'Signed out');
}

async function run(): Promise<void> {
  const s = load();
  const token = store.signedIn(s) ? await store.readToken(s) : null;
  if (!token || !s.deviceId) fail('not signed in – run "login" first', { needsLogin: true }, 3);
  let updater: AgentUpdater | null = null;
  const report = (st: AgentStatus) => {
    if (process.send) process.send({ type: 'status', status: { ...st, username: s.username, update: updater?.status() ?? null } });
    else if (!json) console.log(`${new Date().toISOString()} ${st.state}${st.managerOnline ? '' : ' (manager offline)'} – ${st.sessions.length} session(s)${st.lastError ? ` – ${st.lastError}` : ''}`);
  };
  const agent = new AgentCore(
    { backendUrl: s.backendUrl, token: token!, agentId: s.deviceId!, name: s.name ?? os.hostname(), transport: await store.transport(s), dataDir, version: agentVersion(), allowPrivateTargets: process.env.HOELNI_AGENT_ALLOW_LAN === '1',
      // a Linux server without a desktop has no game window – "Open game" says so instead of failing
      ...(process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? { noGame: true, noGameReason: 'This agent runs on a Linux server without a desktop – open the game on a PC' } : {}) },
    report,
  );
  agent.start();
  // Automatic updates: in the installed agent (bundled Node next to it), not in a development checkout.
  const root = appRoot();
  if (process.env.HOELNI_AGENT_UPDATES !== '0' && (fs.existsSync(path.join(root, 'node')) || process.env.HOELNI_AGENT_UPDATES === '1')) {
    updater = new AgentUpdater({
      backendUrl: s.backendUrl,
      token: token!,
      transport: await store.transport(s),
      root,
      getKey: () => load().updatesKey ?? null,
      setKey: (key) => save({ ...load(), updatesKey: key }),
      isIdle: () => agent.status.sessions.length === 0 && !agent.status.game,
      gameOpen: () => !!agent.status.game,
      restart: () => void agent.stop().then(() => process.exit(RESTART_FOR_UPDATE)),
      log: (m) => console.log(`${new Date().toISOString()} ${m}`),
    });
    updater.start();
    const u = updater;
    agent.onUpdateRequest = () => u.updateNow();
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
    const masked = await attempt(() => store.setProxy(proxy));
    out({ ok: true, proxy: masked }, proxy ? `Proxy set: ${masked}` : 'Proxy removed');
    break;
  }
  case 'logout':
    await logout();
    break;
  case 'status': {
    const s = load();
    out({ ok: true, backendUrl: s.backendUrl, signedIn: store.signedIn(s), username: s.username ?? null, name: s.name ?? null, proxy: !!(s.proxy || s.proxyInVault), tokenProtected: !!s.tokenInVault }, `${s.backendUrl} – ${store.signedIn(s) ? `signed in as ${s.username}` : 'not signed in'}`);
    break;
  }
  case 'run':
    await run();
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    if (argv[0]) process.exit(1);
}
