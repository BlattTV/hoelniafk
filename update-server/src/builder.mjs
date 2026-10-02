/**
 * Builds a release from git:
 *   git fetch <branch> → new commit? → checkout → npm ci → npm run build (→ tests)
 *   → backend bundle (dist, public, config, package files, build-info.json) → signed release
 *
 * The bundle contains no node_modules: the suite keeps its own (platform-specific,
 * e.g. better-sqlite3 for Windows) and reinstalls them only when package-lock.json changed.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { sha256 } from './sign.mjs';

const BUNDLE_DIRS = ['dist', 'public'];
const BUNDLE_FILES = [
  'package.json', 'package-lock.json', 'config/rules.yaml', 'config/app.example.yaml',
  // window programs – installed programs start the updated ones (desktop/loader.cjs, agent-app/loader.cjs);
  // same list as SHELL_FILES in scripts/build-installers.mjs
  'desktop/main.cjs', 'desktop/package.json', 'desktop/build/icon.png', 'desktop/build/tray.png', 'desktop/build/logo.png', 'desktop/build/icon.ico',
  'agent-app/main.cjs', 'agent-app/preload.cjs', 'agent-app/ui.html', 'agent-app/ui.js', 'agent-app/logo.png', 'agent-app/mark.png', 'agent-app/package.json',
  'agent-app/build/icon.png', 'agent-app/build/tray.png', 'agent-app/build/icon.ico',
];

/** Files that make a new installer necessary (Electron version, starter, build script, icons). */
const INSTALLER_INPUTS = ['desktop/package.json', 'desktop/package-lock.json', 'desktop/loader.cjs', 'agent-app/package.json', 'agent-app/loader.cjs', 'scripts/build-installers.mjs', 'desktop/build/icon.ico', 'agent-app/build/icon.ico'];

function run(cmd, args, cwd, env = {}) {
  return execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
}

/** Zips a built source tree into a backend bundle; returns { bundle, lockHash, version }. */
export function bundleFromDir(srcDir, meta = {}) {
  const files = {};
  for (const d of BUNDLE_DIRS) {
    if (!fs.existsSync(path.join(srcDir, d))) throw new Error(`Build output "${d}" missing in ${srcDir}`);
    const list = [];
    walk(srcDir, d, list);
    for (const f of list) files[f] = new Uint8Array(fs.readFileSync(path.join(srcDir, f)));
  }
  for (const f of BUNDLE_FILES) if (fs.existsSync(path.join(srcDir, f))) files[f] = new Uint8Array(fs.readFileSync(path.join(srcDir, f)));
  if (!files['package.json']) throw new Error('package.json missing');
  const pkg = JSON.parse(Buffer.from(files['package.json']).toString('utf8'));
  const lockHash = files['package-lock.json'] ? sha256(files['package-lock.json']) : null;
  const rulesHash = files['config/rules.yaml'] ? sha256(files['config/rules.yaml']) : null;
  const info = { version: pkg.version, commit: meta.commit ?? null, branch: meta.branch ?? null, build: meta.build ?? null, lockHash, rulesHash, createdAt: new Date().toISOString() };
  files['build-info.json'] = strToU8(JSON.stringify(info, null, 2));
  return { bundle: Buffer.from(zipSync(files, { level: 6 })), lockHash, version: pkg.version };
}

export class Builder {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {{ repo: string, branch: string, channel: string, workDir: string, runTests?: boolean, gitToken?: string, log?: (m: string) => void }} opts
   */
  constructor(store, opts) {
    this.store = store;
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.running = null;
    this.last = null;
  }

  status() {
    return { running: !!this.running, last: this.last, lastCommit: this.store.state.lastCommit, repo: this.opts.repo, branch: this.opts.branch };
  }

  gitEnv() {
    // Private repositories: token via an ephemeral credential helper (never written into .git/config).
    if (!this.opts.gitToken) return {};
    return {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: `!f() { echo username=x-access-token; echo password=${this.opts.gitToken}; }; f`,
    };
  }

