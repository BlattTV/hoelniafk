import type { DB } from './db.js';
import { nowIso } from './db.js';
import type { AuditEntry } from './types.js';
import type { EventBus } from './events.js';
import { redact } from './logger.js';

/**
 * Masks a verification / link code so only a hint remains: "ABC123" -> "AB****".
 * Full codes must never be written to the audit log.
 */
export function maskCode(code: string): string {
  const c = code.trim();
  if (c.length <= 2) return '*'.repeat(c.length);
  const keep = c.length >= 6 ? 2 : 1;
  return c.slice(0, keep) + '*'.repeat(c.length - keep);
}

const FORBIDDEN_KEYS = /(token|password|passwd|secret|refresh|credential|cookie|code)$/i;

/**
 * Security-relevant action log. Details are sanitised:
 *  - structured detail objects must not contain secret-ish keys (throws in that case)
 *  - free text passes through the redacting filter
 */
export class AuditLog {
  constructor(
    private readonly db: DB,
    private readonly bus?: EventBus,
  ) {}

  record(identityId: number | null, action: string, detail: string | Record<string, string | number | boolean | null> = ''): AuditEntry {
    let text: string;
    if (typeof detail === 'string') {
      text = detail;
    } else {
      for (const key of Object.keys(detail)) {
        if (FORBIDDEN_KEYS.test(key)) {
          throw new Error(`Audit detail key "${key}" is not allowed (secrets must never be audited)`);
        }
      }
      text = Object.entries(detail)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
    }
    text = redact(text);
    const ts = nowIso();
    const info = this.db
      .prepare('INSERT INTO audit_log (ts, identity_id, action, detail) VALUES (?, ?, ?, ?)')
      .run(ts, identityId, action, text);
    const entry: AuditEntry = { id: Number(info.lastInsertRowid), ts, identityId, action, detail: text };
    this.bus?.emit({ type: 'audit', identityId, data: entry });
    return entry;
  }

  list(opts: { identityId?: number; limit?: number; before?: number } = {}): AuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.identityId !== undefined) {
      where.push('identity_id = ?');
      params.push(opts.identityId);
    }
    if (opts.before !== undefined) {
      where.push('id < ?');
      params.push(opts.before);
    }
    const sql = `SELECT id, ts, identity_id AS identityId, action, detail FROM audit_log ${
      where.length ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY id DESC LIMIT ?`;
    params.push(Math.min(opts.limit ?? 200, 1000));
    return this.db.prepare(sql).all(...params) as AuditEntry[];
  }
}
