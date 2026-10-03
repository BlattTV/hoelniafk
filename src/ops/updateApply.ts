/**
 * Applies a staged update while the suite is NOT running (called by the supervisor
 * before it starts the suite – on Windows loaded files/native modules are locked).
 *
 *   <root>/.update/staging-<build>/   verified, extracted bundle (written by the Updater)
 *   <root>/.update/pending.json       { build, dir, lockChanged, fromBuild }
 *   <root>/.update/previous/          the replaced files (rollback)
 *   <root>/.update/applied.json       last applied update, { stable } after it ran long enough
 *   <root>/.update/rollback.json      rollback requested (UI) → performed before the next start
 *   <root>/.update/failed.json        last failed / rolled back update
 *
 * Only Node built-ins here: the supervisor must not load native modules that an update replaces.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UPDATE_DIR = '.update';
export const RESTART_FOR_UPDATE = 75;
/** Replaced by an update (config/rules.yaml is handled separately – user edits are kept). */
export const UPDATE_ITEMS = [
  'dist', 'public', 'package.json', 'package-lock.json', 'build-info.json', 'config/app.example.yaml',
  // the window programs (desktop/loader.cjs and agent-app/loader.cjs start these after an update)
  'desktop/main.cjs', 'desktop/package.json', 'desktop/build', 'agent-app', 'agent-linux',
];

type Log = (msg: string) => void;

const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (file: string, v: unknown) => fs.writeFileSync(file, JSON.stringify(v, null, 2));
const sha256File = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function move(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    // e.g. EXDEV or a locked directory: copy + delete
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV' && (e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** npm for dependency changes: the npm that started us, the bundled one, or npm on PATH. */
function npmCommand(root: string): { cmd: string; args: string[]; shell: boolean } {
  const candidates = [process.env.npm_execpath, path.join(root, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(root, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const c of candidates) if (c && c.endsWith('.js') && fs.existsSync(c)) return { cmd: process.execPath, args: [c], shell: false };
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' };
}

export function hasPendingUpdate(root: string): boolean {
  return fs.existsSync(path.join(root, UPDATE_DIR, 'pending.json')) || fs.existsSync(path.join(root, UPDATE_DIR, 'rollback.json'));
}

export function applyPendingUpdate(root: string, log: Log = () => undefined): { applied: boolean; build?: number; error?: string } {
  const dir = path.join(root, UPDATE_DIR);
  if (fs.existsSync(path.join(dir, 'rollback.json'))) {
    fs.rmSync(path.join(dir, 'rollback.json'), { force: true });
    rollbackUpdate(root, 'rollback requested', log);
    return { applied: false };
  }
  const pending = readJson(path.join(dir, 'pending.json'));
  if (!pending) return { applied: false };
  fs.rmSync(path.join(dir, 'pending.json'), { force: true });
  const staging = path.resolve(dir, path.basename(String(pending.dir)));
  const fail = (error: string) => {
    writeJson(path.join(dir, 'failed.json'), { build: pending.build, at: new Date().toISOString(), error });
    fs.rmSync(staging, { recursive: true, force: true });
    log(`update #${pending.build} not applied: ${error}`);
    return { applied: false, build: pending.build, error };
  };
  if (!fs.existsSync(path.join(staging, 'build-info.json')) || !fs.existsSync(path.join(staging, 'dist'))) return fail('staged files incomplete');
  const items = [...UPDATE_ITEMS];
  if (pending.lockChanged) {
    log(`update #${pending.build}: dependencies changed – installing (npm ci --omit=dev)`);
    try {
      const npm = npmCommand(root);
      execFileSync(npm.cmd, [...npm.args, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'pipe', shell: npm.shell, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
    } catch (e) {
      return fail(`dependency install failed: ${String((e as any).stderr ?? (e as Error).message).slice(-500)}`);
    }
    items.push('node_modules');
  }
  const previous = path.join(dir, 'previous');
  fs.rmSync(previous, { recursive: true, force: true });
  fs.mkdirSync(previous, { recursive: true });
  const oldInfo = readJson(path.join(root, 'build-info.json'));
  const moved: string[] = [];
  try {
    for (const item of items) {
      const cur = path.join(root, item);
      const next = path.join(staging, item);
      if (!fs.existsSync(next)) continue;
      if (fs.existsSync(cur)) move(cur, path.join(previous, item));
      moved.push(item);
      move(next, cur);
    }
    // rules.yaml: replace only if the user did not change the shipped version
    const newRules = path.join(staging, 'config', 'rules.yaml');
    const curRules = path.join(root, 'config', 'rules.yaml');
    if (fs.existsSync(newRules)) {
      const untouched = !fs.existsSync(curRules) || (oldInfo?.rulesHash && sha256File(curRules) === oldInfo.rulesHash) || sha256File(curRules) === sha256File(newRules);
      if (untouched) {
        if (fs.existsSync(curRules)) move(curRules, path.join(previous, 'config', 'rules.yaml'));
        move(newRules, curRules);
        moved.push('config/rules.yaml');
      } else {
        fs.copyFileSync(newRules, `${curRules}.new`);
        log('config/rules.yaml was edited locally – kept; the shipped version is in config/rules.yaml.new');
      }
    }
  } catch (e) {
    // put everything back
    for (const item of moved.reverse()) {
      try {
        fs.rmSync(path.join(root, item), { recursive: true, force: true });
        if (fs.existsSync(path.join(previous, item))) move(path.join(previous, item), path.join(root, item));
      } catch {
        /* best effort */
      }
    }
    return fail(`could not replace files: ${(e as Error).message}`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  writeJson(path.join(dir, 'applied.json'), { build: pending.build, fromBuild: pending.fromBuild ?? null, at: new Date().toISOString(), items: moved, stable: false });
  fs.rmSync(path.join(dir, 'failed.json'), { force: true });
  log(`update #${pending.build} applied (${moved.join(', ')})`);
  return { applied: true, build: pending.build };
}

/** Restores the files replaced by the last applied update. */
export function rollbackUpdate(root: string, reason: string, log: Log = () => undefined): boolean {
  const dir = path.join(root, UPDATE_DIR);
  const applied = readJson(path.join(dir, 'applied.json'));
  const previous = path.join(dir, 'previous');
  if (!applied || !fs.existsSync(previous)) {
    log('rollback: nothing to roll back');
    return false;
  }
  for (const item of applied.items as string[]) {
    const saved = path.join(previous, item);
    fs.rmSync(path.join(root, item), { recursive: true, force: true });
    if (fs.existsSync(saved)) move(saved, path.join(root, item));
  }
  fs.rmSync(path.join(dir, 'applied.json'), { force: true });
  writeJson(path.join(dir, 'failed.json'), { build: applied.build, at: new Date().toISOString(), error: `rolled back: ${reason}` });
  log(`update #${applied.build} rolled back (${reason})`);
  return true;
}

export function markUpdateStable(root: string): void {
  const file = path.join(root, UPDATE_DIR, 'applied.json');
  const a = readJson(file);
  if (a && !a.stable) writeJson(file, { ...a, stable: true });
}
