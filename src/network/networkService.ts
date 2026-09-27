import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import type { NetworkProfile } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { Vault } from '../vault/vault.js';
import { ValidationError } from '../core/errors.js';
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import { detectPublicIp, DEFAULT_IP_ENDPOINTS } from './publicIp.js';
import { openSocket, resolveMinecraftTarget, type ProxySecret } from './connector.js';

export type IpDetector = (profile: NetworkProfile | null, secret: ProxySecret | null, endpoints: string[]) => Promise<string>;

export interface ResolvedNetwork {
  profile: NetworkProfile | null;
  secret: ProxySecret | null;
}

export interface DiagnosticStep {
  step: string;
  status: 'ok' | 'warn' | 'error' | 'skipped';
  detail: string;
  ms: number | null;
}

export interface NetworkDiagnosis {
  identityId: number;
  profileId: number | null;
  profileName: string | null;
  steps: DiagnosticStep[];
  ok: boolean;
}

/** Local addresses of all network interfaces (for bind-IP validation). */
export function localAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((a) => a!.address);
}

export function isLocalAddress(ip: string): boolean {
  if (/^127\./.test(ip) && process.platform === 'linux') return true; // whole 127/8 is local on Linux
  return localAddresses().includes(ip);
}

export interface NetworkConflict {
  field: 'expectedPublicIp' | 'localBindIp' | 'proxy';
  value: string;
  otherIdentityId: number;
}

