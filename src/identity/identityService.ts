import type { AuditLog } from '../core/audit.js';
import type { EventBus } from '../core/events.js';
import { DEFAULT_SETTINGS, mergeSettings, type IdentityProfile, type IdentitySettings, type IdentityTemplateConfig } from '../core/types.js';
import type { LinkingWorkflow } from '../minecraft/linking.js';
import type { SessionManager } from '../minecraft/sessionManager.js';
import type { NetworkService } from '../network/networkService.js';
import type { Vault } from '../vault/vault.js';
import { computeHealth, type HealthReport } from './health.js';
import type { IdentityRepository } from './repository.js';

export interface DashboardRow {
  id: number;
  number: number;
  label: string;
  health: HealthReport['level'];
  ready: boolean;
  /** Agent this identity runs on by default (null = the PC of the suite). */
  agentId: number | null;
  minecraft: { username: string | null; authStatus: string | null; online: number; sessions: number };
  sessions: Array<{ id: string; serverId: number; serverName: string; desired: string; state: string; lastError: string | null }>;
  discord: { state: string; linkState: string; username: string | null; pendingLinkCode: string | null };
  mail: { address: string | null; unread: number; status: string | null };
  network: { exitLabel: string | null; actualIp: string | null; expectedIp: string | null; status: string | null };
  stars: number;
  eligible: boolean;
  tags: string[];
  color: string | null;
}

