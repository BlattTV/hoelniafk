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

/** Loads config/app.yaml (non-secret settings only; secrets go into the vault via the UI). */
export function loadConfig(file = process.env.HOELNI_CONFIG ?? 'config/app.yaml'): AppConfig {
  let cfg = DEFAULT_CONFIG;
  if (fs.existsSync(file)) cfg = deepMerge(DEFAULT_CONFIG, YAML.parse(fs.readFileSync(file, 'utf8')) ?? {});
  if (process.env.HOELNI_PORT) cfg.port = Number(process.env.HOELNI_PORT);
  if (process.env.HOELNI_DATA_DIR) cfg.dataDir = process.env.HOELNI_DATA_DIR;
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
    throw new Error('For security reasons the suite only listens on the loopback interface (host: 127.0.0.1)');
  }
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.rulesFile = path.resolve(cfg.rulesFile);
  return cfg;
}
