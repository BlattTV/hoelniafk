import prismarineAuth from 'prismarine-auth';
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { ValidationError } from '../core/errors.js';
import { createLogger, registerSecret } from '../core/logger.js';
import { nowIso } from '../core/db.js';
import type { MinecraftIdentity } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
import type { JavaSession } from '../runtime/types.js';
import type { Vault } from '../vault/vault.js';
import { vaultCacheFactory } from './tokenCache.js';

const log = createLogger('minecraft-auth');

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export interface MinecraftProfile {
  id: string;
  name: string;
}

export interface JavaTokenResult {
  profile: MinecraftProfile;
  accessToken: string;
  profileKeys: JavaSession['profileKeys'];
}

/** Abstracts prismarine-auth so the flow can be tested without Microsoft. */
export type TokenFetcher = (args: {
  msaAccount: string;
  cacheFactory: ReturnType<typeof vaultCacheFactory>;
  onDeviceCode: (info: DeviceCodeInfo) => void;
}) => Promise<JavaTokenResult>;

export const prismarineTokenFetcher: TokenFetcher = async ({ msaAccount, cacheFactory, onDeviceCode }) => {
  const { Authflow, Titles } = prismarineAuth as any;
  const flow = new Authflow(
    msaAccount,
    cacheFactory as any,
    { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' } as any,
    (res: any) => onDeviceCode({ userCode: res.user_code, verificationUri: res.verification_uri, expiresIn: res.expires_in }),
  );
  const result = await flow.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: true });
  const profile = result.profile as any;
  if (!profile || profile.error || !profile.id) throw new Error('This Microsoft account does not own Minecraft Java Edition');
  const k = result.certificates?.profileKeys;
  return {
    profile: { id: profile.id, name: profile.name },
    accessToken: result.token,
    profileKeys: k
      ? {
          publicPEM: k.publicPEM,
          privatePEM: k.privatePEM,
          signature: Buffer.from(k.signature).toString('base64'),
          signatureV2: Buffer.from(k.signatureV2).toString('base64'),
          expiresOn: new Date(k.expiresOn).toISOString(),
        }
      : null,
  };
};

