/**
 * Proxy pool: import proxy lists, test every proxy (reachable, exit IP, latency) and assign
 * one proxy per identity automatically.
 *
 *   list import ──▶ proxies table (host/port/user) + password in the vault (vault://app/proxy/<id>)
 *   assign      ──▶ identity-owned SOCKS5/HTTP network profile + password copied into the
 *                   identity's own vault scope (isolation rules stay intact)
 *
 * Sessions of an identity that runs on an agent use the same profile: the agent receives the
 * profile + secret with the session spec, so the proxy applies there as well.
 * Passwords are never returned by the API, logged or written to the audit log.
 */
import type { AuditLog } from '../core/audit.js';
import type { DB } from '../core/db.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import type { NetworkProfile } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
import { refs } from '../vault/refs.js';
import type { Vault } from '../vault/vault.js';
import type { ProxySecret } from './connector.js';
import type { IpDetector, NetworkService } from './networkService.js';

export type ProxyKind = 'SOCKS5' | 'HTTP';

export interface ParsedProxy {
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export interface PoolProxy {
  id: number;
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
  label: string | null;
  status: 'UNKNOWN' | 'OK' | 'ERROR';
  exitIp: string | null;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  identityId: number | null;
  identityLabel: string | null;
  networkProfileId: number | null;
  /** Other pool proxies that leave through the same exit IP. */
  sameExitAs: number[];
}

const HOST = /^[a-z0-9.-]+$|^\[?[0-9a-f:]+\]?$/i;

function portOf(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Parses a proxy list. Supported per line:
 *   socks5://user:pass@host:port   http://host:port   socks5h://…   https://… (HTTP CONNECT)
 *   host:port   host:port:user:pass   user:pass@host:port
 * Empty lines and lines starting with # are ignored. Errors never contain passwords.
 */
export function parseProxyList(text: string, defaultKind: ProxyKind = 'SOCKS5'): { proxies: ParsedProxy[]; errors: Array<{ line: number; error: string }> } {
  const proxies: ParsedProxy[] = [];
  const errors: Array<{ line: number; error: string }> = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const fail = (error: string) => errors.push({ line: i + 1, error });
      let kind = defaultKind;
      let rest = line;
      const scheme = /^([a-z0-9]+):\/\//i.exec(line);
      if (scheme) {
        const s = scheme[1].toLowerCase();
        if (s === 'socks5' || s === 'socks5h' || s === 'socks') kind = 'SOCKS5';
        else if (s === 'http' || s === 'https') kind = 'HTTP';
        else return fail(`unsupported scheme "${s}" (socks5 or http)`);
        rest = line.slice(scheme[0].length).replace(/\/+$/, '');
      }
      let username: string | null = null;
      let password: string | null = null;
      let hostPort = rest;
      const at = rest.lastIndexOf('@');
      if (at >= 0) {
        const cred = rest.slice(0, at);
        hostPort = rest.slice(at + 1);
        const c = cred.indexOf(':');
        username = decodeURIComponent(c >= 0 ? cred.slice(0, c) : cred);
        password = c >= 0 ? decodeURIComponent(cred.slice(c + 1)) : null;
      }
      const parts = hostPort.split(':');
      let host: string;
      let port: number | null;
      if (at < 0 && !scheme && parts.length === 4) {
        [host] = parts;
        port = portOf(parts[1]);
        username = parts[2] || null;
        password = parts[3] || null;
      } else if (parts.length === 2) {
        host = parts[0];
        port = portOf(parts[1]);
      } else return fail('expected host:port, host:port:user:pass or scheme://user:pass@host:port');
      if (!host || !HOST.test(host)) return fail('invalid host');
      if (!port) return fail('invalid port');
      proxies.push({ kind, host: host.toLowerCase(), port, username: username || null, password: password || null });
    });
  return { proxies, errors };
}

export class ProxyPool {
  constructor(
    private readonly db: DB,
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly network: NetworkService,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly detector: IpDetector,
    private readonly endpoints: () => string[],
  ) {}

  private secretRef(id: number): string {
    return refs.app(`proxy/${id}`);
  }

  private row(id: number): any {
    const r = this.db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
    if (!r) throw new NotFoundError(`Proxy ${id} not found`);
    return r;
  }

