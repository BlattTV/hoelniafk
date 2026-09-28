/**
 * Microsoft sign-in per identity – no app registration needed (no Azure, no client ID).
 *
 *   1. The user enters the identity's Microsoft e-mail (outlook.com / hotmail / live).
 *   2. Minecraft: Microsoft's own Minecraft sign-in (device code). The desktop program opens the
 *      confirmation page with the code already filled in, inside the identity's own Microsoft
 *      window (persistent browser profile per identity).
 *   3. Outlook: the same window then shows outlook.live.com – already signed in, because it is the
 *      same Microsoft login. Mail is read there, like in a browser; the suite stores no mail tokens.
 *
 * Minecraft tokens live in the identity's vault scope (prismarine-auth cache), never in SQLite or logs.
 */
import type { AuditLog } from '../core/audit.js';
import { ValidationError } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type { DeviceCodeInfo, MinecraftAuthService } from '../minecraft/authService.js';
import type { IdentityRepository } from './repository.js';

const log = createLogger('microsoft');

export const OUTLOOK_URL = 'https://outlook.live.com/mail/0/';
export const MICROSOFT_LINK_URL = 'https://www.microsoft.com/link';

export type MicrosoftTarget = 'link' | 'outlook';

/** Pages the identity's Microsoft window may be opened on. */
export function isMicrosoftUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(microsoft\.com|live\.com|outlook\.com|office\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export interface MicrosoftLinkStatus {
  linked: boolean;
  email: string | null;
}

export class MicrosoftAccountService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly auth: MinecraftAuthService,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {}

  status(identityId: number): MicrosoftLinkStatus {
    const mc = this.repo.getMinecraft(identityId);
    const linked = mc?.authType === 'microsoft' && !!mc.msaAccount;
    return { linked, email: linked ? mc!.msaAccount : null };
  }

  /** Sets the identity's Microsoft account and starts the Minecraft sign-in (the code arrives via SSE too). */
  async connect(identityId: number, emailInput: string, waitMs = 6000): Promise<{ email: string; deviceCode: DeviceCodeInfo | null; authStatus: string }> {
    this.repo.getIdentity(identityId);
    const email = String(emailInput ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new ValidationError('Enter the e-mail address of the Microsoft account');
    const cur = this.repo.getMinecraft(identityId);
    const changed = !!cur && (cur.msaAccount !== email || cur.authType !== 'microsoft');
    if (changed) await this.auth.logout(identityId);
    this.repo.upsertMinecraft(identityId, {
      username: cur?.username || `Pending_${identityId}`.slice(0, 16),
      authType: 'microsoft',
      msaAccount: email,
      ...(changed ? { uuid: null } : {}),
      authStatus: 'PENDING',
      lastError: null,
    });
    this.audit.record(identityId, 'Microsoft account set', { account: email });
    this.bus.emit({ type: 'identity.changed', identityId });

    const run = this.auth.authenticate(identityId).catch((e) => {
      log.warn(`Sign-in for identity ${identityId} failed: ${(e as Error).message}`);
      return null;
    });
    // Wait briefly: either the code is needed (first sign-in) or the cached login just works.
    const until = Date.now() + waitMs;
    let done = false;
    void run.then(() => (done = true));
    while (!done && !this.auth.pendingDeviceCode(identityId) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return { email, deviceCode: this.auth.pendingDeviceCode(identityId), authStatus: this.repo.getMinecraft(identityId)?.authStatus ?? 'NONE' };
  }

  /** Page for the identity's Microsoft window. */
  target(identityId: number, to: MicrosoftTarget): string {
    this.repo.getIdentity(identityId);
    if (to === 'outlook') return OUTLOOK_URL;
    const code = this.auth.pendingDeviceCode(identityId);
    return code ? `${MICROSOFT_LINK_URL}?otc=${encodeURIComponent(code.userCode)}` : MICROSOFT_LINK_URL;
  }

  async unlink(identityId: number): Promise<void> {
    await this.auth.logout(identityId);
    this.repo.upsertMinecraft(identityId, { msaAccount: null, uuid: null, authStatus: 'NONE', lastError: null });
    this.audit.record(identityId, 'Microsoft account disconnected');
    this.bus.emit({ type: 'identity.changed', identityId });
  }
}
