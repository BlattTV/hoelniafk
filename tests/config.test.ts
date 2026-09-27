import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, validateConfig } from '../src/config.js';

describe('configuration validation', () => {
  it('accepts the defaults and the shipped example', () => {
    expect(validateConfig(DEFAULT_CONFIG).errors).toEqual([]);
    const cfg = loadConfig(path.resolve('config/app.example.yaml'));
    expect(cfg.runtime.mode).toBe('process');
    expect(cfg.port).toBe(7420);
  });

  it('reports wrong values with the key name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-cfg-'));
    const file = path.join(dir, 'app.yaml');
    fs.writeFileSync(file, 'port: 99999\nruntime:\n  mode: threads\n  sessionsPerHost: 0\nlogging:\n  level: loud\nfoo: 1\n');
    expect(() => loadConfig(file)).toThrow(/port must be.*\n.*runtime.mode must be one of process, inline.*\n.*runtime.sessionsPerHost.*\n.*logging.level/s);
    fs.writeFileSync(file, 'port: [unclosed');
    expect(() => loadConfig(file)).toThrow(/invalid YAML/);
  });

  it('refuses to listen on non-loopback interfaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-cfg-'));
    const file = path.join(dir, 'app.yaml');
    fs.writeFileSync(file, 'host: 0.0.0.0\n');
    expect(() => loadConfig(file)).toThrow(/loopback/);
  });
});