export function formatUuid(id: string): string {
  const h = id.replace(/-/g, '').toLowerCase();
  if (h.length !== 32) return id;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class MinecraftAuthService {
  private readonly pending = new Map<number, DeviceCodeInfo>();
  /** Single-flight per identity: parallel sessions of one account share one token request. */
  private readonly inflight = new Map<number, Promise<JavaTokenResult>>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly fetcher: TokenFetcher = prismarineTokenFetcher,
  ) {}

  pendingDeviceCode(identityId: number): DeviceCodeInfo | null {
    return this.pending.get(identityId) ?? null;
  }

  cacheFactoryFor(identityId: number) {
    return vaultCacheFactory(this.vault.forIdentity(identityId));
  }

  private fetch(identityId: number, mc: MinecraftIdentity): Promise<JavaTokenResult> {
    const existing = this.inflight.get(identityId);
    if (existing) return existing;
    const iv = this.vault.forIdentity(identityId);
    const p = this.fetcher({
      msaAccount: mc.msaAccount!,
      cacheFactory: vaultCacheFactory(iv),
      onDeviceCode: (info) => {
        this.pending.set(identityId, info);
        // Shown to the user in the UI; never logged.
        this.bus.emit({ type: 'auth.devicecode', identityId, data: info });
        this.repo.upsertMinecraft(identityId, { authStatus: 'PENDING' });
        this.bus.emit({ type: 'identity.changed', identityId });
      },
    }).finally(() => {
      this.inflight.delete(identityId);
      this.pending.delete(identityId);
    });
    this.inflight.set(identityId, p);
    return p;
  }

  private checkProfile(identityId: number, mc: MinecraftIdentity, result: JavaTokenResult): string {
    const uuid = formatUuid(result.profile.id);
    if (mc.uuid && mc.uuid !== uuid) {
      throw new ValidationError(`Authenticated account (${result.profile.name}) differs from the configured UUID – refusing to mix accounts`);
    }
    return uuid;
  }

  /**
   * Explicit authentication from the UI (device code flow on first use, silent
   * refresh afterwards). Tokens only ever live in the identity's vault scope.
   */
  async authenticate(identityId: number): Promise<MinecraftIdentity> {
    const mc = this.repo.getMinecraft(identityId);
    if (!mc) throw new ValidationError('No Minecraft account configured for this identity');
    if (mc.authType === 'offline') {
      return this.repo.upsertMinecraft(identityId, { authStatus: 'AUTHENTICATED', lastAuthAt: nowIso(), lastError: null });
    }
    if (!mc.msaAccount) throw new ValidationError('Microsoft account e-mail is required for Microsoft authentication');
    const iv = this.vault.forIdentity(identityId);
    const hadToken = (await iv.get(iv.ref('minecraft'))) !== null;
    this.repo.upsertMinecraft(identityId, { authStatus: 'PENDING', lastError: null });
    this.bus.emit({ type: 'identity.changed', identityId });
    try {
      const result = await this.fetch(identityId, mc);
      const uuid = this.checkProfile(identityId, mc, result);
      const updated = this.repo.upsertMinecraft(identityId, {
        username: result.profile.name,
        uuid,
        authStatus: 'AUTHENTICATED',
        credentialRef: iv.ref('minecraft'),
        lastAuthAt: nowIso(),
        lastError: null,
      });
      this.audit.record(identityId, hadToken ? 'Minecraft token refreshed' : 'Minecraft authenticated', { username: result.profile.name });
      this.bus.emit({ type: 'identity.changed', identityId });
      return updated;
    } catch (e) {
      const msg = (e as Error).message;
      log.warn(`Authentication failed for identity ${identityId}: ${msg}`);
      const updated = this.repo.upsertMinecraft(identityId, { authStatus: 'ERROR', lastError: msg.slice(0, 300) });
      this.audit.record(identityId, 'Minecraft authentication failed');
      this.bus.emit({ type: 'identity.changed', identityId });
      if (e instanceof ValidationError) throw e;
      return updated;
    }
  }

  /**
   * Java session for a runtime host (called when a Microsoft session connects).
   * prismarine-auth serves cached tokens and refreshes them transparently.
   */
  async getJavaSession(identityId: number): Promise<JavaSession> {
    const mc = this.repo.getMinecraft(identityId);
    if (!mc || mc.authType !== 'microsoft' || !mc.msaAccount) throw new Error('Identity has no Microsoft account configured');
    try {
      const result = await this.fetch(identityId, mc);
      const uuid = this.checkProfile(identityId, mc, result);
      registerSecret(result.accessToken);
      const iv = this.vault.forIdentity(identityId);
      if (mc.authStatus !== 'AUTHENTICATED' || mc.uuid !== uuid || mc.username !== result.profile.name) {
        this.repo.upsertMinecraft(identityId, { username: result.profile.name, uuid, authStatus: 'AUTHENTICATED', credentialRef: iv.ref('minecraft'), lastError: null });
        this.bus.emit({ type: 'identity.changed', identityId });
      }
      this.repo.upsertMinecraft(identityId, { lastAuthAt: nowIso() });
      return { accessToken: result.accessToken, profile: result.profile, profileKeys: result.profileKeys };
    } catch (e) {
      this.repo.upsertMinecraft(identityId, { authStatus: 'ERROR', lastError: (e as Error).message.slice(0, 300) });
      this.bus.emit({ type: 'identity.changed', identityId });
      throw e;
    }
  }

  async logout(identityId: number): Promise<void> {
    const iv = this.vault.forIdentity(identityId);
    await iv.delete(iv.ref('minecraft'));
    const mc = this.repo.getMinecraft(identityId);
    if (mc) this.repo.upsertMinecraft(identityId, { authStatus: 'NONE', credentialRef: null });
    this.audit.record(identityId, 'Minecraft tokens removed');
  }
}
