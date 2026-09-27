/**
 * Redacting logger. Credentials, tokens and codes must never reach log output.
 *
 * Two layers of protection:
 *  1. Every secret value that passes through the vault is registered here and
 *     replaced by `[REDACTED]` wherever it appears.
 *  2. Generic patterns (JWTs, bearer tokens, key=value pairs with secret-ish
 *     key names) are masked even if they were never registered.
 */

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
    /(["']?(?:password|passwd|pass|secret|token|access_token|refresh_token|id_token|client_secret|authorization|code|apikey|api_key)["']?\s*[:=]\s*)(["']?)[^"'\s,&}]+\2/gi,
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

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  (line: string, level: Level): void;
}

let sink: LogSink = (line, level) => {
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};
let minLevel: Level = (process.env.HOELNI_LOG_LEVEL as Level) || 'info';

export function setLogSink(s: LogSink): void {
  sink = s;
}

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function fmt(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level: Level, scope: string, parts: unknown[]): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${parts.map(fmt).join(' ')}`;
  sink(redact(line), level);
}

export function createLogger(scope: string) {
  return {
    debug: (...p: unknown[]) => write('debug', scope, p),
    info: (...p: unknown[]) => write('info', scope, p),
    warn: (...p: unknown[]) => write('warn', scope, p),
    error: (...p: unknown[]) => write('error', scope, p),
  };
}

export type Logger = ReturnType<typeof createLogger>;
