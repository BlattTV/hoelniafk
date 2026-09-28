/**
 * Process supervisor for long-running operation.
 *
 *   npm start  →  supervisor  →  suite (dist/index.js)
 *
 * - restarts the suite after a crash with exponential backoff (1 s … 60 s),
 *   the backoff resets after 5 minutes of stable uptime
 * - forwards SIGINT/SIGTERM so the suite can shut down cleanly (sessions keep
 *   their desired state and are restored on the next start)
 * - graceful stop via IPC ({ cmd: 'shutdown' }) – signals are hard kills on Windows,
 *   so the desktop app and the supervisor use the IPC channel there
 * - exit code 0 of the child ends the supervisor
 * - updates (with `updateRoot`): exit code 75 = "restart for update" → the staged update is
 *   applied while the suite is down, then it starts again; if the new version exits with an
 *   error within `updateProbationMs`, the previous version is restored automatically
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPendingUpdate, hasPendingUpdate, markUpdateStable, RESTART_FOR_UPDATE, rollbackUpdate } from './ops/updateApply.js';

export interface SupervisorOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  stableAfterMs?: number;
  log?: (msg: string) => void;
  /** Installation root: enables applying staged updates and automatic rollback. */
  updateRoot?: string;
  updateProbationMs?: number;
}

export interface Supervisor {
  stop(signal?: NodeJS.Signals): Promise<void>;
  readonly restarts: number;
  readonly child: ChildProcess | null;
  done: Promise<number>;
}

export function supervise(opts: SupervisorOptions): Supervisor {
  const log = opts.log ?? ((m: string) => console.log(`${new Date().toISOString()} [supervisor] ${m}`));
  const minB = opts.minBackoffMs ?? 1000;
  const maxB = opts.maxBackoffMs ?? 60_000;
  const stableAfter = opts.stableAfterMs ?? 5 * 60_000;
  let child: ChildProcess | null = null;
  let restarts = 0;
  let backoff = minB;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));

  const probation = opts.updateProbationMs ?? 120_000;
  let justUpdated = false;
  let probationTimer: NodeJS.Timeout | null = null;

  const start = () => {
    if (opts.updateRoot && hasPendingUpdate(opts.updateRoot)) {
      try {
        justUpdated = applyPendingUpdate(opts.updateRoot, log).applied;
      } catch (e) {
        log(`applying the update failed: ${(e as Error).message}`);
      }
    }
    const startedAt = Date.now();
    if (justUpdated && opts.updateRoot) {
      const root = opts.updateRoot;
      probationTimer = setTimeout(() => {
        justUpdated = false;
        markUpdateStable(root);
        log('updated version is stable');
      }, probation);
    }
    child = spawn(opts.command, opts.args, { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...process.env, ...opts.env, HOELNI_SUPERVISED: '1' } });
    log(`started suite (pid ${child.pid})`);
    child.on('exit', (code, signal) => {
      child = null;
      if (probationTimer) clearTimeout(probationTimer);
      probationTimer = null;
      if (!stopping && code === RESTART_FOR_UPDATE) {
        log('suite exited to install an update – restarting');
        justUpdated = false;
        start();
        return;
      }
      if (!stopping && justUpdated && opts.updateRoot && code !== 0) {
        justUpdated = false;
        log(`updated suite exited with code ${code} during probation – restoring the previous version`);
        rollbackUpdate(opts.updateRoot, `exit code ${code} within ${Math.round(probation / 1000)} s after the update`, log);
        timer = setTimeout(start, minB);
        return;
      }
      justUpdated = false;
      if (stopping || code === 0) {
        log(`suite exited (code ${code}, signal ${signal})`);
        resolveDone(code ?? 0);
        return;
      }
      if (Date.now() - startedAt > stableAfter) backoff = minB;
      restarts++;
      log(`suite crashed (code ${code}, signal ${signal}) – restart #${restarts} in ${Math.round(backoff / 1000)}s`);
      timer = setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, maxB);
    });
  };
  start();

  return {
    get restarts() {
      return restarts;
    },
    get child() {
      return child;
    },
    done,
    stop: async (signal: NodeJS.Signals = 'SIGTERM') => {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (!child) {
        resolveDone(0);
        return;
      }
      const c = child;
      const killTimer = setTimeout(() => c.kill('SIGKILL'), 20_000);
      if (c.connected) c.send({ cmd: 'shutdown' });
      // On Windows a signal is a hard kill – only the IPC request is graceful there.
      if (process.platform !== 'win32' || !c.connected) c.kill(signal);
      await done;
      clearTimeout(killTimer);
    },
  };
}

// ---------------------------------------------------------------- CLI entry
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = fs.existsSync(path.join(here, 'index.js')) ? path.join(here, 'index.js') : path.join(here, 'index.ts');
  const args = entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry];
  const sup = supervise({ command: process.execPath, args, updateRoot: path.resolve(here, '..') });
  const onSignal = (sig: NodeJS.Signals) => {
    sup.stop(sig).then(() => process.exit(0));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  // Desktop app (or any parent with an IPC channel): graceful stop on request.
  process.on('message', (m: any) => {
    if (m?.cmd === 'shutdown') onSignal('SIGTERM');
  });
  process.on('disconnect', () => onSignal('SIGTERM'));
  sup.done.then((code) => process.exit(code));
}
