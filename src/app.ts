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
import { SessionManager, type SessionManagerOptions } from './minecraft/sessionManager.js';
import { mineflayerBotFactory } from './minecraft/mineflayerBot.js';
import { MineflayerRuntime } from './runtime/mineflayerRuntime.js';
import type { HostBotFactory } from './runtime/host/hostCore.js';
import type { MinecraftRuntime } from './runtime/types.js';
import { NetworkService, type IpDetector } from './network/networkService.js';
import { detectPublicIp } from './network/publicIp.js';
import { BulkOperations } from './ops/bulk.js';
import { MetricsCollector } from './core/metrics.js';
import { Updater } from './ops/updater.js';
import { BackendLink } from './relay/backendLink.js';
import { GameClientRuntime, type GameClientOptions } from './client/gameClientRuntime.js';
import { createWindowController } from './client/window.js';

/** Online SQLite backup into <dataDir>/backups (keeps the newest 7). */
export async function backupDatabase(db: DB, dataDir: string): Promise<string | null> {
  if ((db as any).memory) return null;
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `hoelni-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await db.backup(file);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('hoelni-') && f.endsWith('.db')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 7))) fs.unlinkSync(path.join(dir, f));
  return file;
}
import { refs } from './vault/refs.js';
import { Vault, type SecretStore } from './vault/vault.js';

const log = createLogger('suite');

export interface SuiteDeps {
  config?: Partial<AppConfig>;
  db?: DB;
  store: SecretStore;
  rules?: RulesConfig;
  /** Inline runtime with this bot factory (tests / demo). */
  botFactory?: HostBotFactory;
  /** Fully custom runtime. */
  runtime?: MinecraftRuntime;
  sessionOptions?: Partial<SessionManagerOptions>;
  ipDetector?: IpDetector;
  tokenFetcher?: TokenFetcher;
  mailSourceFactory?: SourceFactory;
  discordUserFetcher?: DiscordUserFetcher;
  oauthPost?: HttpPost;
  httpJson?: HttpJson;
  /** Overrides for the real game client (tests: emulator as java, local mirror). null = disabled. */
  gameClient?: Partial<GameClientOptions> | null;
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
      return {
        clientId,
        clientSecret,
        tenant,
        authorizeUrl: repo.getSetting(`oauth.${p}.authorizeUrl`),
        tokenUrl: repo.getSetting(`oauth.${p}.tokenUrl`),
      };
    },
    () => `http://127.0.0.1:${config.port}/oauth/callback`,
    deps.oauthPost ?? defaultHttpPost,
  );

  const network = new NetworkService(repo, vault, audit, bus, deps.ipDetector ?? detectPublicIp);
  network.endpoints = config.network.ipEndpoints;
  const auth = new MinecraftAuthService(repo, vault, audit, bus, deps.tokenFetcher ?? prismarineTokenFetcher);
  const linking = new LinkingWorkflow(repo, audit, bus);
  const rewards = new RewardTracker(repo, bus);

  const rc = config.runtime;
  const runtime: MinecraftRuntime =
    deps.runtime ??
    new MineflayerRuntime({
      mode: deps.botFactory ? 'inline' : rc.mode,
      botFactory: deps.botFactory ?? mineflayerBotFactory,
      sessionsPerHost: rc.sessionsPerHost,
      grouping: rc.grouping,
      heartbeatMs: rc.heartbeatMs,
      heartbeatTimeoutMs: rc.heartbeatTimeoutMs,
      idleHostTtlMs: rc.idleHostTtlMs,
      authProvider: (identityId) => auth.getJavaSession(identityId),
    });
  const sessions = new SessionManager(repo, network, runtime, linking, rewards, audit, bus, getRules, {
    reconcileIntervalMs: config.sessions.reconcileIntervalMs,
    maxConcurrentStarts: config.sessions.maxConcurrentStarts,
    ...(deps.sessionOptions ?? {}),
  });
  let game: GameClientRuntime | null = null;
  if (deps.gameClient !== null && config.client.enabled) {
    const cc = config.client;
    game = new GameClientRuntime({
      rootDir: cc.rootDir || path.join(config.dataDir, 'minecraft'),
      instancesDir: cc.instancesDir || path.join(config.dataDir, 'instances'),
      javaPath: cc.javaPath || undefined,
      mirrors: cc.mirrors,
      onlineAfterMs: cc.onlineAfterMs,
      joinTimeoutMs: cc.joinTimeoutMs,
      authProvider: (identityId) => auth.getJavaSession(identityId),
      window: deps.gameClient?.window ?? createWindowController(),
      ...(deps.gameClient ?? {}),
    });
    sessions.attachGameClient(game);
  }
  const mail = new MailService(repo, vault, oauth, audit, bus, getRules, deps.mailSourceFactory, deps.httpJson);
  mail.syncLimit = config.mail.syncLimit;
  const discord = new DiscordService(repo, vault, oauth, audit, bus, deps.discordUserFetcher ?? fetchDiscordUser);
  const identities = new IdentityService(repo, vault, network, sessions, linking, audit, bus);
  const bulk = new BulkOperations(repo, mail, network, sessions, discord, audit, auth);
  const updater = new Updater(repo, audit, bus);
  const backend = new BackendLink(repo, vault, audit, bus, runtime instanceof MineflayerRuntime ? runtime : null);
  updater.autoInstallAllowed = () => !sessions.list().some((s) => s.runtime === 'game' || s.takeover !== 'none');
  const metrics = new MetricsCollector(sessions, runtime, 180, () => game?.stats().hosts ?? []);

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
    everyMinutes(a.tokenRefreshHours * 60, 'token refresh', async () => {
      // Keeps Microsoft refresh tokens alive (they expire after long inactivity).
      for (const i of repo.listIdentities()) {
        const mc = repo.getMinecraft(i.id);
        if (mc?.authType === 'microsoft' && mc.credentialRef) await auth.authenticate(i.id).catch(() => undefined);
      }
    });
    everyMinutes(60, 'log pruning', async () => repo.pruneLogs());
    everyMinutes(24 * 60, 'database backup', () => backupDatabase(db, config.dataDir));
    // Desired-state reconciler: restores every session that should be online.
    if (a.restoreSessions) sessions.startReconciler();
    metrics.start();
    updater.start(config.updates?.checkHours ?? 6);
    void backend.start();
  }

  let closed = false;
  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const t of timers) clearInterval(t);
    metrics.stop();
    updater.stop();
    backend.shutdown();
    await sessions.shutdown();
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
    runtime,
    game,
    updater,
    backend,
    sessions,
    mail,
    discord,
    identities,
    bulk,
    metrics,
    getRules,
    reloadRules,
    startAutomation,
    shutdown,
  };
}
