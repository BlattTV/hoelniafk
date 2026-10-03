'use strict';
/**
 * Hoelni Agent for Linux – runs the agent as a service (systemd: hoelni-agent.service) without a window.
 * Same job as the Windows agent app: install a staged update while the agent is NOT running, start the
 * agent, restart it after an update (exit code 75) or a crash, and go back to the previous version if a
 * new one does not keep running for 2 minutes. Output goes to the journal (journalctl -u hoelni-agent).
 *
 * Only Node built-ins: this file is replaced by updates too, the running copy stays valid.
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const node = fs.existsSync(path.join(root, 'node', 'bin', 'node')) ? path.join(root, 'node', 'bin', 'node') : process.execPath;
const RESTART_FOR_UPDATE = 75;
const NOT_SIGNED_IN = 3;
const PROBATION_MS = 120_000;

let child = null;
let stopping = false;
let delay = 2000;
let probation = null;
let notSignedInSince = 0;

const log = (m) => console.log(`${new Date().toISOString()} [service] ${m}`);

function update(args) {
  const script = path.join(root, 'dist', 'agent', 'update.js');
  if (!fs.existsSync(script)) return null;
  try {
    const out = execFileSync(node, [script, ...args], { cwd: root, timeout: 10 * 60_000, env: process.env }).toString();
    const r = JSON.parse(out.trim().split('\n').pop());
    for (const l of r.log ?? []) log(`update: ${l}`);
    return r;
  } catch (e) {
    log(`update ${args[0]} failed: ${e.message}`);
    return null;
  }
}

function start() {
  if (stopping) return;
  const r = update(['apply']);
  if (r && r.applied) {
    for (const f of ['agent-linux/hoelni-agent', 'agent-linux/install.sh', 'agent-linux/uninstall.sh']) {
      try {
        fs.chmodSync(path.join(root, f), 0o755);
      } catch {
        /* not part of this update */
      }
    }
    log(`update installed (build ${r.build}) – watching the new version for 2 minutes`);
    if (probation) clearTimeout(probation.timer);
    const timer = setTimeout(() => {
      probation = null;
      update(['stable']);
    }, PROBATION_MS);
    probation = { until: Date.now() + PROBATION_MS, timer };
  }
  child = spawn(node, [path.join(root, 'dist', 'agent', 'main.js'), 'run'], { cwd: root, stdio: 'inherit', env: process.env });
  const startedAt = Date.now();
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (code === RESTART_FOR_UPDATE) {
      log('restarting into the update');
      delay = 2000;
      return setTimeout(start, 500);
    }
    if (probation && Date.now() < probation.until && code !== 0 && code !== NOT_SIGNED_IN) {
      clearTimeout(probation.timer);
      probation = null;
      const rb = update(['rollback', `exit code ${code} right after the update`]);
      if (rb && rb.rolledBack) log('the new version did not run – the previous one is active again');
    }
    if (code === NOT_SIGNED_IN) {
      if (!notSignedInSince) {
        notSignedInSince = Date.now();
        log('not signed in – run: sudo hoelni-agent login --user NAME   (checking again every 30 s)');
      }
      return setTimeout(start, 30_000);
    }
    notSignedInSince = 0;
    if (Date.now() - startedAt > 60_000) delay = 2000;
    log(`agent ended (${signal ?? `code ${code}`}) – starting again in ${Math.round(delay / 1000)} s`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 60_000);
  });
}

function stop() {
  stopping = true;
  if (!child) return process.exit(0);
  child.kill('SIGTERM'); // the agent stops its sessions cleanly
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
start();
