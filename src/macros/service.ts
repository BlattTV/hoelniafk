/**
 * Macro builder storage + distribution: macros live in SQLite (no secrets in them), each session
 * gets the macros that apply to its identity/server – at start and live when a macro changes.
 */
import type { DB } from '../core/db.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import type { MinecraftRuntime } from '../runtime/types.js';
import { assertLoopsTakeTime, validateBlocks, validateTrigger, type MacroDefinition, type MacroProgram } from './types.js';

export interface MacroRunEntry {
  ts: string;
  sessionId: string;
  macroId: number;
  status: string;
  message?: string;
}

const ids = (v: unknown, name: string): number[] | null => {
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return null;
  if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || x <= 0)) throw new ValidationError(`${name} must be a list of ids or empty (= all)`);
  return [...new Set(v as number[])];
};

export class MacroService {
  private readonly log: MacroRunEntry[] = [];
  /** sessions currently running: sessionId → identity/server (maintained by the session manager) */
  runningSessions: () => Array<{ sessionId: string; identityId: number; serverId: number }> = () => [];

  constructor(
    private readonly db: DB,
    private readonly runtime: MinecraftRuntime,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {
    runtime.onEvent((e) => {
      if (e.type !== 'macro') return;
      this.log.push({ ts: new Date().toISOString(), sessionId: e.sessionId, macroId: e.macroId, status: e.status, message: e.message?.slice(0, 300) });
      if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
      this.bus.emit({ type: 'macro', data: { sessionId: e.sessionId, macroId: e.macroId, status: e.status, message: e.message } });
    });
  }

  private map(r: any): MacroDefinition {
    return {
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      trigger: JSON.parse(r.trigger_json),
      blocks: JSON.parse(r.blocks_json),
      humanize: !!r.humanize,
      identityIds: r.identity_ids ? JSON.parse(r.identity_ids) : null,
      serverIds: r.server_ids ? JSON.parse(r.server_ids) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): MacroDefinition[] {
    return (this.db.prepare('SELECT * FROM macros ORDER BY name').all() as any[]).map((r) => this.map(r));
  }

  get(id: number): MacroDefinition {
    const r = this.db.prepare('SELECT * FROM macros WHERE id = ?').get(id);
    if (!r) throw new NotFoundError(`Macro ${id} not found`);
    return this.map(r);
  }

  private normalize(input: any): Omit<MacroDefinition, 'id'> {
    const name = String(input?.name ?? '').trim();
    if (!name || name.length > 80) throw new ValidationError('Macro name: 1–80 characters');
    const blocks = validateBlocks(input?.blocks ?? []);
    assertLoopsTakeTime(blocks);
    return {
      name,
      enabled: input?.enabled !== false,
      trigger: validateTrigger(input?.trigger ?? { type: 'manual' }),
      blocks,
      humanize: input?.humanize !== false,
      identityIds: ids(input?.identityIds, 'identityIds'),
      serverIds: ids(input?.serverIds, 'serverIds'),
    };
  }

  save(input: any, id?: number): MacroDefinition {
    const m = this.normalize(input);
    const now = new Date().toISOString();
    const row = [m.name, m.enabled ? 1 : 0, JSON.stringify(m.trigger), JSON.stringify(m.blocks), m.humanize ? 1 : 0, m.identityIds ? JSON.stringify(m.identityIds) : null, m.serverIds ? JSON.stringify(m.serverIds) : null];
    let saved: MacroDefinition;
    if (id) {
      this.get(id);
      this.db.prepare('UPDATE macros SET name=?, enabled=?, trigger_json=?, blocks_json=?, humanize=?, identity_ids=?, server_ids=?, updated_at=? WHERE id=?').run(...row, now, id);
      saved = this.get(id);
      this.audit.record(null, 'Macro changed', { macro: saved.name });
    } else {
      const r = this.db.prepare('INSERT INTO macros (name, enabled, trigger_json, blocks_json, humanize, identity_ids, server_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...row, now, now);
      saved = this.get(Number(r.lastInsertRowid));
      this.audit.record(null, 'Macro created', { macro: saved.name });
    }
    this.pushToSessions();
    return saved;
  }

  remove(id: number): void {
    const m = this.get(id);
    this.db.prepare('DELETE FROM macros WHERE id = ?').run(id);
    this.audit.record(null, 'Macro deleted', { macro: m.name });
    this.pushToSessions();
  }

  /** Macros that apply to one session (enabled, scope matches). */
  forSession(identityId: number, serverId: number): MacroProgram[] {
    return this.list()
      .filter((m) => m.enabled && (!m.identityIds || m.identityIds.includes(identityId)) && (!m.serverIds || m.serverIds.includes(serverId)))
      .map(({ id, name, trigger, blocks, humanize }) => ({ id, name, trigger, blocks, humanize }));
  }

  /** Live update of all running sessions after a change. */
  pushToSessions(): void {
    for (const s of this.runningSessions()) this.runtime.macroCommand?.({ cmd: 'macros.set', sessionId: s.sessionId, macros: this.forSession(s.identityId, s.serverId) });
  }

  run(macroId: number, sessionId: string): void {
    const m = this.get(macroId);
    const s = this.runningSessions().find((x) => x.sessionId === sessionId);
    if (!s) throw new ValidationError('The session is not online');
    if (!this.forSession(s.identityId, s.serverId).some((p) => p.id === macroId)) throw new ValidationError(`"${m.name}" does not apply to this session (disabled or other identity/server)`);
    if (!this.runtime.macroCommand?.({ cmd: 'macro.run', sessionId, macroId })) throw new ValidationError('The session is not online');
  }

  /** Runs the macro on every online session it applies to (its identities × servers). Returns the session ids. */
  runAll(macroId: number): string[] {
    const m = this.get(macroId);
    const started: string[] = [];
    for (const s of this.runningSessions()) {
      if (!this.forSession(s.identityId, s.serverId).some((p) => p.id === macroId)) continue;
      if (this.runtime.macroCommand?.({ cmd: 'macro.run', sessionId: s.sessionId, macroId })) started.push(s.sessionId);
    }
    if (!started.length) throw new ValidationError(`"${m.name}" applies to no online session (check active, identities and servers)`);
    return started;
  }

  stopAll(macroId: number): void {
    for (const s of this.runningSessions()) this.runtime.macroCommand?.({ cmd: 'macro.stop', sessionId: s.sessionId, macroId });
  }

  stop(macroId: number, sessionId: string): void {
    this.runtime.macroCommand?.({ cmd: 'macro.stop', sessionId, macroId });
  }

  recent(limit = 100): MacroRunEntry[] {
    return this.log.slice(-limit).reverse();
  }
}
