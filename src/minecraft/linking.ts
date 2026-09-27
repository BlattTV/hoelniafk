import type { AuditLog } from '../core/audit.js';
import { maskCode } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { nowIso } from '../core/db.js';
import type { ChatEvent } from '../core/rules.js';
import type { LinkState } from '../core/types.js';
import type { IdentityRepository } from '../identity/repository.js';

export interface PendingLink {
  code: string;
  serverId: number;
  receivedAt: string;
}

/**
 * Generic Minecraft ↔ Discord linking workflow.
 *
 *   UNKNOWN ──(link code seen in chat)──▶ WAITING ──(success message)──▶ LINKED
 *        ▲                                   │
 *        └───────(unlinked message)──────────┴──(error message)──▶ ERROR
 *
 * The workflow only *observes*: the link code is shown to the user, who completes
 * the link through the server's intended Discord/OAuth flow. What counts as a code,
 * success or error is defined entirely by chat rules in rules.yaml.
 */
export class LinkingWorkflow {
  private readonly pending = new Map<number, PendingLink>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {}

  pendingFor(identityId: number): PendingLink | null {
    return this.pending.get(identityId) ?? null;
  }

  state(identityId: number): LinkState {
    return this.repo.getDiscord(identityId)?.linkState ?? 'UNKNOWN';
  }

  handleChatEvents(identityId: number, serverId: number, events: ChatEvent[]): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'linkCode': {
          const prev = this.pending.get(identityId);
          if (prev?.code === ev.code) break;
          this.pending.set(identityId, { code: ev.code, serverId, receivedAt: nowIso() });
          this.setState(identityId, 'WAITING', false);
          this.audit.record(identityId, 'Discord link code received', { server: serverId, codeHint: maskCode(ev.code) });
          break;
        }
        case 'linked':
          if (this.state(identityId) === 'LINKED') break;
          this.pending.delete(identityId);
          this.setState(identityId, 'LINKED', true);
          this.audit.record(identityId, 'Discord linked', { server: serverId });
          break;
        case 'unlinked':
          this.pending.delete(identityId);
          this.setState(identityId, 'UNKNOWN', false);
          this.audit.record(identityId, 'Discord unlinked', { server: serverId });
          break;
        case 'linkError':
          this.setState(identityId, 'ERROR', false, ev.message);
          this.audit.record(identityId, 'Discord link error', { server: serverId });
          break;
        default:
          break;
      }
    }
  }

  /** Manual override from the UI (e.g. after verifying on the server website). */
  setManual(identityId: number, state: LinkState): void {
    if (state !== 'WAITING') this.pending.delete(identityId);
    this.setState(identityId, state, state === 'LINKED');
    this.audit.record(identityId, 'Discord link state set manually', { state });
  }

  private setState(identityId: number, linkState: LinkState, linked: boolean, error: string | null = null): void {
    this.repo.upsertDiscord(identityId, {
      linkState,
      linkedToMinecraft: linked,
      lastError: error,
      ...(linked ? { lastVerifiedAt: nowIso() } : {}),
    });
    const pending = this.pending.get(identityId);
    this.bus.emit({ type: 'link.state', identityId, data: { linkState, hasCode: !!pending } });
    this.bus.emit({ type: 'identity.changed', identityId });
  }
}
