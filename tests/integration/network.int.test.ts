/**
 * LOCAL INTEGRATION: source-IP binding, proxies and exit-IP verification with
 * real sockets. Each "exit" is simulated by a different loopback source address
 * (127.0.0.x, Linux): an IP echo server reports the address it sees, exactly like
 * a public "what is my IP" service would report the VPN/VPS exit address.
 */
import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectPublicIp } from '../../src/network/publicIp.js';
import { openSocket } from '../../src/network/connector.js';
import type { NetworkProfile } from '../../src/core/types.js';
import { createTestSuite, settle } from '../helpers.js';

const linux = process.platform === 'linux';
const d = linux ? describe : describe.skip;

const echo = { server: null as http.Server | null, port: 0 };
const tcpEcho = { server: null as net.Server | null, port: 0, seen: [] as string[] };
const socks = { server: null as net.Server | null, port: 0, auths: [] as string[] };
const httpProxy = { server: null as http.Server | null, port: 0, auths: [] as string[] };

const clean = (a?: string) => (a ?? '').replace(/^::ffff:/, '');

function profile(p: Partial<NetworkProfile>): NetworkProfile {
  return {
    id: 1, identityId: 1, name: 'p', kind: 'DIRECT', localBindIp: null, proxyHost: null, proxyPort: null, proxyUsername: null,
    credentialRef: null, expectedPublicIp: null, actualPublicIp: null, exitLabel: null, checkStatus: 'UNKNOWN', lastCheckedAt: null, lastError: null, ...p,
  };
}

