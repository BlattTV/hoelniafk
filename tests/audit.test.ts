import { describe, expect, it } from 'vitest';
import { maskCode } from '../src/core/audit.js';
import { createLogger, redact, setLogSink } from '../src/core/logger.js';
import { createTestSuite } from './helpers.js';

describe('audit log', () => {
  it('masks codes', () => {
    expect(maskCode('ABC123')).toBe('AB****');
    expect(maskCode('4829')).toBe('4***');
  });

  it('rejects secret-looking detail keys', async () => {
    const { suite } = await createTestSuite();
    expect(() => suite.audit.record(1, 'x', { refreshToken: 'abc' })).toThrow();
    expect(() => suite.audit.record(1, 'x', { password: 'abc' })).toThrow();
    expect(() => suite.audit.record(1, 'x', { verificationCode: 'abc' })).toThrow();
  });

  it('never contains full link codes or tokens', async () => {
    const { suite, bots } = await createTestSuite();
    const id = suite.identities.create({ label: 'Identity07' }).identity.id;
    const server = suite.repo.upsertServer({ name: 'SMP', host: 'smp.example.com' });
    suite.repo.upsertMinecraft(id, { username: 'Player07', authType: 'microsoft', msaAccount: 'acc07@example.com' });
    await suite.auth.authenticate(id);
    suite.repo.assignServer(id, { serverId: server.id });
    await suite.sessions.start(id, server.id);
    bots[0].join();
    bots[0].say('Link your account using code XYZ789');
    bots[0].say('Discord linked successfully');
    const text = suite.audit.list().map((e) => `${e.action} ${e.detail}`).join('\n');
    expect(text).toContain('Discord linked');
    expect(text).toContain('XY****');
    expect(text).not.toContain('XYZ789');
    expect(text).not.toContain('mc-token');
  });

  it('redacts free-text secrets', async () => {
    const { suite } = await createTestSuite();
    const e = suite.audit.record(null, 'debug', 'refresh_token=abcdefghijkl password: hunter22 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
    expect(e.detail).not.toContain('abcdefghijkl');
    expect(e.detail).not.toContain('hunter22');
    expect(e.detail).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

describe('logger', () => {
  it('redacts tokens and registered secrets', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    const log = createLogger('t');
    log.info('connecting with {"access_token":"abc.def.ghi-123456","user":"x"}');
    log.warn('Authorization: Bearer abcdefghijklmnop');
    expect(lines.join('\n')).not.toContain('abc.def.ghi-123456');
    expect(lines.join('\n')).not.toContain('abcdefghijklmnop');
    expect(redact('?code=SECRETCODE1&state=1')).not.toContain('SECRETCODE1');
  });
});
