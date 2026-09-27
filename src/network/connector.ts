import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns/promises';
import { SocksClient } from 'socks';
import type { NetworkProfile } from '../core/types.js';

export interface ProxySecret {
  password: string;
}

export interface Target {
  host: string;
  port: number;
}

/** Resolves Minecraft SRV records (_minecraft._tcp.host) like the vanilla client does. */
export async function resolveMinecraftTarget(host: string, port: number): Promise<Target> {
  if (port !== 25565 || net.isIP(host) || host === 'localhost') return { host, port };
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (records.length) return { host: records[0].name, port: records[0].port };
  } catch {
    /* no SRV record */
  }
  return { host, port };
}

/**
 * Opens a TCP connection to `target` using exactly the given network profile.
 * The profile (and its secret) must already have been resolved for the owning identity.
 */
export async function openSocket(profile: NetworkProfile | null, secret: ProxySecret | null, target: Target, timeoutMs = 15000): Promise<net.Socket> {
  const kind = profile?.kind ?? 'DIRECT';
  switch (kind) {
    case 'DIRECT':
      return connectPlain({ host: target.host, port: target.port }, timeoutMs);
    case 'BIND':
      return connectPlain({ host: target.host, port: target.port, localAddress: profile!.localBindIp ?? undefined }, timeoutMs);
    case 'SOCKS5': {
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: profile!.proxyHost!,
          port: profile!.proxyPort!,
          type: 5,
          userId: profile!.proxyUsername ?? undefined,
          password: secret?.password,
        },
        command: 'connect',
        destination: { host: target.host, port: target.port },
        timeout: timeoutMs,
        socket_options: profile!.localBindIp ? { localAddress: profile!.localBindIp } : undefined,
      } as any);
      return socket;
    }
    case 'HTTP':
      return connectHttpTunnel(profile!, secret, target, timeoutMs);
    default:
      throw new Error(`Unsupported network kind ${kind}`);
  }
}

function connectPlain(opts: net.NetConnectOpts & { host: string; port: number }, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(opts);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${opts.host}:${opts.port} timed out`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function connectHttpTunnel(profile: NetworkProfile, secret: ProxySecret | null, target: Target, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${target.host}:${target.port}` };
    if (profile.proxyUsername) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${profile.proxyUsername}:${secret?.password ?? ''}`).toString('base64');
    }
    const req = http.request({
      host: profile.proxyHost!,
      port: profile.proxyPort!,
      method: 'CONNECT',
      path: `${target.host}:${target.port}`,
      headers,
      localAddress: profile.localBindIp ?? undefined,
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`HTTP proxy refused CONNECT (${res.statusCode})`));
      }
    });
    req.once('timeout', () => req.destroy(new Error('HTTP proxy connect timed out')));
    req.once('error', reject);
    req.end();
  });
}