/** Minimal SOCKS5 server (RFC 1928/1929) that leaves via 127.0.0.4. */
function startSocks(): Promise<void> {
  return new Promise((resolve) => {
    socks.server = net.createServer((c) => {
      c.once('data', (greet) => {
        if (greet[0] !== 5) return c.destroy();
        c.write(Buffer.from([5, 2])); // username/password
        c.once('data', (auth) => {
          const ulen = auth[1];
          const user = auth.subarray(2, 2 + ulen).toString();
          const plen = auth[2 + ulen];
          const pass = auth.subarray(3 + ulen, 3 + ulen + plen).toString();
          socks.auths.push(`${user}:${pass}`);
          if (pass !== 'socks-secret') {
            c.end(Buffer.from([1, 1]));
            return;
          }
          c.write(Buffer.from([1, 0]));
          c.once('data', (req) => {
            let host: string;
            let off: number;
            if (req[3] === 1) {
              host = [...req.subarray(4, 8)].join('.');
              off = 8;
            } else {
              const len = req[4];
              host = req.subarray(5, 5 + len).toString();
              off = 5 + len;
            }
            const port = req.readUInt16BE(off);
            const out = net.connect({ host, port, localAddress: '127.0.0.4' }, () => {
              c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
              c.pipe(out).pipe(c);
            });
            out.on('error', () => c.destroy());
          });
        });
      });
      c.on('error', () => undefined);
    });
    socks.server.listen(0, '127.0.0.1', () => {
      socks.port = (socks.server!.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

/** HTTP CONNECT proxy with Basic auth that leaves via 127.0.0.5. */
function startHttpProxy(): Promise<void> {
  return new Promise((resolve) => {
    httpProxy.server = http.createServer((_req, res) => res.writeHead(405).end());
    httpProxy.server.on('connect', (req, client, head) => {
      const auth = String(req.headers['proxy-authorization'] ?? '');
      httpProxy.auths.push(auth ? Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString() : '');
      if (!auth.endsWith(Buffer.from('bob:http-secret').toString('base64'))) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const [host, port] = String(req.url).split(':');
      const out = net.connect({ host, port: Number(port), localAddress: '127.0.0.5' }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) out.write(head);
        out.pipe(client).pipe(out);
      });
      out.on('error', () => client.destroy());
      client.on('error', () => out.destroy());
    });
    httpProxy.server.listen(0, '127.0.0.1', () => {
      httpProxy.port = (httpProxy.server!.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

beforeAll(async () => {
  if (!linux) return;
  echo.server = http.createServer((req, res) => res.end(clean(req.socket.remoteAddress)));
  await new Promise<void>((r) => echo.server!.listen(0, '127.0.0.1', () => r()));
  echo.port = (echo.server!.address() as net.AddressInfo).port;
  tcpEcho.server = net.createServer((c) => {
    tcpEcho.seen.push(clean(c.remoteAddress));
    c.end();
  });
  await new Promise<void>((r) => tcpEcho.server!.listen(0, '127.0.0.1', () => r()));
  tcpEcho.port = (tcpEcho.server!.address() as net.AddressInfo).port;
  await startSocks();
  await startHttpProxy();
});

afterAll(() => {
  echo.server?.close();
  tcpEcho.server?.close();
  socks.server?.close();
  httpProxy.server?.close();
});

const endpoint = () => [`http://127.0.0.1:${echo.port}/`];

d('source IP binding and exit detection', () => {
  it('BIND profiles leave with their own source address', async () => {
    expect(await detectPublicIp(profile({ kind: 'BIND', localBindIp: '127.0.0.2' }), null, endpoint())).toBe('127.0.0.2');
    expect(await detectPublicIp(profile({ kind: 'BIND', localBindIp: '127.0.0.3' }), null, endpoint())).toBe('127.0.0.3');
    const s = await openSocket(profile({ kind: 'BIND', localBindIp: '127.0.0.2' }), null, { host: '127.0.0.1', port: tcpEcho.port });
    s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(tcpEcho.seen.at(-1)).toBe('127.0.0.2');
  });

  it('SOCKS5 profiles authenticate with the vault password and exit via the proxy', async () => {
    const p = profile({ kind: 'SOCKS5', proxyHost: '127.0.0.1', proxyPort: socks.port, proxyUsername: 'alice' });
    expect(await detectPublicIp(p, { password: 'socks-secret' }, endpoint())).toBe('127.0.0.4');
    expect(socks.auths.at(-1)).toBe('alice:socks-secret');
    const s = await openSocket(p, { password: 'socks-secret' }, { host: '127.0.0.1', port: tcpEcho.port });
    s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(tcpEcho.seen.at(-1)).toBe('127.0.0.4');
    await expect(openSocket(p, { password: 'wrong' }, { host: '127.0.0.1', port: tcpEcho.port })).rejects.toThrow();
  });

  it('HTTP CONNECT profiles send Basic credentials and exit via the proxy', async () => {
    const p = profile({ kind: 'HTTP', proxyHost: '127.0.0.1', proxyPort: httpProxy.port, proxyUsername: 'bob' });
    const s = await openSocket(p, { password: 'http-secret' }, { host: '127.0.0.1', port: tcpEcho.port });
    s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(tcpEcho.seen.at(-1)).toBe('127.0.0.5');
    expect(httpProxy.auths.at(-1)).toBe('bob:http-secret');
    expect(await detectPublicIp(p, { password: 'http-secret' }, endpoint())).toBe('127.0.0.5');
    await expect(openSocket(p, { password: 'nope' }, { host: '127.0.0.1', port: tcpEcho.port })).rejects.toThrow(/407/);
  });
});

d('exit IP verification, network guard and diagnosis (real sockets)', () => {
  async function suiteWithRealDetector() {
    const t = await createTestSuite({ ipDetector: detectPublicIp });
    t.suite.network.endpoints = endpoint();
    return t;
  }

  it('detects a wrong exit assignment', async () => {
    const { suite } = await suiteWithRealDetector();
    const id = suite.identities.create({}).identity.id;
    const p = suite.repo.createNetworkProfile(id, { kind: 'BIND', localBindIp: '127.0.0.3', expectedPublicIp: '127.0.0.2' });
    const res = await suite.network.verify(id, p.id);
    expect(res!.checkStatus).toBe('MISMATCH');
    expect(res!.actualPublicIp).toBe('127.0.0.3');
    expect(suite.audit.list().some((e) => e.action === 'Exit IP mismatch')).toBe(true);
    suite.repo.updateNetworkProfile(id, p.id, { localBindIp: '127.0.0.2' });
    expect((await suite.network.verify(id, p.id))!.checkStatus).toBe('OK');
    expect(suite.audit.list().some((e) => e.action === 'Network IP changed')).toBe(true);
  });

  it('blocks session start on IP mismatch when the guard is "block"', async () => {
    const { suite, bots } = await suiteWithRealDetector();
    const id = suite.identities.create({ settings: { networkGuard: 'block' } }).identity.id;
    suite.repo.upsertMinecraft(id, { username: 'Guarded', authType: 'offline' });
    suite.repo.createNetworkProfile(id, { kind: 'BIND', localBindIp: '127.0.0.3', expectedPublicIp: '127.0.0.2' });
    const srv = suite.repo.upsertServer({ name: 'SMP', host: '127.0.0.1', port: tcpEcho.port });
    suite.repo.assignServer(id, { serverId: srv.id });
    await suite.sessions.startSession(id, srv.id);
    await settle();
    const st = suite.sessions.getState(`${id}:${srv.id}`);
    expect(st.state).toBe('RECONNECTING');
    expect(st.lastError).toMatch(/Network guard: exit IP mismatch/);
    expect(bots).toHaveLength(0); // never connected with the wrong exit
    // "warn" mode starts but records the problem
    suite.repo.updateIdentity(id, { settings: { networkGuard: 'warn' } });
    await suite.sessions.reconnect(`${id}:${srv.id}`);
    await settle();
    expect(bots).toHaveLength(1);
    expect(suite.repo.sessionEvents({ sessionId: `${id}:${srv.id}` }).some((e) => e.kind === 'network-warning')).toBe(true);
  });

  it('diagnoses a profile step by step', async () => {
    const { suite } = await suiteWithRealDetector();
    const id = suite.identities.create({}).identity.id;
    const good = suite.repo.createNetworkProfile(id, { kind: 'BIND', name: 'good', localBindIp: '127.0.0.2', expectedPublicIp: '127.0.0.2' });
    const srv = suite.repo.upsertServer({ name: 'SMP', host: '127.0.0.1', port: tcpEcho.port });
    suite.repo.assignServer(id, { serverId: srv.id });
    const dg = await suite.network.diagnose(id, good.id);
    expect(dg.ok).toBe(true);
    const tcp = dg.steps.find((s) => s.step === 'Minecraft TCP SMP')!;
    expect(tcp.status).toBe('ok');
    expect(tcp.detail).toContain('local source 127.0.0.2');
    expect(dg.steps.find((s) => s.step === 'Public exit IP')!.status).toBe('ok');

    const bad = suite.repo.createNetworkProfile(id, { kind: 'BIND', name: 'bad', localBindIp: '10.254.254.254', expectedPublicIp: '127.0.0.2' });
    const dg2 = await suite.network.diagnose(id, bad.id);
    expect(dg2.ok).toBe(false);
    expect(dg2.steps.find((s) => s.step === 'Local bind IP')!.status).toBe('error');
  });
});
