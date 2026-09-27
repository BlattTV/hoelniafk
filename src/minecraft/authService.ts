import { Authflow, Titles } from 'prismarine-auth';
import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { ValidationError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { nowIso } from '../core/db.js';
import type { MinecraftIdentity } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';
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

/** Abstracts prismarine-auth so the flow can be tested without Microsoft. */
export type TokenFetcher = (args: {
  msaAccount: string;
  cacheFactory: ReturnType<typeof vaultCacheFactory>;
  onDeviceCode: (info: DeviceCodeInfo) => void;
}) => Promise<MinecraftProfile>;

export const prismarineTokenFetcher: TokenFetcher = async ({ msaAccount, cacheFactory, onDeviceCode }) => {
  const flow = new Authflow(
    msaAccount,
    cacheFactory as any,
    { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' } as any,
    (res: any) => onDeviceCode({ userCode: res.user_code, verificationUri: res.verification_uri, expiresIn: res.expires_in }),
  );
  const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
  const profile = result.profile as any;
  if (!profile || profile.error || !profile.id) throw new Error('This Microsoft account does not own Minecraft Java Edition');
  return { id: profile.id, name: profile.name };
};

export function formatUuid(id: string): string {
  const h = id.replace(/-/g, '').toLowerCase();
  if (h.length !== 32) return id;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class MinecraftAuthService {
  private readonly pending = new Map<number, DeviceCodeInfo>();

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

  /**
   * Authenticates the identity's Microsoft account (device code flow on first use,
   * silent refresh afterwards). Tokens only ever live in the identity's vault scope.
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
      const profile = await this.fetcher({
        msaAccount: mc.msaAccount,
        cacheFactory: vaultCacheFactory(iv),
        onDeviceCode: (info) => {
          this.pending.set(identityId, info);
          // The device code is shown to the user in the UI; it is not logged.
          this.bus.emit({ type: 'auth.devicecode', identityId, data: info });
        },
      });
      this.pending.delete(identityId);
      const uuid = formatUuid(profile.id);
      if (mc.uuid && mc.uuid !== uuid) {
        throw new ValidationError(`Authenticated account (${profile.name}) differs from the configured UUID – refusing to mix accounts`);
      }
      const updated = this.repo.upsertMinecraft(identityId, {
        username: profile.name,
        uuid,
        authStatus: 'AUTHENTICATED',
        credentialRef: iv.ref('minecraft'),
        lastAuthAt: nowIso(),
        lastError: null,
      });
      this.audit.record(identityId, hadToken ? 'Minecraft token refreshed' : 'Minecraft authenticated', { username: profile.name });
      this.bus.emit({ type: 'identity.changed', identityId });
      return updated;
    } catch (e) {
      this.pending.delete(identityId);
      const msg = (e as Error).message;
      log.warn(`Authentication failed for identity ${identityId}: ${msg}`);
      const updated = this.repo.upsertMinecraft(identityId, { authStatus: 'ERROR', lastError: msg.slice(0, 300) });
      this.audit.record(identityId, 'Minecraft authentication failed');
      this.bus.emit({ type: 'identity.changed', identityId });
      if (e instanceof ValidationError) throw e;
      return updated;
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
