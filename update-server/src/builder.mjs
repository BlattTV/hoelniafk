/**
 * Builds a release from git:
 *   git fetch <branch> → new commit? → checkout → npm ci → npm run build (→ tests)
 *   → backend bundle (dist, public, config, package files, build-info.json) → signed release
 *
 * The bundle contains no node_modules: the suite keeps its own (platform-specific,
 * e.g. better-sqlite3 for Windows) and reinstalls them only when package-lock.json changed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { sha256 } from './sign.mjs';

const BUNDLE_DIRS = ['dist', 'public'];
const BUNDLE_FILES = ['package.json', 'package-lock.json', 'config/rules.yaml', 'config/app.example.yaml', 'desktop/main.cjs', 'desktop/package.json'];

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
    return { skipped: false, build: manifest.build, version: manifest.version, commit };
  }
}
