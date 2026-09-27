import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { KeyProviderName } from './vault/keyProviders.js';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  rulesFile: string;
  vault: { keyProvider: KeyProviderName };
  oauth: {
    microsoft: { clientId: string; tenant: string };
    google: { clientId: string };
    discord: { clientId: string };
  };
  network: { ipEndpoints: string[] };
  mail: { syncLimit: number };
  automation: {
    mailCheckMinutes: number;
    networkCheckMinutes: number;
    discordVerifyHours: number;
    tokenRefreshHours: number;
    /** Start the desired-state reconciler on launch (restores sessions that should be online). */
    restoreSessions: boolean;
  };
  runtime: {
    /** process: supervised child processes (production); inline: in the main process. */
    mode: 'process' | 'inline';
    sessionsPerHost: number;
    grouping: 'identity' | 'pooled';
    heartbeatMs: number;
    heartbeatTimeoutMs: number;
    idleHostTtlMs: number;
  };
  sessions: { reconcileIntervalMs: number; maxConcurrentStarts: number };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; file: boolean; maxFileMb: number; keepFiles: number };
}

export const DEFAULT_CONFIG: AppConfig = {
  host: '127.0.0.1',
  port: 7420,
  dataDir: 'data',
  rulesFile: 'config/rules.yaml',
  vault: { keyProvider: 'auto' },
  oauth: {
    microsoft: { clientId: '', tenant: 'consumers' },
    google: { clientId: '' },
    discord: { clientId: '' },
  },
  network: { ipEndpoints: ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'] },
  mail: { syncLimit: 100 },
  automation: { mailCheckMinutes: 10, networkCheckMinutes: 30, discordVerifyHours: 24, tokenRefreshHours: 12, restoreSessions: true },
  runtime: { mode: 'process', sessionsPerHost: 10, grouping: 'pooled', heartbeatMs: 5000, heartbeatTimeoutMs: 30000, idleHostTtlMs: 60000 },
  sessions: { reconcileIntervalMs: 3000, maxConcurrentStarts: 4 },
  logging: { level: 'info', file: true, maxFileMb: 10, keepFiles: 5 },
};

function deepMerge<T>(base: T, patch: any): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge((base as any)?.[k] ?? {}, v) : v;
  }
  return out;
}

/** Validates a configuration; returns human readable problems (empty = valid). */
export function validateConfig(cfg: AppConfig, raw: unknown = {}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const oneOf = (v: unknown, allowed: readonly string[], name: string) => {
    if (!allowed.includes(String(v))) errors.push(`${name} must be one of ${allowed.join(', ')} (got "${v}")`);
  };
  const intRange = (v: unknown, min: number, max: number, name: string) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) errors.push(`${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(v)})`);
  };
  intRange(cfg.port, 1, 65535, 'port');
  oneOf(cfg.vault?.keyProvider, ['auto', 'dpapi', 'credman', 'passphrase'], 'vault.keyProvider');
  oneOf(cfg.runtime?.mode, ['process', 'inline'], 'runtime.mode');
  oneOf(cfg.runtime?.grouping, ['identity', 'pooled'], 'runtime.grouping');
  intRange(cfg.runtime?.sessionsPerHost, 1, 200, 'runtime.sessionsPerHost');
  intRange(cfg.runtime?.heartbeatTimeoutMs, 5000, 600000, 'runtime.heartbeatTimeoutMs');
  intRange(cfg.sessions?.maxConcurrentStarts, 1, 100, 'sessions.maxConcurrentStarts');
  intRange(cfg.sessions?.reconcileIntervalMs, 250, 600000, 'sessions.reconcileIntervalMs');
  oneOf(cfg.logging?.level, ['debug', 'info', 'warn', 'error'], 'logging.level');
  intRange(cfg.mail?.syncLimit, 1, 5000, 'mail.syncLimit');
  for (const k of ['mailCheckMinutes', 'networkCheckMinutes', 'discordVerifyHours', 'tokenRefreshHours'] as const) {
    const v = cfg.automation?.[k];
    if (typeof v !== 'number' || v < 0) errors.push(`automation.${k} must be a number >= 0`);
  }
  if (!Array.isArray(cfg.network?.ipEndpoints) || !cfg.network.ipEndpoints.every((u) => /^https?:\/\//.test(u))) {
    errors.push('network.ipEndpoints must be a list of http(s) URLs');
  }
  if (cfg.runtime?.mode === 'inline') warnings.push('runtime.mode "inline": a crashing session can take the whole suite down – use "process" in production');
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  if (raw && typeof raw === 'object') for (const k of Object.keys(raw)) if (!known.has(k)) warnings.push(`Unknown configuration key "${k}" (ignored)`);
  return { errors, warnings };
}

/** Loads config/app.yaml (non-secret settings only; secrets go into the vault via the UI). */
export function loadConfig(file = process.env.HOELNI_CONFIG ?? 'config/app.yaml'): AppConfig {
  let cfg = DEFAULT_CONFIG;
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    try {
      raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
    } catch (e) {
      throw new Error(`${file}: invalid YAML – ${(e as Error).message}`);
    }
    cfg = deepMerge(DEFAULT_CONFIG, raw);
  }
  if (process.env.HOELNI_PORT) cfg.port = Number(process.env.HOELNI_PORT);
  if (process.env.HOELNI_DATA_DIR) cfg.dataDir = process.env.HOELNI_DATA_DIR;
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
    throw new Error('For security reasons the suite only listens on the loopback interface (host: 127.0.0.1)');
  }
  const { errors, warnings } = validateConfig(cfg, raw);
  for (const w of warnings) console.warn(`[config] ${w}`);
  if (errors.length) throw new Error(`Invalid configuration (${file}):\n  - ${errors.join('\n  - ')}`);
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.rulesFile = path.resolve(cfg.rulesFile);
  return cfg;
}
