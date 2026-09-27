/**
 * Structured, redacting logger.
 *
 *  - Every entry is { ts, level, scope, msg, identityId?, sessionId? }.
 *  - Sinks: console (human readable), JSON-lines file with size rotation,
 *    and an in-memory ring buffer for the Logs page of the UI.
 *  - Credentials, tokens and codes never reach any sink: secrets that pass
 *    through the vault are registered and replaced by [REDACTED], and generic
 *    patterns (JWTs, bearer tokens, key=value secrets) are masked as well.
 */
import fs from 'node:fs';
import path from 'node:path';

const registeredSecrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (!value || value.length < 6) return;
  registeredSecrets.add(value);
}

export function forgetSecret(value: string): void {
  registeredSecrets.delete(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  // JWT-like tokens
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  // Authorization headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // key=value / key: value / "key":"value" with sensitive key names
  [
    // values shorter than 6 characters (e.g. "exit code=1") are not treated as secrets
    /(["']?(?:password|passwd|pass|secret|token|access_token|refresh_token|id_token|client_secret|authorization|code|apikey|api_key)["']?\s*[:=]\s*)(["']?)[^"'\s,&}]{6,}\2/gi,
    '$1$2[REDACTED]$2',
  ],
];

export function redact(input: string): string {
  let out = input;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  id: number;
  ts: string;
  level: Level;
  scope: string;
  msg: string;
  identityId?: number;
  sessionId?: string;
}

export interface LogContext {
  identityId?: number;
  sessionId?: string;
}

// ---------------------------------------------------------------- sinks

export type LogSink = (line: string, level: Level, entry: LogEntry) => void;

let consoleSink: LogSink = (line, level) => {
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};
let minLevel: Level = (process.env.HOELNI_LOG_LEVEL as Level) || 'info';
const listeners = new Set<(e: LogEntry) => void>();

const RING_SIZE = 3000;
const ring: LogEntry[] = [];
let seq = 1;

interface FileSink {
  file: string;
  maxBytes: number;
  keep: number;
  size: number;
  fd: number;
}
let fileSink: FileSink | null = null;

export function setLogSink(s: LogSink): void {
  consoleSink = s;
}

export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** Writes JSON lines to `<dir>/hoelni.log`, rotating at `maxMb` and keeping `keep` old files. */
export function setupFileLogging(dir: string, maxMb = 10, keep = 5): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hoelni.log');
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (fileSink) fs.closeSync(fileSink.fd);
  fileSink = { file, maxBytes: maxMb * 1024 * 1024, keep, size, fd: fs.openSync(file, 'a', 0o600) };
}

export function closeFileLogging(): void {
  if (fileSink) fs.closeSync(fileSink.fd);
  fileSink = null;
}

function rotate(fsink: FileSink): void {
  fs.closeSync(fsink.fd);
  for (let i = fsink.keep - 1; i >= 1; i--) {
    const from = `${fsink.file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${fsink.file}.${i + 1}`);
  }
  fs.renameSync(fsink.file, `${fsink.file}.1`);
  const tooOld = `${fsink.file}.${fsink.keep + 1}`;
  if (fs.existsSync(tooOld)) fs.unlinkSync(tooOld);
  fsink.fd = fs.openSync(fsink.file, 'a', 0o600);
  fsink.size = 0;
}

export function onLogEntry(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentLogs(filter: { level?: Level; scope?: string; q?: string; sessionId?: string; identityId?: number; limit?: number; before?: number } = {}): LogEntry[] {
  const min = LEVELS[filter.level ?? 'debug'];
  const q = filter.q?.toLowerCase();
  const out: LogEntry[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < (filter.limit ?? 300); i--) {
    const e = ring[i];
    if (filter.before && e.id >= filter.before) continue;
    if (LEVELS[e.level] < min) continue;
    if (filter.scope && e.scope !== filter.scope) continue;
    if (filter.sessionId && e.sessionId !== filter.sessionId) continue;
    if (filter.identityId !== undefined && e.identityId !== filter.identityId) continue;
    if (q && !e.msg.toLowerCase().includes(q) && !e.scope.includes(q)) continue;
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------- writing

function fmt(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level: Level, scope: string, ctx: LogContext, parts: unknown[]): void {
  const msg = redact(parts.map(fmt).join(' '));
  const entry: LogEntry = { id: seq++, ts: new Date().toISOString(), level, scope, msg, ...ctx };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  if (LEVELS[level] >= LEVELS[minLevel]) {
    const human = `${entry.ts} ${level.toUpperCase().padEnd(5)} [${scope}${ctx.sessionId ? ` ${ctx.sessionId}` : ''}] ${msg}`;
    consoleSink(human, level, entry);
    if (fileSink) {
      const line = JSON.stringify(entry) + '\n';
      try {
        fs.writeSync(fileSink.fd, line);
        fileSink.size += Buffer.byteLength(line);
        if (fileSink.size > fileSink.maxBytes) rotate(fileSink);
      } catch {
        /* never let logging crash the app */
      }
    }
  }
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      /* ignore */
    }
  }
}

export function createLogger(scope: string, ctx: LogContext = {}) {
  return {
    debug: (...p: unknown[]) => write('debug', scope, ctx, p),
    info: (...p: unknown[]) => write('info', scope, ctx, p),
    warn: (...p: unknown[]) => write('warn', scope, ctx, p),
    error: (...p: unknown[]) => write('error', scope, ctx, p),
    with: (extra: LogContext) => createLogger(scope, { ...ctx, ...extra }),
  };
}

export type Logger = ReturnType<typeof createLogger>;
