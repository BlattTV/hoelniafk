/**
 * LOCAL INTEGRATION: update server (update-server/) ↔ suite updater ↔ supervisor.
 *   git repo → server build (npm ci + build) → signed release → suite check (pinned key)
 *   → download + SHA-256 → staging → supervisor applies on restart → rollback on early crash
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPendingUpdate, RESTART_FOR_UPDATE, rollbackUpdate } from '../src/ops/updateApply.js';
import { currentBuild, isLanUrl, Updater } from '../src/ops/updater.js';
import { keyFingerprint, verifyEnvelope } from '../src/ops/updateSig.js';
import { supervise } from '../src/supervisor.js';
import { waitFor } from './helpers.js';

// update-server is plain ESM JavaScript (runs without a build step in the LXC)
const server = await import('../update-server/src/server.mjs' as string);
const { Store } = await import('../update-server/src/store.mjs' as string);
const { Builder } = await import('../update-server/src/builder.mjs' as string);
const { generateKeyPair, fingerprint } = await import('../update-server/src/sign.mjs' as string);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-upd-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** A tiny "suite" repository: `npm run build` writes dist/index.js which prints its version. */
function makeRepo(dir: string) {
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-suite', version: '0.2.0', private: true, scripts: { build: 'node build.cjs' } }, null, 1));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'fake-suite', version: '0.2.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fake-suite', version: '0.2.0' } } }, null, 1));
  fs.writeFileSync(path.join(dir, 'build.cjs'), `const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.js','console.log('+JSON.stringify(fs.readFileSync('VERSION','utf8'))+')');`);
  fs.writeFileSync(path.join(dir, 'VERSION'), 'v1');
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>v1</h1>');
  fs.writeFileSync(path.join(dir, 'config', 'rules.yaml'), 'rules: v1\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\nnode_modules/\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial version');
}

let repoDir: string;
let store: any;
let builder: any;
let httpServer: http.Server;
let url: string;
let publicKey: string;

