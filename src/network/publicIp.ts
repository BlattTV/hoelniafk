import https from 'node:https';
import http from 'node:http';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { NetworkProfile } from '../core/types.js';
import type { ProxySecret } from './connector.js';

export const DEFAULT_IP_ENDPOINTS = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

function agentFor(profile: NetworkProfile | null, secret: ProxySecret | null): http.Agent | undefined {
  if (!profile || profile.kind === 'DIRECT' || profile.kind === 'BIND') return undefined;
  const auth = profile.proxyUsername
    ? `${encodeURIComponent(profile.proxyUsername)}:${encodeURIComponent(secret?.password ?? '')}@`
    : '';
  if (profile.kind === 'SOCKS5') return new SocksProxyAgent(`socks5h://${auth}${profile.proxyHost}:${profile.proxyPort}`);
  return new HttpsProxyAgent(`http://${auth}${profile.proxyHost}:${profile.proxyPort}`) as unknown as http.Agent;
}

function fetchText(url: string, profile: NetworkProfile | null, secret: ProxySecret | null, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      url,
      {
        agent: agentFor(profile, secret),
        localAddress: profile?.kind === 'BIND' ? profile.localBindIp ?? undefined : undefined,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'HoelniClientSuite/0.1' },
      },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          reject(new Error(`${u.host} returned HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 1000) req.destroy(new Error('Response too large'));
        });
        res.on('end', () => resolve(body.trim()));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${u.host} timed out`)));
    req.on('error', reject);
  });
}

/** Determines the public (exit) IP as seen from the internet through the given network profile. */
export async function detectPublicIp(
  profile: NetworkProfile | null,
  secret: ProxySecret | null,
  endpoints: string[] = DEFAULT_IP_ENDPOINTS,
  timeoutMs = 10000,
): Promise<string> {
  const errors: string[] = [];
  for (const ep of endpoints) {
    try {
      const ip = await fetchText(ep, profile, secret, timeoutMs);
      if (/^[0-9a-f.:]+$/i.test(ip)) return ip;
      errors.push(`${ep}: unexpected response`);
    } catch (e) {
      errors.push(`${ep}: ${(e as Error).message}`);
    }
  }
  throw new Error(`Public IP detection failed (${errors.join('; ')})`);
}
