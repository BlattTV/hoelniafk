/**
 * Process supervisor for long-running operation.
 *
 *   npm start  →  supervisor  →  suite (dist/index.js)
 *
 * - restarts the suite after a crash with exponential backoff (1 s … 60 s),
 *   the backoff resets after 5 minutes of stable uptime
 * - forwards SIGINT/SIGTERM so the suite can shut down cleanly (sessions keep
 *   their desired state and are restored on the next start)
 * - exit code 0 of the child ends the supervisor
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SupervisorOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  stableAfterMs?: number;
  log?: (msg: string) => void;
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

  const start = () => {
    const startedAt = Date.now();
    child = spawn(opts.command, opts.args, { stdio: 'inherit', env: { ...process.env, ...opts.env, HOELNI_SUPERVISED: '1' } });
    log(`started suite (pid ${child.pid})`);
    child.on('exit', (code, signal) => {
      child = null;
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
      c.kill(signal);
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
  const sup = supervise({ command: process.execPath, args });
  const onSignal = (sig: NodeJS.Signals) => {
    sup.stop(sig).then(() => process.exit(0));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  sup.done.then((code) => process.exit(code));
}