beforeAll(async () => {
  repoDir = path.join(tmp, 'origin');
  fs.mkdirSync(repoDir);
  makeRepo(repoDir);
  const kp = generateKeyPair();
  publicKey = kp.publicB64;
  store = new Store(path.join(tmp, 'server-data'), kp.privatePem);
  builder = new Builder(store, { repo: repoDir, branch: 'main', channel: 'stable', workDir: path.join(tmp, 'server-data', 'src'), installers: false, log: () => undefined });
  httpServer = server.createServer({ store, builder, publicKey, adminTokenHash: 'a'.repeat(64) });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(httpServer.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => httpServer?.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Minimal settings store instead of the SQLite repository. */
function fakeRepo() {
  const m = new Map<string, string>();
  return { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string) => void m.set(k, v) } as any;
}
const fakeAudit = { record: () => undefined } as any;
const fakeBus = { emit: () => undefined } as any;

/** An "installed" suite: files as the updater expects them. */
function makeInstall(dir: string) {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'console.log("v0")');
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>v0</h1>');
  fs.writeFileSync(path.join(dir, 'config', 'rules.yaml'), 'rules: v1\n');
  fs.copyFileSync(path.join(repoDir, 'package.json'), path.join(dir, 'package.json'));
  fs.copyFileSync(path.join(repoDir, 'package-lock.json'), path.join(dir, 'package-lock.json'));
}

describe('update server', () => {
  it('builds a signed release from git and skips unchanged commits', async () => {
    const r = await builder.build({ ifChanged: true });
    expect(r.build).toBe(1);
    expect((await builder.build({ ifChanged: true })).skipped).toBe(true);
    const env = store.latest('stable');
    expect(env.manifest.version).toMatch(/^0\.2\.0\+1\.[0-9a-f]{7}$/);
    expect(env.manifest.notes).toContain('initial version');
    expect(verifyEnvelope(env, publicKey)).toBe(true);
    expect(fingerprint(publicKey)).toBe(keyFingerprint(publicKey));
  }, 60_000);

  it('serves public read endpoints and protects admin endpoints', async () => {
    expect((await fetch(`${url}/api/channels/stable/latest`)).status).toBe(200);
    expect((await fetch(`${url}/api/channels/beta/latest`)).status).toBe(404);
    expect((await fetch(`${url}/api/build`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${url}/files/1/../../config.json`)).status).toBe(404);
    expect((await fetch(`${url}/files/1/manifest.json`)).status).toBe(404); // only files named in the manifest
    const page = await (await fetch(`${url}/`)).text();
    expect(page).toContain(fingerprint(publicKey));
  });
});

describe('suite updater', () => {
  const root = path.join(tmp, 'install');
  let up: Updater;

  it('refuses to check before the key is confirmed, then finds the update', async () => {
    makeInstall(root);
    up = new Updater(fakeRepo(), fakeAudit, fakeBus, root);
    up.configure({ url });
    expect((await up.check()).error).toMatch(/key is not confirmed/);
    const probe = await up.probe(url);
    expect(probe.fingerprint).toBe(fingerprint(publicKey));
    up.configure({ publicKey: probe.publicKey });
    const st = await up.check();
    expect(st.error).toBeNull();
    expect(st.current.build).toBe(0);
    expect(st.available).toBe(true);
  });

  it('rejects a release signed with a different key', async () => {
    const other = generateKeyPair();
    const bad = new Updater(fakeRepo(), fakeAudit, fakeBus, root);
    bad.configure({ url, publicKey: other.publicB64 });
    expect((await bad.check()).error).toMatch(/signature is INVALID/);
  });

  it('downloads, verifies and stages; the supervisor step applies it', async () => {
    fs.writeFileSync(path.join(root, 'config', 'rules.yaml'), 'rules: edited by me\n'); // user edit is kept
    const st = await up.download();
    expect(st.state).toBe('staged');
    expect(st.pending.lockChanged).toBe(false);
    const r = applyPendingUpdate(root);
    expect(r).toEqual({ applied: true, build: 1 });
    expect(fs.readFileSync(path.join(root, 'dist', 'index.js'), 'utf8')).toContain('v1');
    expect(fs.readFileSync(path.join(root, 'config', 'rules.yaml'), 'utf8')).toContain('edited by me');
    expect(fs.existsSync(path.join(root, 'config', 'rules.yaml.new'))).toBe(true);
    expect(currentBuild(root).build).toBe(1);
    expect((await up.check()).available).toBe(false);
  });

  it('rolls back to the previous files', async () => {
    expect(rollbackUpdate(root, 'test')).toBe(true);
    expect(fs.readFileSync(path.join(root, 'dist', 'index.js'), 'utf8')).toContain('v0');
    expect(currentBuild(root).build).toBe(0);
  });

  it('a tampered download is refused', async () => {
    const env = store.envelope(1);
    const file = path.join(store.releaseDir(1), env.manifest.backend.file);
    const orig = fs.readFileSync(file);
    const tampered = Buffer.from(orig);
    tampered[tampered.length - 30] ^= 0xff;
    fs.writeFileSync(file, tampered);
    await up.check();
    await expect(up.download()).rejects.toThrow(/Checksum mismatch/);
    fs.writeFileSync(file, orig);
    expect(fs.existsSync(path.join(root, '.update', 'pending.json'))).toBe(false);
  });
});

describe('supervisor with updates', () => {
  it('exit code 75 → applies the staged update and restarts; a crashing update is rolled back', async () => {
    const root = path.join(tmp, 'sup');
    makeInstall(root);
    // entry that behaves like the suite: v0 exits with 75 once the update is staged ("Install update"), v1 crashes
    const entry = path.join(root, 'entry.cjs');
    const go = path.join(root, 'go');
    fs.writeFileSync(entry, `const fs=require('fs');const v=fs.readFileSync(${JSON.stringify(path.join(root, 'dist', 'index.js'))},'utf8');fs.appendFileSync(${JSON.stringify(path.join(root, 'runs.log'))}, v+'\\n');
      if(v.includes('v1')) process.exit(3);
      setInterval(()=>{ if(fs.existsSync(${JSON.stringify(go)})){fs.rmSync(${JSON.stringify(go)});process.exit(${RESTART_FOR_UPDATE});} },100);
      process.on('SIGTERM',()=>process.exit(0));`);
    const logs: string[] = [];
    const sup = supervise({ command: process.execPath, args: [entry], minBackoffMs: 50, maxBackoffMs: 100, updateRoot: root, updateProbationMs: 5000, log: (m) => logs.push(m) });
    await waitFor(() => fs.existsSync(path.join(root, 'runs.log')), 5000, 'v0 running');
    const up = new Updater(fakeRepo(), fakeAudit, fakeBus, root);
    up.configure({ url, publicKey });
    await up.check();
    await up.download();
    fs.writeFileSync(go, '1');
    await waitFor(() => logs.some((l) => /rolled back/.test(l)), 15_000, 'rollback');
    await waitFor(() => !!sup.child, 5000, 'running again');
    await new Promise((r) => setTimeout(r, 300));
    const runs = fs.readFileSync(path.join(root, 'runs.log'), 'utf8').trim().split('\n');
    expect(runs[0]).toContain('v0'); // old version asks for the update restart
    expect(runs).toContainEqual(expect.stringContaining('v1')); // update applied and started
    expect(runs.at(-1)).toContain('v0'); // crashed during probation → previous version restored
    expect(JSON.parse(fs.readFileSync(path.join(root, '.update', 'failed.json'), 'utf8')).error).toMatch(/rolled back/);
    await sup.stop();
  }, 30_000);
});

describe('updates through the backend (https://afk.hoelni.de/updates)', () => {
  it('passes signed releases to signed-in devices only and never exposes the admin API', async () => {
    const { Accounts } = await import('../backend/src/accounts.mjs' as string);
    const { openDb } = await import('../backend/src/db.mjs' as string);
    const { Relay } = await import('../backend/src/relay.mjs' as string);
    const { createBackendServer } = await import('../backend/src/server.mjs' as string);
    const accounts = new Accounts(openDb(path.join(tmp, 'backend.db')));
    const user = accounts.createUser('niklas', 'admin-password-1', 'admin');
    const { token } = accounts.registerDevice(user, 'manager', 'pc');
    const quiet = { info: () => undefined, error: () => undefined };
    const relay = new Relay(accounts, quiet);
    const backend = createBackendServer({ accounts, relay, config: { updatesUpstream: url }, log: quiet });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
    const updatesUrl = `http://127.0.0.1:${(backend.address() as any).port}/updates`;
    try {
      // anonymous: refused; admin API of the update server: not reachable at all
      expect((await fetch(`${updatesUrl}/api/public-key`)).status).toBe(401);
      expect((await fetch(`${updatesUrl}/api/releases`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await fetch(`${updatesUrl}/api/build`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);

      const root2 = path.join(tmp, 'install-via-backend');
      makeInstall(root2);
      const up = new Updater(fakeRepo(), fakeAudit, fakeBus, root2);
      up.authHeaders = async (u) => (u.startsWith(updatesUrl) ? { Authorization: `Bearer ${token}` } : {});
      const probe = await up.probe(updatesUrl);
      expect(probe.fingerprint).toBe(fingerprint(publicKey));
      up.configure({ url: updatesUrl, publicKey: probe.publicKey });
      const st = await up.check();
      expect(st.error).toBeNull();
      expect(st.available).toBe(true);
      expect((await up.download()).state).toBe('staged');

      // automatic: a LAN update address is replaced by the backend (key over the authenticated connection),
      // a custom public update server is kept, plain HTTP to a remote backend is refused
      const lan = new Updater(fakeRepo(), fakeAudit, fakeBus, root2);
      lan.authHeaders = up.authHeaders;
      lan.configure({ url: 'http://192.168.1.50:8787' });
      expect(await lan.adoptBackend(updatesUrl)).toBe(true);
      expect(lan.settings().url).toBe(updatesUrl);
      expect(keyFingerprint(lan.settings().publicKey!)).toBe(fingerprint(publicKey));
      expect(await lan.adoptBackend(updatesUrl)).toBe(false); // already set
      const custom = new Updater(fakeRepo(), fakeAudit, fakeBus, root2);
      custom.authHeaders = up.authHeaders;
      custom.configure({ url: 'https://updates.example.org' });
      expect(await custom.adoptBackend(updatesUrl)).toBe(false);
      expect(custom.settings().url).toBe('https://updates.example.org');
      const fresh = new Updater(fakeRepo(), fakeAudit, fakeBus, root2);
      expect(await fresh.adoptBackend('http://afk.example.org/updates')).toBe(false);
      expect(isLanUrl('http://192.168.130.122:8787')).toBe(true);
      expect(isLanUrl('http://hoelni-updates:8787')).toBe(true);
      expect(isLanUrl('https://afk.hoelni.de/updates')).toBe(false);

      // a revoked device gets nothing
      accounts.revokeDevice(accounts.deviceByToken(token).id);
      expect((await up.check()).error).toMatch(/401/);
    } finally {
      relay.close();
      await new Promise<void>((r) => backend.close(() => r()));
    }
  }, 60_000);

  it('the agent updates itself through the backend: pinned key, verified bundle, installed only when idle', async () => {
    const { Accounts } = await import('../backend/src/accounts.mjs' as string);
    const { openDb } = await import('../backend/src/db.mjs' as string);
    const { Relay } = await import('../backend/src/relay.mjs' as string);
    const { createBackendServer } = await import('../backend/src/server.mjs' as string);
    const { AgentUpdater } = await import('../src/agent/agentUpdater.js');
    const accounts = new Accounts(openDb(path.join(tmp, 'backend-agent.db')));
    const user = accounts.createUser('niklas', 'admin-password-1', 'admin');
    const { token } = accounts.registerDevice(user, 'agent', 'living room');
    const quiet = { info: () => undefined, error: () => undefined };
    const relay = new Relay(accounts, quiet);
    const backend = createBackendServer({ accounts, relay, config: { updatesUpstream: url }, log: quiet });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
    const backendUrl = `http://127.0.0.1:${(backend.address() as any).port}`;
    try {
      const root = path.join(tmp, 'agent-install');
      makeInstall(root);
      let key: string | null = null;
      let idle = false;
      let game = false;
      let restarts = 0;
      const mk = (over: Record<string, unknown> = {}) =>
        new AgentUpdater({
          backendUrl,
          token,
          transport: {},
          root,
          getKey: () => key,
          setKey: (k) => (key = k),
          isIdle: () => idle,
          gameOpen: () => game,
          restart: () => restarts++,
          ...over,
        });
      const up = mk();
      expect(await up.check()).toBe(true);
      expect(keyFingerprint(key!)).toBe(fingerprint(publicKey)); // pinned on first contact
      expect(up.status().state).toBe('staged');
      expect(fs.existsSync(path.join(root, '.update', 'pending.json'))).toBe(true);
      // sessions running / game open: not now
      expect(up.maybeInstall()).toBe(false);
      idle = true;
      game = true;
      expect(up.maybeInstall()).toBe(false);
      game = false;
      expect(up.maybeInstall()).toBe(true);
      expect(restarts).toBe(1);
      // sessions all the time: installed anyway after the grace period (they reconnect)
      const busy = mk({ forceAfterMs: 1000 });
      idle = false;
      expect(await busy.check()).toBe(true);
      expect(busy.maybeInstall()).toBe(false);
      expect(busy.maybeInstall(Date.now() + 2000)).toBe(true);
      // the account owner says "update now": installed right away even with sessions running …
      const now = mk();
      const before = restarts;
      expect(await now.updateNow()).toBe('installing');
      expect(restarts).toBe(before + 1);
      // … but never while the game window is open
      game = true;
      expect(await mk().updateNow()).toMatch(/game window/);
      game = false;
      // the agent app installs it while the agent is not running
      expect(applyPendingUpdate(root).applied).toBe(true);
      expect(currentBuild(root).build).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(root, 'dist', 'index.js'), 'utf8')).not.toContain('v0');
      const after = mk();
      expect(await after.check()).toBe(false); // up to date
      expect(after.status().state).toBe('idle');

      // a different key later (manipulated backend): refused, nothing staged
      key = generateKeyPair().publicB64;
      const other = mk();
      expect(await other.check()).toBe(false);
      expect(other.status().error).toMatch(/update key of the backend changed/);
      // without sign-in nothing is served
      const anon = mk({ token: 'nope', getKey: () => null });
      expect(await anon.check()).toBe(false);
      expect(anon.status().error).toMatch(/401|Sign in/);
    } finally {
      relay.close();
      await new Promise<void>((r) => backend.close(() => r()));
    }
  }, 60_000);

  it('offers the Windows installers and the Android app: update server and a public download page on the backend', async () => {
    const { Accounts } = await import('../backend/src/accounts.mjs' as string);
    const { openDb } = await import('../backend/src/db.mjs' as string);
    const { Relay } = await import('../backend/src/relay.mjs' as string);
    const { createBackendServer } = await import('../backend/src/server.mjs' as string);
    const crypto = await import('node:crypto');
    const exe = path.join(tmp, 'Hoelni-Agent-Setup-9.9.9.exe');
    const bytes = crypto.randomBytes(200_000);
    fs.writeFileSync(exe, bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    store.setDownloads([{ kind: 'agent', file: 'Hoelni-Agent-Setup-9.9.9.exe', path: exe, size: bytes.length, sha256: sha, version: '9.9.9' }], { build: 7, inputsHash: 'x' });
    expect(() => store.setDownloads([{ kind: 'agent', file: '../evil.exe', path: exe, size: 1, sha256: '', version: '' }])).toThrow(/Bad installer name/);
    // the Android app (APK) is offered next to the Windows installers
    const apk = path.join(tmp, 'Hoelni-Agent-Android-9.9.9-8.apk');
    fs.writeFileSync(apk, bytes.subarray(0, 1000));
    store.setDownloads([{ kind: 'android', file: 'Hoelni-Agent-Android-9.9.9-8.apk', path: apk, size: 1000, sha256: 'a'.repeat(64), version: '9.9.9-8' }], { build: 8 });
    expect(store.downloads.items.agent.file).toBe('Hoelni-Agent-Setup-9.9.9.exe'); // still offered
    expect((await fetch(`${url}/downloads/Hoelni-Agent-Android-9.9.9-8.apk`)).headers.get('content-type')).toBe('application/vnd.android.package-archive');
    // update server: list + file
    const list = await (await fetch(`${url}/api/downloads`)).json();
    expect(list.items.agent).toMatchObject({ file: 'Hoelni-Agent-Setup-9.9.9.exe', sha256: sha, build: 7 });
    expect(Buffer.from(await (await fetch(`${url}/downloads/Hoelni-Agent-Setup-9.9.9.exe`)).arrayBuffer()).equals(bytes)).toBe(true);
    expect((await fetch(`${url}/downloads/backend-1.zip`)).status).toBe(404); // only offered installers
    // backend: public page (no sign-in – installers contain no secrets) + download pass-through
    const accounts = new Accounts(openDb(path.join(tmp, 'backend-dl.db')));
    const quiet = { info: () => undefined, error: () => undefined };
    const relay = new Relay(accounts, quiet);
    const backend = createBackendServer({ accounts, relay, config: { updatesUpstream: url, publicUrl: 'https://afk.example.org' }, log: quiet });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
    const b = `http://127.0.0.1:${(backend.address() as any).port}`;
    try {
      const page = await fetch(`${b}/download`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('/download/Hoelni-Agent-Setup-9.9.9.exe');
      expect(html).toContain(sha);
      expect(html).toMatch(/Hoelni Client Suite[\s\S]*Noch nicht gebaut/); // suite installer not built yet
      const dl = await fetch(`${b}/download/Hoelni-Agent-Setup-9.9.9.exe`);
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);
      expect((await fetch(`${b}/download/backend-1.zip`)).status).toBe(404);
      expect((await fetch(`${b}/download/..%2Fstate.json`)).status).toBe(404);
      // Android: on the page, downloadable, and the list the app checks for a newer version of itself
      expect(html).toContain('Hoelni Agent für Android');
      expect(html).toContain('/download/Hoelni-Agent-Android-9.9.9-8.apk');
      const apkDl = await fetch(`${b}/download/Hoelni-Agent-Android-9.9.9-8.apk`);
      expect(apkDl.headers.get('content-type')).toBe('application/vnd.android.package-archive');
      expect((await apkDl.arrayBuffer()).byteLength).toBe(1000);
      const json = await (await fetch(`${b}/download.json`)).json();
      expect(json.items.android).toEqual({ file: 'Hoelni-Agent-Android-9.9.9-8.apk', version: '9.9.9-8', build: 8, size: 1000, sha256: 'a'.repeat(64) });
    } finally {
      relay.close();
      await new Promise<void>((r) => backend.close(() => r()));
    }
  }, 30_000);
});
