import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeFileLogging, createLogger, recentLogs, registerSecret, setLogSink, setupFileLogging } from '../src/core/logger.js';

afterEach(() => closeFileLogging());

describe('structured logging', () => {
  it('writes redacted JSON lines with context and rotates by size', () => {
    setLogSink(() => undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-log-'));
    setupFileLogging(dir, 0.001, 2); // ~1 KB per file
    registerSecret('my-super-secret-token');
    const log = createLogger('test').with({ identityId: 7, sessionId: '7:1' });
    for (let i = 0; i < 40; i++) log.info(`line ${i} token=abc123456 my-super-secret-token`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['hoelni.log', 'hoelni.log.1', 'hoelni.log.2']);
    const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    expect(all).not.toContain('my-super-secret-token');
    expect(all).not.toContain('abc123456');
    const lines = all.split('\n').filter(Boolean);
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry).toMatchObject({ level: 'info', scope: 'test', identityId: 7, sessionId: '7:1' });
  });

  it('keeps a filterable in-memory buffer for the UI', () => {
    setLogSink(() => undefined);
    const a = createLogger('alpha').with({ sessionId: 'A' });
    const b = createLogger('beta');
    a.warn('careful');
    b.error('broken thing');
    b.debug('noise');
    expect(recentLogs({ level: 'warn', limit: 10 }).slice(0, 2).map((e) => e.msg)).toEqual(['broken thing', 'careful']);
    expect(recentLogs({ sessionId: 'A', limit: 5 })[0].msg).toBe('careful');
    expect(recentLogs({ q: 'broken', limit: 5 })[0].scope).toBe('beta');
  });
});

describe('redaction precision', () => {
  it('does not mangle harmless short values', async () => {
    const { redact } = await import('../src/core/logger.js');
    expect(redact('Runtime host exited (exit code=1 signal=null)')).toContain('code=1');
    expect(redact('password: hunter22')).not.toContain('hunter22');
  });
});
