/**
 * Applies / rolls back agent updates while the agent is NOT running (called by the agent app).
 * Only Node built-ins and updateApply – nothing that the update replaces is kept open.
 *
 *   node dist/agent/update.js apply              staged update → installed (prints JSON)
 *   node dist/agent/update.js rollback <reason>  restore the previous version
 *   node dist/agent/update.js stable             the new version runs – keep it
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPendingUpdate, hasPendingUpdate, markUpdateStable, rollbackUpdate } from '../ops/updateApply.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lines: string[] = [];
const log = (m: string) => lines.push(m);
const [cmd, ...rest] = process.argv.slice(2);

let result: Record<string, unknown>;
if (cmd === 'apply') result = hasPendingUpdate(root) ? applyPendingUpdate(root, log) : { applied: false };
else if (cmd === 'rollback') result = { rolledBack: rollbackUpdate(root, rest.join(' ') || 'the new version did not start', log) };
else if (cmd === 'stable') {
  markUpdateStable(root);
  result = { ok: true };
} else {
  console.log(JSON.stringify({ ok: false, error: 'usage: update.js apply | rollback <reason> | stable' }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, ...result, log: lines }));
