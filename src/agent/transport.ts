/**
 * Connection from an app (agent / desktop) to the backend:
 *   - HTTPS with the system CAs, or with a pinned self-signed certificate (trust on first use,
 *     the user compares the fingerprint)
 *   - optionally through an HTTP(S) or SOCKS5 proxy (e.g. a household behind a proxy)
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';

export interface TransportOptions {
  /** PEM of a pinned (self-signed) server certificate. */
  pinnedCert?: string | null;
  /** http://user:pass@host:port, https://…, socks5://user:pass@host:port */
  proxy?: string | null;
  timeoutMs?: number;
}

export const DEFAULT_BACKEND = 'https://afk.hoelni.de';

export function normalizeBackendUrl(input: string): string {
  const s = String(input ?? '').trim().replace(/\/+$/, '');
  if (!s) throw new Error('Backend address is empty');
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  return `${u.protocol}//${u.host}`;
}

function proxyAgent(proxy: string | null | undefined, secure: boolean) {
  if (!proxy) return undefined;
  if (/^socks/i.test(proxy)) return new SocksProxyAgent(proxy);
  if (!secure) return undefined; // plain http through an HTTP proxy is not needed for a LAN backend
  return new HttpsProxyAgent(proxy);
}

function tlsOptions(o: TransportOptions): https.RequestOptions {
  if (!o.pinnedCert) return {};
  // Trust exactly this certificate (as its own CA); host name checks are replaced by the pin.
  return {
    ca: o.pinnedCert,
    checkServerIdentity: (_host, cert) => {
      const want = new crypto.X509Certificate(o.pinnedCert!).fingerprint256;
      return cert.fingerprint256 === want ? undefined : new Error('Server certificate does not match the pinned certificate');
    },
  };
}

export interface ServerCertificate {
  pem: string;
  fingerprint256: string;
  subject: string;
  validTo: string;
  /** Trusted by the system CAs (e.g. Let's Encrypt) – no pin needed. */
  trusted: boolean;
}

/** Reads the backend's certificate (first contact) so the user can confirm its fingerprint. */
export function probeCertificate(url: string, o: TransportOptions = {}): Promise<ServerCertificate | null> {
  const u = new URL(url);
  if (u.protocol !== 'https:') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: u.hostname, port: u.port || 443, path: '/health', method: 'GET', rejectUnauthorized: false, agent: proxyAgent(o.proxy, true), timeout: o.timeoutMs ?? 15_000 },
      (res) => {
        const sock = res.socket as tls.TLSSocket;
        const c = sock.getPeerX509Certificate?.();
        res.resume();
        if (!c) return resolve(null);
        resolve({ pem: c.toString(), fingerprint256: c.fingerprint256, subject: c.subject, validTo: c.validTo, trusted: sock.authorized });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Backend did not answer (timeout)')));
    req.on('error', reject);
    req.end();
  });
}

export async function requestJson<T>(url: string, method: string, body: unknown, o: TransportOptions = {}, headers: Record<string, string> = {}): Promise<T> {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        host: u.hostname,
        port: u.port || (secure ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        agent: proxyAgent(o.proxy, secure),
        timeout: o.timeoutMs ?? 20_000,
        headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers },
        ...(secure ? tlsOptions(o) : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not json */
          }
          if ((res.statusCode ?? 500) >= 400) return reject(Object.assign(new Error(json?.error ?? `HTTP ${res.statusCode}`), { status: res.statusCode }));
          resolve(json as T);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Backend did not answer (timeout)')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export function openWebSocket(url: string, token: string, o: TransportOptions = {}, path = '/relay'): WebSocket {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const wsUrl = `${secure ? 'wss' : 'ws'}://${u.host}${path}`;
  return new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${token}` },
    agent: proxyAgent(o.proxy, secure) as any,
    handshakeTimeout: o.timeoutMs ?? 20_000,
    ...(secure ? (tlsOptions(o) as any) : {}),
  });
}
