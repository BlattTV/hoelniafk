/**
 * Server version behind a proxy: Velocity/BungeeCord mirror the protocol they are asked with, so
 * "auto" used to pick the newest version the library knows (chat kicks "An internal error occurred",
 * game window dropped). Now the proxy is detected, a widely supported version is used and the exact
 * version is learned from "Outdated client" kicks.
 */
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { detectServerVersion, versionFromKick } from '../src/client/instance.js';
import { readVarInt, writeVarInt } from '../src/client/forwarder.js';
import { createTestSuite, settle, waitFor } from './helpers.js';

/** Minimal status server: answers with a fixed protocol, or mirrors the requested one (proxy). */
async function statusServer(answer: (requested: number) => { name: string; protocol: number }): Promise<{ port: number; close: () => void }> {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const len = readVarInt(buf, 0);
      if (!len || buf.length < len.size + len.value) return;
      let o = len.size;
      o += readVarInt(buf, o)!.size; // packet id
      const protocol = readVarInt(buf, o)!.value;
      const a = answer(protocol);
      const json = Buffer.from(JSON.stringify({ version: { name: a.name, protocol: a.protocol }, players: { max: 1, online: 0 }, description: 'x' }));
      const body = Buffer.concat([writeVarInt(0), writeVarInt(json.length), json]);
      sock.end(Buffer.concat([writeVarInt(body.length), body]));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { port: (srv.address() as net.AddressInfo).port, close: () => srv.close() };
}

const direct = { profile: null, secret: null };

describe('server version detection', () => {
  it('a plain server reports its own version', async () => {
    const s = await statusServer(() => ({ name: 'Paper 1.21.4', protocol: 769 }));
    expect(await detectServerVersion('127.0.0.1', s.port, direct)).toEqual({ version: '1.21.4', proxy: false, name: 'Paper 1.21.4' });
    s.close();
  });

  it('a Velocity proxy mirrors the requested protocol → detected as proxy, no fake version', async () => {
    const s = await statusServer((p) => ({ name: 'Velocity 3.4.0', protocol: p }));
    expect(await detectServerVersion('127.0.0.1', s.port, direct)).toEqual({ version: null, proxy: true, name: 'Velocity 3.4.0' });
    s.close();
  });

  it('reads the wanted version from kick messages', () => {
    expect(versionFromKick('Outdated client! Please use 1.21.4')).toBe('1.21.4');
    expect(versionFromKick("Outdated server! I'm still on 1.20.1")).toBe('1.20.1');
    expect(versionFromKick('Unable to connect you to lobby: Outdated client! Please use 1.21.8')).toBe('1.21.8');
    expect(versionFromKick('An internal error occurred in your connection.')).toBeNull();
    expect(versionFromKick('You were kicked for spamming 1.2.3')).toBeNull();
  });

  it('behind a proxy: fallback version, then the version from an "Outdated client" kick', async () => {
    const t = await createTestSuite();
    const { suite, bots } = t;
    const detected: string[] = [];
    suite.sessions.detectVersion = async (host) => {
      detected.push(host);
      return { version: null, proxy: true, name: 'Velocity 3.4.0' };
    };
    const srv = suite.repo.upsertServer({ name: 'hoelni', host: 'proxy.example.com' });
    const id = suite.identities.create({ label: 'V' }).identity.id;
    suite.repo.upsertMinecraft(id, { username: 'Vplayer', authType: 'offline' });
    suite.repo.assignServer(id, { serverId: srv.id });
    await suite.sessions.startSession(id, srv.id);
    await waitFor(() => bots.length === 1, 2000, 'bot');
    expect(bots[0].spec.server.version).toBe('1.21.1'); // not the newest library version
    expect(suite.repo.sessionEvents({ sessionId: `${id}:${srv.id}` }).some((e) => e.kind === 'version' && /Proxy detected/.test(e.detail))).toBe(true);
    bots[0].emit('kicked', 'Unable to connect you to lobby: Outdated client! Please use 1.21.4');
    bots[0].emit('end', 'socketClosed');
    await waitFor(() => bots.length === 2, 3000, 'reconnect with the learned version');
    expect(bots[1].spec.server.version).toBe('1.21.4');
    expect(suite.repo.getSetting(`server.${srv.id}.learnedVersion`)).toBe('1.21.4');
    // an explicitly configured version always wins
    suite.repo.upsertServer({ id: srv.id, name: 'hoelni', host: 'proxy.example.com', version: '1.20.4' } as any);
    bots[1].join();
    await settle();
    await suite.sessions.reconnect(`${id}:${srv.id}`);
    await waitFor(() => bots.length === 3, 3000, 'third bot');
    expect(bots[2].spec.server.version).toBe('1.20.4');
    expect(detected).toHaveLength(1); // cached per server
  });
});
