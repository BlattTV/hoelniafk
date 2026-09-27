/**
 * Local connection forwarder for real Minecraft clients.
 *
 *   Minecraft client ──TCP──▶ 127.0.0.1:<port> (forwarder) ──NetworkProfile──▶ server
 *
 * The vanilla client cannot bind a source IP or use a SOCKS/HTTP proxy. The
 * suite therefore lets it join a local forwarder which opens the upstream
 * connection through the identity's network profile (bind IP / proxy) and
 * rewrites the handshake so the server (and BungeeCord/Velocity forced hosts)
 * sees the real server address instead of 127.0.0.1.
 *
 * `beforeLogin` runs once before the first login connection goes upstream –
 * used to end the lightweight (mineflayer) session at the very last moment
 * during a handover, so the server never sees two logins of the same account.
 */
import net from 'node:net';
import { openSocket, resolveMinecraftTarget, type ProxySecret } from '../network/connector.js';
import type { NetworkProfile } from '../core/types.js';

export interface ForwarderOptions {
  target: { host: string; port: number };
  network: { profile: NetworkProfile | null; secret: ProxySecret | null };
  beforeLogin?: () => Promise<void>;
  onLoginUpstream?: (info: { localAddress: string | undefined }) => void;
  onLoginClosed?: (reason: string) => void;
  connectTimeoutMs?: number;
}

export interface Forwarder {
  port: number;
  stats(): { connections: number; bytesUp: number; bytesDown: number; loginActive: boolean };
  close(): Promise<void>;
}

// ---------------------------------------------------------------- protocol helpers

export function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0;
  let size = 0;
  let byte: number;
  do {
    if (offset + size >= buf.length) return null;
    byte = buf[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if (size > 5) throw new Error('VarInt too long');
  } while (byte & 0x80);
  return { value, size };
}

export function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

export interface Handshake {
  protocol: number;
  host: string;
  port: number;
  nextState: number;
  /** Total bytes of the framed packet in the buffer. */
  frameLength: number;
}

/** Parses the first (handshake) packet. Returns null if more data is needed. */
export function parseHandshake(buf: Buffer): Handshake | null {
  const len = readVarInt(buf, 0);
  if (!len) return null;
  const total = len.size + len.value;
  if (buf.length < total) return null;
  let o = len.size;
  const id = readVarInt(buf, o)!;
  o += id.size;
  if (id.value !== 0) throw new Error('Not a handshake packet');
  const proto = readVarInt(buf, o)!;
  o += proto.size;
  const hl = readVarInt(buf, o)!;
  o += hl.size;
  const host = buf.subarray(o, o + hl.value).toString('utf8');
  o += hl.value;
  const port = buf.readUInt16BE(o);
  o += 2;
  const next = readVarInt(buf, o)!;
  return { protocol: proto.value, host, port, nextState: next.value, frameLength: total };
}

export function buildHandshake(h: Omit<Handshake, 'frameLength'>): Buffer {
  const host = Buffer.from(h.host, 'utf8');
  const port = Buffer.alloc(2);
  port.writeUInt16BE(h.port);
  const body = Buffer.concat([writeVarInt(0), writeVarInt(h.protocol), writeVarInt(host.length), host, port, writeVarInt(h.nextState)]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** Keeps suffixes some proxies/mod loaders append to the host ("\0FML\0", BungeeCord IP forwarding data). */
function rewriteHost(original: string, realHost: string): string {
  const nul = original.indexOf('\0');
  return nul >= 0 ? realHost + original.slice(nul) : realHost;
}

// ---------------------------------------------------------------- forwarder

export async function startForwarder(opts: ForwarderOptions): Promise<Forwarder> {
  let connections = 0;
  let bytesUp = 0;
  let bytesDown = 0;
  let loginActive = false;
  let beforeLoginDone: Promise<void> | null = null;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    connections++;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    let decided = false;

    const onData = async (chunk: Buffer) => {
      if (decided) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered[0] === 0xfe) {
        // legacy server-list ping – not supported for joins, just close
        decided = true;
        client.destroy();
        return;
      }
      let hs: Handshake | null;
      try {
        hs = parseHandshake(buffered);
      } catch {
        decided = true;
        client.destroy();
        return;
      }
      if (!hs) {
        if (buffered.length > 4096) client.destroy();
        return;
      }
      decided = true;
      client.pause();
      client.removeListener('data', onData);
      const isLogin = hs.nextState === 2 || hs.nextState === 3; // 3 = transfer (1.20.5+)
      try {
        if (isLogin && opts.beforeLogin) {
          beforeLoginDone ??= opts.beforeLogin();
          await beforeLoginDone;
        }
        const target = await resolveMinecraftTarget(opts.target.host, opts.target.port);
        const upstream = await openSocket(opts.network.profile, opts.network.secret, target, opts.connectTimeoutMs ?? 15_000);
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        const rewritten = buildHandshake({ protocol: hs.protocol, host: rewriteHost(hs.host, opts.target.host), port: opts.target.port, nextState: hs.nextState });
        upstream.write(Buffer.concat([rewritten, buffered.subarray(hs.frameLength)]));
        if (isLogin) {
          loginActive = true;
          opts.onLoginUpstream?.({ localAddress: upstream.localAddress });
        }
        client.on('data', (d: Buffer) => {
          bytesUp += d.length;
        });
        upstream.on('data', (d: Buffer) => {
          bytesDown += d.length;
        });
        client.pipe(upstream);
        upstream.pipe(client);
        const done = (reason: string) => {
          client.destroy();
          upstream.destroy();
          if (isLogin && loginActive) {
            loginActive = false;
            opts.onLoginClosed?.(reason);
          }
        };
        client.on('close', () => done('client closed'));
        upstream.on('close', () => done('server closed'));
        upstream.on('error', () => done('upstream error'));
        client.resume();
      } catch (e) {
        client.destroy();
        if (isLogin) opts.onLoginClosed?.(`upstream failed: ${(e as Error).message}`);
      }
    };
    client.on('data', onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    stats: () => ({ connections, bytesUp, bytesDown, loginActive }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
