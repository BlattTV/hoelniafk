import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
// @ts-expect-error – plain ESM backend package without type declarations
import { Accounts } from '../backend/src/accounts.mjs';
// @ts-expect-error – see above
import { openDb } from '../backend/src/db.mjs';
// @ts-expect-error – see above
import { Relay } from '../backend/src/relay.mjs';
// @ts-expect-error – see above
import { createBackendServer } from '../backend/src/server.mjs';
import { isPrivateAddress, refuseReason } from '../src/agent/guard.js';
import { requestJson } from '../src/agent/transport.js';
import type { MainToHost } from '../src/runtime/protocol.js';

const spec = (over: Record<string, unknown> = {}, network: unknown = { profile: null, secret: null }) =>
  ({
    sessionId: '1:2', identityId: 1, username: 'Player01', auth: 'offline', lightweight: true, viewDistance: 'tiny',
    afk: { enabled: false, action: 'none', intervalSec: 60 },
    server: { id: 2, name: 'SMP', host: '1.1.1.1', port: 25565, version: '1.20.1', ...over },
    network,
  }) as any;

describe('agent guard (commands from the manager)', () => {
  it('classifies private and public addresses', () => {
    for (const ip of ['10.1.2.3', '192.168.1.1', '172.20.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.2', '224.0.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2a00:1450::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses servers and proxies in the household LAN unless explicitly allowed', async () => {
    const lan = { cmd: 'start', spec: spec({ host: '192.168.178.1' }) } as MainToHost;
    expect(await refuseReason(lan, false)).toMatch(/private address/);
    expect(await refuseReason(lan, true)).toBeNull();
    expect(await refuseReason({ cmd: 'start', spec: spec() } as MainToHost, false)).toBeNull();
    expect(await refuseReason({ cmd: 'start', spec: spec({ host: 'localhost' }) } as MainToHost, false)).toMatch(/private address/);
    const proxy = { cmd: 'start', spec: spec({}, { profile: { kind: 'SOCKS5', proxyHost: '10.0.0.5', proxyPort: 1080 }, secret: null }) } as MainToHost;
    expect(await refuseReason(proxy, false)).toMatch(/Proxy 10\.0\.0\.5/);
    const bind = { cmd: 'start', spec: spec({}, { profile: { kind: 'BIND', localBindIp: '192.168.1.20' }, secret: null }) } as MainToHost;
    expect(await refuseReason(bind, true)).toMatch(/Bind-IP/);
  });

  it('validates identifiers and game settings that end up in paths and launch arguments', async () => {
    expect(await refuseReason({ cmd: 'start', spec: { ...spec(), sessionId: '../../x' } } as MainToHost, true)).toMatch(/session id/);
    expect(await refuseReason({ cmd: 'start', spec: { ...spec(), username: 'a b' } } as MainToHost, true)).toMatch(/username/);
    // Microsoft identities are named by the account e-mail – accepted only for Microsoft sign-in
    expect(await refuseReason({ cmd: 'start', spec: { ...spec(), auth: 'microsoft', username: 'max.mustermann@outlook.de' } } as MainToHost, true)).toBeNull();
    expect(await refuseReason({ cmd: 'start', spec: { ...spec(), auth: 'offline', username: 'max.mustermann@outlook.de' } } as MainToHost, true)).toMatch(/username/);
    expect(await refuseReason({ cmd: 'start', spec: { ...spec(), auth: 'microsoft', username: '../x@y.de' } } as MainToHost, true)).toMatch(/username/);
    expect(await refuseReason({ cmd: 'start', spec: { ...spec(), auth: 'other' } } as unknown as MainToHost, true)).toMatch(/sign-in type/);
    const open = (settings: Record<string, unknown>) =>
      ({ cmd: 'game.open', sessionId: '1:2', spec: spec(), settings: { mode: 'takeover', version: 'auto', loader: 'vanilla', memoryMb: 2048, ...settings }, auth: { username: 'Player01', uuid: '' } }) as MainToHost;
    expect(await refuseReason(open({}), true)).toBeNull();
    expect(await refuseReason(open({ version: '../../../Windows' }), true)).toMatch(/game version/);
    expect(await refuseReason(open({ memoryMb: 999999 }), true)).toMatch(/memory/);
    expect(await refuseReason(open({ loader: 'forge' }), true)).toMatch(/loader/);
    expect(await refuseReason({ cmd: 'stop', sessionId: '1:2; rm', reason: 'x' } as MainToHost, true)).toMatch(/session id/);
  });
});

describe('backend hardening', () => {
  async function backend(trustProxy = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-bk-'));
    const accounts = new Accounts(openDb(path.join(dir, 'b.db')));
    accounts.createUser('niklas', 'admin-password-1', 'admin');
    const quiet = { info: () => undefined, error: () => undefined };
    const relay = new Relay(accounts, quiet);
    const server = createBackendServer({ accounts, relay, config: { trustProxy }, log: quiet });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { url, accounts, close: () => { relay.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it('forged X-Forwarded-For entries do not bypass the sign-in lockout behind a proxy', async () => {
    const b = await backend(true);
    try {
      for (let i = 0; i < 10; i++) {
        await requestJson(`${b.url}/api/login`, 'POST', { username: 'niklas', password: 'wrong', client: 'manager' }, {}, { 'X-Forwarded-For': `6.6.6.${i}, 203.0.113.9` }).catch(() => undefined);
      }
      await expect(
        requestJson(`${b.url}/api/login`, 'POST', { username: 'niklas', password: 'admin-password-1', client: 'manager' }, {}, { 'X-Forwarded-For': '7.7.7.7, 203.0.113.9' }),
      ).rejects.toThrow(/Too many failed sign-ins/);
    } finally {
      b.close();
    }
  });

  it('the relay forwards only runtime commands from the manager to agents', async () => {
    const b = await backend();
    try {
      const login = (client: string) => requestJson<{ token: string; deviceId: number }>(`${b.url}/api/login`, 'POST', { username: 'niklas', password: 'admin-password-1', client, name: client });
      const [mgr, agt] = [await login('manager'), await login('agent')];
      const open = (token: string) => new WebSocket(`${b.url.replace('http', 'ws')}/relay`, { headers: { Authorization: `Bearer ${token}` } });
      const agent = open(agt.token);
      const got: any[] = [];
      agent.on('message', (d) => got.push(JSON.parse(String(d))));
      await new Promise((r) => agent.once('open', r));
      const manager = open(mgr.token);
      await new Promise((r) => manager.once('open', r));
      manager.send(JSON.stringify({ t: 'to', agentId: agt.deviceId, frame: { t: 'bye', reason: 'Access revoked by the admin' } }));
      manager.send(JSON.stringify({ t: 'to', agentId: agt.deviceId, frame: { t: 'host', m: { cmd: 'stop', sessionId: '1:1', reason: 'x' }, extra: 'dropped' } }));
      await new Promise((r) => setTimeout(r, 300));
      expect(got.some((f) => f.t === 'bye')).toBe(false);
      expect(got.filter((f) => f.t === 'host')).toEqual([{ t: 'host', m: { cmd: 'stop', sessionId: '1:1', reason: 'x' } }]);
      agent.close();
      manager.close();
    } finally {
      b.close();
    }
  });

  it('revocations made outside the server process (CLI) disconnect live devices', async () => {
    process.env.HOELNI_RELAY_PING_MS = '150';
    const b = await backend();
    try {
      const r = await requestJson<{ token: string; deviceId: number }>(`${b.url}/api/login`, 'POST', { username: 'niklas', password: 'admin-password-1', client: 'agent', name: 'a' });
      const ws = new WebSocket(`${b.url.replace('http', 'ws')}/relay`, { headers: { Authorization: `Bearer ${r.token}` } });
      const frames: any[] = [];
      ws.on('message', (d) => frames.push(JSON.parse(String(d))));
      const closed = new Promise((res) => ws.once('close', res));
      await new Promise((res) => ws.once('open', res));
      // like "hoelni-backend user passwd niklas" in another process: same DB, no relay call
      b.accounts.updateUser(1, { password: 'new-password-123' });
      await closed;
      expect(frames.find((f) => f.t === 'bye')?.reason).toMatch(/revoked/);
    } finally {
      delete process.env.HOELNI_RELAY_PING_MS;
      b.close();
    }
  });
});