export class NetworkService {
  endpoints: string[] = DEFAULT_IP_ENDPOINTS;

  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly detector: IpDetector = detectPublicIp,
  ) {}

  /**
   * Resolves the network profile an identity (optionally for one server session) must use.
   * Only profiles owned by this identity are ever returned; credentials come from the
   * identity-scoped vault.
   */
  async resolve(identityId: number, overrideProfileId?: number | null): Promise<ResolvedNetwork> {
    const identity = this.repo.getIdentity(identityId);
    const profileId = overrideProfileId ?? identity.networkProfileId;
    if (!profileId) return { profile: null, secret: null };
    const profile = this.repo.getNetworkProfileFor(identityId, profileId);
    let secret: ProxySecret | null = null;
    if (profile.credentialRef) {
      secret = await this.vault.forIdentity(identityId).getJson<ProxySecret>(profile.credentialRef);
    }
    return { profile, secret };
  }

  async setProxyPassword(identityId: number, profileId: number, password: string): Promise<NetworkProfile> {
    const profile = this.repo.getNetworkProfileFor(identityId, profileId);
    if (profile.kind !== 'SOCKS5' && profile.kind !== 'HTTP') throw new ValidationError('Only proxy profiles have credentials');
    const iv = this.vault.forIdentity(identityId);
    const ref = iv.ref('network', profileId);
    await iv.setJson(ref, { password } satisfies ProxySecret);
    const updated = this.repo.updateNetworkProfile(identityId, profileId, { credentialRef: ref });
    this.audit.record(identityId, 'Proxy credentials updated', { profile: profile.name });
    return updated;
  }

  async deleteProfile(identityId: number, profileId: number): Promise<void> {
    const profile = this.repo.getNetworkProfileFor(identityId, profileId);
    if (profile.credentialRef) await this.vault.forIdentity(identityId).delete(profile.credentialRef);
    this.repo.deleteNetworkProfile(identityId, profileId);
    this.audit.record(identityId, 'Network profile deleted', { profile: profile.name });
  }

  /** Connection test: detects the real exit IP and compares it with the expected one. */
  async verify(identityId: number, profileId?: number | null): Promise<NetworkProfile | null> {
    const { profile, secret } = await this.resolve(identityId, profileId);
    if (!profile) return null;
    const previous = profile.actualPublicIp;
    let updated: NetworkProfile;
    try {
      const ip = await this.detector(profile, secret, this.endpoints);
      const status = profile.expectedPublicIp && profile.expectedPublicIp !== ip ? 'MISMATCH' : 'OK';
      updated = this.repo.recordNetworkCheck(profile.id, {
        actualPublicIp: ip,
        status,
        error: status === 'MISMATCH' ? `Expected ${profile.expectedPublicIp}, got ${ip}` : null,
      });
      if (previous && previous !== ip) {
        this.audit.record(identityId, 'Network IP changed', { profile: profile.name, from: previous, to: ip });
      }
      if (status === 'MISMATCH') this.audit.record(identityId, 'Exit IP mismatch', { profile: profile.name, expected: profile.expectedPublicIp, actual: ip });
    } catch (e) {
      updated = this.repo.recordNetworkCheck(profile.id, { actualPublicIp: previous, status: 'ERROR', error: (e as Error).message });
    }
    this.bus.emit({ type: 'network.checked', identityId, data: { profileId: updated.id, status: updated.checkStatus } });
    return updated;
  }

  /**
   * Step-by-step network diagnosis for one profile of an identity:
   * ownership → bind IP present → proxy reachable → DNS → Minecraft TCP through
   * the profile → public exit IP vs. expected → conflicts with other identities.
   */
  async diagnose(identityId: number, profileId?: number | null): Promise<NetworkDiagnosis> {
    const steps: DiagnosticStep[] = [];
    const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
      const t = Date.now();
      const r = await fn();
      return [r, Date.now() - t];
    };
    let resolved: ResolvedNetwork;
    try {
      resolved = await this.resolve(identityId, profileId);
      steps.push({ step: 'Profile', status: 'ok', detail: resolved.profile ? `${resolved.profile.name} (${resolved.profile.kind}) owned by this identity` : 'No profile – direct connection', ms: null });
    } catch (e) {
      steps.push({ step: 'Profile', status: 'error', detail: (e as Error).message, ms: null });
      return { identityId, profileId: profileId ?? null, profileName: null, steps, ok: false };
    }
    const p = resolved.profile;

    if (p?.localBindIp) {
      const present = isLocalAddress(p.localBindIp);
      steps.push({
        step: 'Local bind IP',
        status: present ? 'ok' : 'error',
        detail: present ? `${p.localBindIp} is assigned to a local interface` : `${p.localBindIp} is not assigned to any local network interface (add it to the adapter first)`,
        ms: null,
      });
    } else steps.push({ step: 'Local bind IP', status: 'skipped', detail: 'Not used by this profile', ms: null });

    if (p && (p.kind === 'SOCKS5' || p.kind === 'HTTP')) {
      try {
        const [, ms] = await time(
          () =>
            new Promise<void>((resolve, reject) => {
              const sock = net.connect({ host: p.proxyHost!, port: p.proxyPort!, localAddress: p.localBindIp ?? undefined });
              sock.setTimeout(5000, () => sock.destroy(new Error('timeout')));
              sock.once('connect', () => {
                sock.destroy();
                resolve();
              });
              sock.once('error', reject);
            }),
        );
        steps.push({ step: 'Proxy reachable', status: 'ok', detail: `${p.proxyHost}:${p.proxyPort}${p.credentialRef ? ' (credentials in vault)' : ''}`, ms });
      } catch (e) {
        steps.push({ step: 'Proxy reachable', status: 'error', detail: `${p.proxyHost}:${p.proxyPort}: ${(e as Error).message}`, ms: null });
      }
    } else steps.push({ step: 'Proxy reachable', status: 'skipped', detail: 'No proxy', ms: null });

    const servers = this.repo
      .listAssignments(identityId)
      .filter((a) => a.enabled && (a.networkProfileId ?? this.repo.getIdentity(identityId).networkProfileId) === (p?.id ?? null))
      .map((a) => this.repo.getServer(a.serverId));
    for (const srv of servers) {
      try {
        const [target, dnsMs] = await time(async () => {
          if (!net.isIP(srv.host) && srv.host !== 'localhost') await dns.lookup(srv.host);
          return resolveMinecraftTarget(srv.host, srv.port);
        });
        steps.push({ step: `DNS ${srv.name}`, status: 'ok', detail: `${srv.host} → ${target.host}:${target.port}`, ms: dnsMs });
        const [sock, ms] = await time(() => openSocket(p, resolved.secret, target, 8000));
        const local = `${sock.localAddress}`;
        sock.destroy();
        const bindOk = !p?.localBindIp || p.kind !== 'BIND' || local.endsWith(p.localBindIp);
        steps.push({
          step: `Minecraft TCP ${srv.name}`,
          status: bindOk ? 'ok' : 'error',
          detail: `connected via ${p?.kind ?? 'DIRECT'}, local source ${local}${bindOk ? '' : ` (expected ${p!.localBindIp})`}`,
          ms,
        });
      } catch (e) {
        steps.push({ step: `Minecraft TCP ${srv.name}`, status: 'error', detail: (e as Error).message, ms: null });
      }
    }
    if (!servers.length) steps.push({ step: 'Minecraft TCP', status: 'skipped', detail: 'No enabled server uses this profile', ms: null });

    if (p) {
      const t = Date.now();
      const checked = await this.verify(identityId, p.id);
      const ms = Date.now() - t;
      if (!checked || checked.checkStatus === 'ERROR') steps.push({ step: 'Public exit IP', status: 'error', detail: checked?.lastError ?? 'check failed', ms });
      else if (checked.checkStatus === 'MISMATCH') steps.push({ step: 'Public exit IP', status: 'error', detail: `actual ${checked.actualPublicIp}, expected ${checked.expectedPublicIp}`, ms });
      else if (!checked.expectedPublicIp) steps.push({ step: 'Public exit IP', status: 'warn', detail: `actual ${checked.actualPublicIp} – no expected IP configured`, ms });
      else steps.push({ step: 'Public exit IP', status: 'ok', detail: `${checked.actualPublicIp} = expected`, ms });
    } else steps.push({ step: 'Public exit IP', status: 'skipped', detail: 'No profile', ms: null });

    const conflicts = this.conflicts(identityId);
    steps.push({
      step: 'Isolation',
      status: conflicts.length ? 'warn' : 'ok',
      detail: conflicts.length ? conflicts.map((c) => `shares ${c.field} ${c.value} with identity ${c.otherIdentityId}`).join('; ') : 'No other identity uses the same exit, bind IP or proxy',
      ms: null,
    });
    return { identityId, profileId: p?.id ?? null, profileName: p?.name ?? null, steps, ok: !steps.some((s) => s.status === 'error') };
  }

  /** Finds other identities that would share an exit IP, bind IP or proxy with this identity. */
  conflicts(identityId: number): NetworkConflict[] {
    const mine = this.repo.listNetworkProfiles(identityId);
    const others = this.repo.listNetworkProfiles().filter((p) => p.identityId !== identityId);
    const out: NetworkConflict[] = [];
    for (const p of mine) {
      for (const o of others) {
        if (p.expectedPublicIp && p.expectedPublicIp === o.expectedPublicIp)
          out.push({ field: 'expectedPublicIp', value: p.expectedPublicIp, otherIdentityId: o.identityId });
        if (p.localBindIp && p.localBindIp === o.localBindIp && p.kind === 'BIND' && o.kind === 'BIND')
          out.push({ field: 'localBindIp', value: p.localBindIp, otherIdentityId: o.identityId });
        if (p.proxyHost && p.proxyHost === o.proxyHost && p.proxyPort === o.proxyPort && p.proxyUsername === o.proxyUsername)
          out.push({ field: 'proxy', value: `${p.proxyHost}:${p.proxyPort}`, otherIdentityId: o.identityId });
      }
    }
    return out;
  }
}
