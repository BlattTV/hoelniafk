import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';
import { AuditLog } from './core/audit.js';
import { openDatabase, type DB } from './core/db.js';
import { EventBus } from './core/events.js';
import { createLogger } from './core/logger.js';
import { OAuthManager, defaultHttpPost, type HttpPost, type OAuthProviderName } from './core/oauth.js';
import { loadRules, parseRules, type RulesConfig } from './core/rules.js';
import { DiscordService, fetchDiscordUser, type DiscordUserFetcher } from './discord/discordService.js';
import { IdentityRepository } from './identity/repository.js';
import { IdentityService } from './identity/identityService.js';
import { MailService, type SourceFactory } from './mail/mailService.js';
import type { HttpJson } from './mail/aliases/cloudflare.js';
import { MinecraftAuthService, prismarineTokenFetcher, type TokenFetcher } from './minecraft/authService.js';
import { LinkingWorkflow } from './minecraft/linking.js';
import { RewardTracker } from './minecraft/rewards.js';
import { SessionManager, type BotFactory } from './minecraft/sessionManager.js';
import { NetworkService, type IpDetector } from './network/networkService.js';
import { detectPublicIp } from './network/publicIp.js';
import { BulkOperations } from './ops/bulk.js';
import { refs } from './vault/refs.js';
import { Vault, type SecretStore } from './vault/vault.js';

const log = createLogger('suite');

export interface SuiteDeps {
  config?: Partial<AppConfig>;
  db?: DB;
  store: SecretStore;
  rules?: RulesConfig;
  botFactory?: BotFactory;
  ipDetector?: IpDetector;
  tokenFetcher?: TokenFetcher;
  mailSourceFactory?: SourceFactory;
  discordUserFetcher?: DiscordUserFetcher;
  oauthPost?: HttpPost;
  httpJson?: HttpJson;
}

export type Suite = ReturnType<typeof createSuite>;

export function createSuite(deps: SuiteDeps) {
  const config: AppConfig = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) } as AppConfig;
  const db = deps.db ?? openDatabase(path.join(config.dataDir, 'hoelni.db'));
  const bus = new EventBus();
  const audit = new AuditLog(db, bus);
  const vault = new Vault(deps.store);
  const repo = new IdentityRepository(db);

  let rules: RulesConfig = deps.rules ?? (fs.existsSync(config.rulesFile) ? loadRules(config.rulesFile) : parseRules(''));
  const getRules = () => rules;
  const reloadRules = () => {
    rules = loadRules(config.rulesFile);
    audit.record(null, 'Rules reloaded', { mailRules: rules.mailRules.length, chatRules: rules.chatRules.length });
    return rules;
  };

  const oauth = new OAuthManager(
    async (p: OAuthProviderName) => {
      const clientId = repo.getSetting(`oauth.${p}.clientId`) || (config.oauth as any)[p]?.clientId || '';
      if (!clientId) return null;
      const clientSecret = await vault.store.get(refs.app(`oauth-${p}`));
      const tenant = repo.getSetting('oauth.microsoft.tenant') || config.oauth.microsoft.tenant;
      return { clientId, clientSecret, tenant };
    },
    () => `http://127.0.0.1:${config.port}/oauth/callback`,
    deps.oauthPost ?? defaultHttpPost,
  );

  const network = new NetworkService(repo, vault, audit, bus, deps.ipDetector ?? detectPublicIp);
  network.endpoints = config.network.ipEndpoints;
  const auth = new MinecraftAuthService(repo, vault, audit, bus, deps.tokenFetcher ?? prismarineTokenFetcher);
  const linking = new LinkingWorkflow(repo, audit, bus);
  const rewards = new RewardTracker(repo, bus);

  const botFactory: BotFactory =
    deps.botFactory ??
    ((spec) => {
      throw new Error(`No bot factory configured (session for identity ${spec.identityId})`);
    });
  const sessions = new SessionManager(repo, network, auth, linking, rewards, audit, bus, botFactory, getRules);
  const mail = new MailService(repo, vault, oauth, audit, bus, getRules, deps.mailSourceFactory, deps.httpJson);
  mail.syncLimit = config.mail.syncLimit;
  const discord = new DiscordService(repo, vault, oauth, audit, bus, deps.discordUserFetcher ?? fetchDiscordUser);
  const identities = new IdentityService(repo, vault, network, sessions, linking, audit, bus);
  const bulk = new BulkOperations(repo, mail, network, sessions, discord, audit);

  // ----------------------------------------------------------- automation / monitoring
  const timers: NodeJS.Timeout[] = [];
  const everyMinutes = (min: number, name: string, fn: () => Promise<unknown>) => {
    if (!min || min <= 0) return;
    let running = false;
    timers.push(
      setInterval(() => {
        if (running) return;
        running = true;
        fn()
          .catch((e) => log.warn(`${name} failed: ${(e as Error).message}`))
          .finally(() => (running = false));
      }, min * 60_000),
    );
  };

  function startAutomation(): void {
    const a = config.automation;
    everyMinutes(a.mailCheckMinutes, 'mail check', async () => {
      const ids = repo.listIdentities().filter((i) => i.settings.mailEnabled && repo.getMailIdentity(i.id)).map((i) => i.id);
      if (ids.length) await bulk.run('checkMail', ids);
    });
    everyMinutes(a.networkCheckMinutes, 'network check', async () => {
      const ids = repo.listIdentities().filter((i) => i.networkProfileId).map((i) => i.id);
      if (ids.length) await bulk.run('verifyNetwork', ids);
    });
    everyMinutes(a.discordVerifyHours * 60, 'discord verify', async () => {
      const ids = repo.listIdentities().filter((i) => repo.getDiscord(i.id)?.credentialRef).map((i) => i.id);
      if (ids.length) await bulk.run('verifyDiscord', ids);
    });
    if (a.autoStartSessions) {
      for (const i of repo.listIdentities()) {
        sessions.startAll(i.id, true).catch((e) => log.warn(`Auto-start failed for identity ${i.id}: ${(e as Error).message}`));
      }
    }
  }

  function shutdown(): void {
    for (const t of timers) clearInterval(t);
    sessions.stopAll();
    db.close();
  }

  return {
    config,
    db,
    bus,
    audit,
    vault,
    repo,
    oauth,
    network,
    auth,
    linking,
    rewards,
    sessions,
    mail,
    discord,
    identities,
    bulk,
    getRules,
    reloadRules,
    startAutomation,
    shutdown,
  };
}