  list(): PoolProxy[] {
    const rows = this.db
      .prepare('SELECT p.*, i.label AS identity_label FROM proxies p LEFT JOIN identities i ON i.id = p.identity_id ORDER BY p.id')
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      host: r.host,
      port: r.port,
      username: r.username,
      hasPassword: !!r.credential_ref,
      label: r.label,
      status: r.status,
      exitIp: r.exit_ip,
      latencyMs: r.latency_ms,
      lastCheckedAt: r.last_checked_at,
      lastError: r.last_error,
      identityId: r.identity_id,
      identityLabel: r.identity_label ?? null,
      networkProfileId: r.network_profile_id,
      sameExitAs: r.exit_ip ? rows.filter((o) => o.id !== r.id && o.exit_ip === r.exit_ip).map((o) => o.id) : [],
    }));
  }

  private changed(): void {
    this.bus.emit({ type: 'network.checked', data: { pool: true } });
  }

  async import(text: string, opts: { kind?: ProxyKind; label?: string } = {}): Promise<{ added: number; duplicates: number; errors: Array<{ line: number; error: string }> }> {
    const { proxies, errors } = parseProxyList(text, opts.kind ?? 'SOCKS5');
    if (!proxies.length && !errors.length) throw new ValidationError('The list is empty');
    let added = 0;
    let duplicates = 0;
    for (const p of proxies) {
      const exists = this.db
        .prepare('SELECT id FROM proxies WHERE kind = ? AND host = ? AND port = ? AND COALESCE(username, \'\') = ?')
        .get(p.kind, p.host, p.port, p.username ?? '');
      if (exists) {
        duplicates++;
        continue;
      }
      const r = this.db
        .prepare('INSERT INTO proxies (kind, host, port, username, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(p.kind, p.host, p.port, p.username, opts.label?.trim() || null, new Date().toISOString());
      const id = Number(r.lastInsertRowid);
      if (p.password) {
        await this.vault.store.set(this.secretRef(id), JSON.stringify({ password: p.password } satisfies ProxySecret));
        this.db.prepare('UPDATE proxies SET credential_ref = ? WHERE id = ?').run(this.secretRef(id), id);
      }
      added++;
    }
    this.audit.record(null, 'Proxy list imported', { added, duplicates, invalid: errors.length });
    this.changed();
    return { added, duplicates, errors };
  }

  private async secretOf(id: number): Promise<ProxySecret | null> {
    const raw = await this.vault.store.get(this.secretRef(id));
    return raw ? (JSON.parse(raw) as ProxySecret) : null;
  }

  private asProfile(r: any): NetworkProfile {
    return {
      id: 0, identityId: 0, name: `pool #${r.id}`, kind: r.kind, localBindIp: null, proxyHost: r.host, proxyPort: r.port, proxyUsername: r.username,
      credentialRef: r.credential_ref, expectedPublicIp: null, actualPublicIp: null, exitLabel: null, checkStatus: 'UNKNOWN', lastCheckedAt: null, lastError: null,
    };
  }

  /** Tests one proxy: exit IP through it and the round-trip time of that request. */
  async test(id: number): Promise<PoolProxy> {
    const r = this.row(id);
    const started = Date.now();
    try {
      const ip = await this.detector(this.asProfile(r), await this.secretOf(id), this.endpoints().slice(0, 2)); // a dead proxy fails fast
      this.db
        .prepare("UPDATE proxies SET status = 'OK', exit_ip = ?, latency_ms = ?, last_error = NULL, last_checked_at = ? WHERE id = ?")
        .run(ip, Date.now() - started, new Date().toISOString(), id);
      // Keep an assigned identity's expected exit IP in sync with the pool.
      if (r.identity_id && r.network_profile_id) {
        try {
          this.repo.updateNetworkProfile(r.identity_id, r.network_profile_id, { expectedPublicIp: ip });
        } catch {
          /* profile removed meanwhile */
        }
      }
    } catch (e) {
      this.db
        .prepare("UPDATE proxies SET status = 'ERROR', latency_ms = NULL, last_error = ?, last_checked_at = ? WHERE id = ?")
        .run((e as Error).message.slice(0, 300), new Date().toISOString(), id);
    }
    return this.list().find((p) => p.id === id)!;
  }

  async testAll(ids?: number[], concurrency = 16): Promise<{ ok: number; error: number }> {
    const queue = [...(ids ?? this.list().map((p) => p.id))];
    let ok = 0;
    let error = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          const p = await this.test(id);
          if (p.status === 'OK') ok++;
          else error++;
        }
      }),
    );
    this.changed();
    return { ok, error };
  }

  /**
   * Assigns a proxy to an identity: creates an identity-owned proxy network profile (password
   * copied into the identity's vault scope) and makes it the identity's active profile.
   * Without proxyId the best free proxy is chosen: tested OK, an exit IP no other identity uses,
   * lowest latency.
   */
  async assign(identityId: number, proxyId?: number): Promise<PoolProxy> {
    this.repo.getIdentity(identityId);
    const current = this.db.prepare('SELECT id FROM proxies WHERE identity_id = ?').get(identityId) as { id: number } | undefined;
    if (current && (proxyId === undefined || current.id === proxyId)) return this.list().find((p) => p.id === current.id)!;
    let r: any;
    if (proxyId !== undefined) {
      r = this.row(proxyId);
      if (r.identity_id && r.identity_id !== identityId) throw new ValidationError(`Proxy #${proxyId} is already used by identity ${r.identity_id}`);
    } else {
      const usedIps = new Set(
        (this.db.prepare('SELECT exit_ip FROM proxies WHERE identity_id IS NOT NULL AND exit_ip IS NOT NULL').all() as any[]).map((x) => x.exit_ip),
      );
      const free = (this.db.prepare("SELECT * FROM proxies WHERE identity_id IS NULL AND status = 'OK' ORDER BY latency_ms").all() as any[]).filter(
        (x) => !usedIps.has(x.exit_ip),
      );
      r = free[0];
      if (!r) throw new ValidationError('No free, tested proxy with an unused exit IP left in the pool – import or test more proxies');
      usedIps.add(r.exit_ip);
    }
    if (current) await this.release(current.id);
    const profile = this.repo.createNetworkProfile(identityId, {
      kind: r.kind,
      name: `pool #${r.id}${r.label ? ` (${r.label})` : ''}`,
      proxyHost: r.host,
      proxyPort: r.port,
      proxyUsername: r.username,
      expectedPublicIp: r.exit_ip ?? null,
      exitLabel: r.label ?? `pool #${r.id}`,
    });
    const secret = await this.secretOf(r.id);
    if (secret) await this.network.setProxyPassword(identityId, profile.id, secret.password);
    this.repo.updateIdentity(identityId, { networkProfileId: profile.id });
    this.db.prepare('UPDATE proxies SET identity_id = ?, network_profile_id = ? WHERE id = ?').run(identityId, profile.id, r.id);
    this.audit.record(identityId, 'Proxy assigned from pool', { proxy: `#${r.id} ${r.kind} ${r.host}:${r.port}` });
    this.bus.emit({ type: 'identity.changed', identityId });
    this.changed();
    return this.list().find((p) => p.id === r.id)!;
  }

  /** Gives every identity without a pool proxy one (optionally only the given identities). */
  async autoAssign(identityIds?: number[]): Promise<{ assigned: Array<{ identityId: number; proxyId: number }>; skipped: Array<{ identityId: number; reason: string }> }> {
    const ids = identityIds ?? this.repo.listIdentities().map((i) => i.id);
    const assigned: Array<{ identityId: number; proxyId: number }> = [];
    const skipped: Array<{ identityId: number; reason: string }> = [];
    for (const identityId of ids) {
      if (this.db.prepare('SELECT id FROM proxies WHERE identity_id = ?').get(identityId)) {
        skipped.push({ identityId, reason: 'already has a pool proxy' });
        continue;
      }
      try {
        assigned.push({ identityId, proxyId: (await this.assign(identityId)).id });
      } catch (e) {
        skipped.push({ identityId, reason: (e as Error).message });
      }
    }
    return { assigned, skipped };
  }

  /** Removes the proxy from its identity (the identity's pool profile is deleted). */
  async release(id: number): Promise<void> {
    const r = this.row(id);
    if (r.identity_id && r.network_profile_id) {
      try {
        await this.network.deleteProfile(r.identity_id, r.network_profile_id);
      } catch {
        /* already gone */
      }
      this.audit.record(r.identity_id, 'Proxy released to pool', { proxy: `#${r.id}` });
      this.bus.emit({ type: 'identity.changed', identityId: r.identity_id });
    }
    this.db.prepare('UPDATE proxies SET identity_id = NULL, network_profile_id = NULL WHERE id = ?').run(id);
    this.changed();
  }

  async remove(id: number): Promise<void> {
    await this.release(id);
    await this.vault.store.delete(this.secretRef(id));
    this.db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
    this.audit.record(null, 'Proxy removed from pool', { proxy: `#${id}` });
    this.changed();
  }
}