export class IdentityService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly vault: Vault,
    private readonly network: NetworkService,
    private readonly sessions: SessionManager,
    private readonly linking: LinkingWorkflow,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {}

  create(input: { label?: string; templateId?: number | null; settings?: Partial<IdentitySettings> }): { identity: IdentityProfile; warnings: string[] } {
    const warnings: string[] = [];
    let settings = mergeSettings(DEFAULT_SETTINGS, undefined);
    let servers: string[] = [];
    if (input.templateId) {
      const t = this.repo.getTemplate(input.templateId);
      settings = mergeSettings(settings, t.config.settings);
      settings.networkMode = t.config.network?.mode ?? settings.networkMode;
      servers = t.config.servers ?? [];
    }
    settings = mergeSettings(settings, input.settings);
    const identity = this.repo.createIdentity({ label: input.label, templateId: input.templateId ?? null, settings });
    for (const name of servers) {
      const server = this.repo.getServerByName(name);
      if (!server) {
        warnings.push(`Template server "${name}" does not exist – skipped`);
        continue;
      }
      this.repo.assignServer(identity.id, { serverId: server.id, enabled: true, desiredState: 'OFFLINE' });
    }
    this.audit.record(identity.id, 'Identity created', { label: identity.label, template: input.templateId ?? 'none' });
    this.bus.emit({ type: 'identity.changed', identityId: identity.id });
    return { identity, warnings };
  }

  /**
   * Identity Clone *without secrets*: copies server assignments, network rules
   * (mode and kind – never concrete IPs, proxies or credentials), AFK settings,
   * chat parsers and UI settings. Minecraft, mail and Discord accounts as well as
   * every vault entry stay with the source identity.
   */
  clone(sourceId: number, label?: string): IdentityProfile {
    const src = this.repo.getIdentity(sourceId);
    const settings: IdentitySettings = structuredClone(src.settings);
    settings.ui = { ...settings.ui, notes: undefined, tags: [...settings.ui.tags] };
    const identity = this.repo.createIdentity({ label, templateId: src.templateId, settings });
    for (const a of this.repo.listAssignments(sourceId)) {
      // Desired state starts OFFLINE: the clone has no Minecraft account yet.
      this.repo.assignServer(identity.id, { serverId: a.serverId, enabled: a.enabled, autoStart: a.autoStart, networkProfileId: null, desiredState: 'OFFLINE' });
    }
    const srcProfile = src.networkProfileId ? this.repo.getNetworkProfile(src.networkProfileId) : null;
    if (srcProfile && srcProfile.kind === 'DIRECT') {
      this.repo.createNetworkProfile(identity.id, { kind: 'DIRECT', name: srcProfile.name });
    }
    this.audit.record(identity.id, 'Identity cloned (without secrets)', { source: `#${String(src.number).padStart(2, '0')}` });
    this.bus.emit({ type: 'identity.changed', identityId: identity.id });
    return identity;
  }

  /** Saves an identity's non-secret configuration as a reusable template. */
  saveAsTemplate(identityId: number, name: string) {
    const identity = this.repo.getIdentity(identityId);
    const servers = this.repo.listAssignments(identityId).map((a) => this.repo.getServer(a.serverId).name);
    const profile = identity.networkProfileId ? this.repo.getNetworkProfile(identity.networkProfileId) : null;
    const { ui, ...rest } = identity.settings;
    const config: IdentityTemplateConfig = {
      settings: { ...rest, ui: { tags: [...ui.tags], color: ui.color } },
      servers,
      network: { mode: identity.settings.networkMode, kind: profile?.kind },
    };
    return this.repo.saveTemplate({ name, config });
  }

  /** Set by the app: the identity's accounts go back to the library (with their logins) first. */
  beforeDelete: ((identityId: number) => Promise<void>) | null = null;

  async delete(identityId: number): Promise<void> {
    const identity = this.repo.getIdentity(identityId);
    await this.beforeDelete?.(identityId);
    this.sessions.forgetIdentity(identityId);
    const removed = await this.vault.forIdentity(identityId).purge();
    this.repo.deleteIdentity(identityId);
    this.audit.record(null, 'Identity deleted', { identity: `#${String(identity.number).padStart(2, '0')}`, secretsRemoved: removed });
    this.bus.emit({ type: 'identity.changed', identityId });
  }

  health(identityId: number): HealthReport {
    const identity = this.repo.getIdentity(identityId);
    return computeHealth(this.repo, identity, this.sessions.list(identityId), this.network.conflicts(identityId));
  }

  dashboard(): DashboardRow[] {
    return this.repo.listIdentities().map((identity) => {
      const id = identity.id;
      const report = computeHealth(this.repo, identity, this.sessions.list(id), this.network.conflicts(id));
      const mc = this.repo.getMinecraft(id);
      const d = this.repo.getDiscord(id);
      const mail = this.repo.getMailIdentity(id);
      const profile = identity.networkProfileId ? this.repo.getNetworkProfile(identity.networkProfileId) : null;
      const sessions = this.sessions.list(id);
      const rewards = this.repo.getRewards(id);
      return {
        id,
        number: identity.number,
        label: identity.label,
        health: report.level,
        ready: report.ready,
        agentId: identity.settings.agentId ?? null,
        minecraft: {
          username: mc?.username ?? null,
          authStatus: mc?.authStatus ?? null,
          online: sessions.filter((x) => x.state === 'ONLINE').length,
          sessions: this.repo.listAssignments(id).filter((a) => a.enabled && a.desiredState === 'ONLINE').length,
        },
        sessions: this.repo.listAssignments(id).map((a) => {
          const sess = sessions.find((x) => x.serverId === a.serverId);
          return {
            id: `${id}:${a.serverId}`,
            serverId: a.serverId,
            serverName: this.repo.getServer(a.serverId).name,
            desired: a.desiredState,
            state: sess?.state ?? 'STOPPED',
            lastError: sess?.lastError ?? null,
          };
        }),
        discord: {
          state: d?.oauthState ?? 'NONE',
          linkState: d?.linkState ?? 'UNKNOWN',
          username: d?.username ?? null,
          pendingLinkCode: this.linking.pendingFor(id)?.code ?? null,
        },
        mail: { address: mail?.address ?? null, unread: mail?.unreadCount ?? 0, status: mail?.accessStatus ?? null },
        network: {
          exitLabel: profile?.exitLabel ?? (profile ? `IP #${String(identity.number).padStart(2, '0')}` : null),
          actualIp: profile?.actualPublicIp ?? null,
          expectedIp: profile?.expectedPublicIp ?? null,
          status: profile?.checkStatus ?? null,
        },
        stars: rewards.stars,
        eligible: rewards.eligible,
        tags: identity.settings.ui.tags,
        color: identity.settings.ui.color ?? null,
      };
    });
  }
}
