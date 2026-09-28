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
import { currentBuild, Updater } from '../src/ops/updater.js';
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
  builder = new Builder(store, { repo: repoDir, branch: 'main', channel: 'stable', workDir: path.join(tmp, 'server-data', 'src'), log: () => undefined });
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
