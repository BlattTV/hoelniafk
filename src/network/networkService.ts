import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import type { NetworkProfile } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { Vault } from '../vault/vault.js';
import { ValidationError } from '../core/errors.js';
import { detectPublicIp, DEFAULT_IP_ENDPOINTS } from './publicIp.js';
import type { ProxySecret } from './connector.js';

export type IpDetector = (profile: NetworkProfile | null, secret: ProxySecret | null, endpoints: string[]) => Promise<string>;

export interface ResolvedNetwork {
  profile: NetworkProfile | null;
  secret: ProxySecret | null;
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