  /** Single-flight: concurrent calls share the running build. */
  build({ ifChanged = false, channel } = {}) {
    if (!this.running) {
      this.running = this.doBuild({ ifChanged, channel: channel ?? this.opts.channel })
        .then((r) => (this.last = { ok: true, at: new Date().toISOString(), ...r }))
        .catch((e) => {
          this.last = { ok: false, at: new Date().toISOString(), error: String(e.stderr || e.message).slice(-2000) };
          throw e;
        })
        .finally(() => (this.running = null));
    }
    return this.running;
  }

  /** Cross-process lock (the service's auto build and a manual CLI build must not overlap). */
  lock() {
    const file = path.join(this.store.dataDir, 'build.lock');
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    } catch {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = pid !== process.pid;
      } catch {}
      if (alive) throw new Error(`Another build is running (pid ${pid})`);
      fs.writeFileSync(file, String(process.pid));
    }
    return () => fs.rmSync(file, { force: true });
  }

  async doBuild(args) {
    const unlock = this.lock();
    try {
      return await this.doBuildLocked(args);
    } finally {
      unlock();
    }
  }

  async doBuildLocked({ ifChanged, channel }) {
    const { repo, branch, workDir } = this.opts;
    const env = this.gitEnv();
    if (!fs.existsSync(path.join(workDir, '.git'))) {
      fs.mkdirSync(path.dirname(workDir), { recursive: true });
      this.log(`cloning ${repo}`);
      run('git', ['clone', '--quiet', '--branch', branch, repo, workDir], path.dirname(workDir), env);
    }
    run('git', ['fetch', '--quiet', 'origin', branch], workDir, env);
    const commit = run('git', ['rev-parse', `origin/${branch}`], workDir).trim();
    const prev = this.store.state.lastCommit;
    if (ifChanged && prev === commit) return { skipped: true, commit };
    run('git', ['checkout', '--quiet', '--force', commit], workDir);
    run('git', ['clean', '-fdq', '-e', 'node_modules'], workDir);
    let notes = [];
    try {
      const range = prev ? `${prev}..${commit}` : `-15`;
      notes = run('git', ['log', '--format=%s', ...(prev ? [range] : [range, commit]), '--max-count=30'], workDir).split('\n').filter(Boolean);
    } catch {
      notes = [run('git', ['log', '-1', '--format=%s', commit], workDir).trim()];
    }
    this.log(`building ${commit.slice(0, 7)} (${branch})`);
    run('npm', ['ci', '--no-audit', '--no-fund'], workDir, { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' });
    run('npm', ['run', 'build'], workDir);
    if (this.opts.runTests) {
      this.log('running unit tests');
      run('npm', ['run', 'test:unit'], workDir);
    }
    const build = this.store.state.nextBuild;
    const { bundle, lockHash, version } = bundleFromDir(workDir, { commit, branch, build });
    const manifest = this.store.publish({ bundle, version, commit, branch, notes, lockHash, channel });
    this.log(`published build ${manifest.build} (${manifest.version}) to "${channel}"`);
    if (this.opts.keep) this.store.prune(this.opts.keep);
    let installers = null;
    let android = null;
    if (this.opts.installers !== false) {
      installers = await this.buildInstallersLocked({ build: manifest.build });
      android = await this.buildAndroidLocked({ build: manifest.build });
    }
    return { skipped: false, build: manifest.build, version: manifest.version, commit, installers, android };
  }

  /** Inputs of the installers: they only need a rebuild when these change (the programs update themselves). */
  installerInputsHash() {
    const h = crypto.createHash('sha256').update(process.version);
    for (const f of INSTALLER_INPUTS) {
      const p = path.join(this.opts.workDir, f);
      h.update(`${f}\0`);
      if (fs.existsSync(p)) h.update(fs.readFileSync(p));
    }
    return h.digest('hex');
  }

  /**
   * Windows installers of the suite and the agent (offered at <backend>/download for new PCs).
   * Built on this Linux machine (scripts/build-installers.mjs, no Wine). Failures never block a release.
   */
  async buildInstallersLocked({ build = null, force = false } = {}) {
    const workDir = this.opts.workDir;
    const inputsHash = this.installerInputsHash();
    const current = this.store.downloads;
    const have = ['suite', 'agent'].every((k) => current.items[k] && this.store.downloadPath(current.items[k].file));
    if (!force && have && current.inputsHash === inputsHash) return { skipped: true };
    try {
      this.log('building the Windows installers (suite + agent)');
      run('npm', ['ci', '--no-audit', '--no-fund'], path.join(workDir, 'desktop'), { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' });
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-installers-'));
      try {
        const text = run(process.execPath, [path.join(workDir, 'scripts', 'build-installers.mjs'), '--skip-build', '--out', out], workDir, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
        const result = JSON.parse(text.trim().split('\n').pop());
        const d = this.store.setDownloads(result.installers, { build, inputsHash });
        this.log(`installers ready: ${Object.values(d.items).map((i) => i.file).join(', ')}`);
        return { skipped: false, files: Object.values(d.items).map((i) => i.file) };
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
        for (const d of ['desktop/release', 'desktop/bundle', 'agent-app/release', 'agent-app/bundle']) fs.rmSync(path.join(workDir, d), { recursive: true, force: true });
      }
    } catch (e) {
      const error = String(e.stderr || e.message).slice(-1500);
      this.log(`installer build failed (the release itself is published): ${error}`);
      return { skipped: false, error };
    }
  }

  /**
   * Android app of the agent (APK, offered at <backend>/download). It carries the agent itself, so it
   * is built with every release (scripts/build-android.mjs). The signing key stays in the data
   * directory (android/release.p12) – Android installs updates only over the same key. Missing build
   * tools or a failure never block a release.
   */
  async buildAndroidLocked({ build = null } = {}) {
    const files = [];
    for (const app of ['agent', 'control']) {
      const r = await this.buildAndroidApp(app, build);
      if (r.skipped) return r; // tools missing: same reason for both
      if (r.error) return r;
      files.push(r.file);
    }
    return { skipped: false, file: files.join(', ') };
  }

  /** One Android app: agent (runs AFK sessions on the phone) or control (steers the suite, widgets). */
  async buildAndroidApp(app, build) {
    const workDir = this.opts.workDir;
    const dir = path.join(this.store.dataDir, 'android');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-apk-'));
    try {
      this.log(`building the Android app (${app})`);
      let text;
      try {
        text = run(process.execPath, [path.join(workDir, 'scripts', 'build-android.mjs'), '--app', app, '--skip-build', '--out', out, '--cache', path.join(dir, 'cache'), '--keystore', path.join(dir, 'release.p12'), ...(build ? ['--build', String(build)] : [])], workDir);
      } catch (e) {
        const result = String(e.stdout ?? '').trim().split('\n').pop();
        if (result.startsWith('{') && JSON.parse(result).missing) {
          const error = JSON.parse(result).error;
          this.log(`Android apps skipped – ${error}`);
          return { skipped: true, error };
        }
        throw e;
      }
      const result = JSON.parse(text.trim().split('\n').pop());
      this.store.setDownloads([result], { build });
      this.log(`Android app ready: ${result.file}`);
      return { skipped: false, file: result.file };
    } catch (e) {
      const error = String(e.stderr || e.message).slice(-1500);
      this.log(`Android build (${app}) failed (the release itself is published): ${error}`);
      return { skipped: false, error };
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }

  /** Rebuilds the installers (and the Android app) from the last built commit (hoelni-updates build-installers). */
  async buildInstallers({ force = true } = {}) {
    const unlock = this.lock();
    try {
      if (!fs.existsSync(path.join(this.opts.workDir, 'dist'))) throw new Error('Nothing built yet – run "hoelni-updates build" first');
      const build = this.store.state.nextBuild - 1;
      const installers = await this.buildInstallersLocked({ build, force });
      const android = await this.buildAndroidLocked({ build });
      return { ...installers, android };
    } finally {
      unlock();
    }
  }
}
