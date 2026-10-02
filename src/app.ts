import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';
import { AuditLog } from './core/audit.js';
import { openDatabase, type DB } from './core/db.js';
import { EventBus } from './core/events.js';
import { createLogger } from './core/logger.js';
import { loadRules, parseRules, type RulesConfig } from './core/rules.js';
import { DiscordService } from './discord/discordService.js';
import { detectServerVersion, PROXY_FALLBACK_VERSION } from './client/instance.js';
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
import { ProxyPool } from './network/proxyPool.js';
import { MicrosoftAccountService } from './identity/microsoftAccount.js';
import { AccountService } from './identity/accountService.js';
import { MacroService } from './macros/service.js';
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
import { SnapshotIO } from './sync/snapshot.js';
import { SyncService } from './sync/syncService.js';

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

  const network = new NetworkService(repo, vault, audit, bus, deps.ipDetector ?? detectPublicIp);
  network.endpoints = config.network.ipEndpoints;
  const proxies = new ProxyPool(db, repo, vault, network, audit, bus, deps.ipDetector ?? detectPublicIp, () => network.endpoints);
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
  const mail = new MailService(repo, vault, audit, bus, getRules, deps.mailSourceFactory, deps.httpJson);
  mail.syncLimit = config.mail.syncLimit;
  const discord = new DiscordService(repo, vault, audit, bus);
  const identities = new IdentityService(repo, vault, network, sessions, linking, audit, bus);
  const bulk = new BulkOperations(repo, mail, network, sessions, discord, audit, auth);
  const updater = new Updater(repo, audit, bus);
  const accounts = new AccountService(repo, vault, auth, audit, bus);
  identities.beforeDelete = (id) => accounts.releaseIdentity(id);
  discord.accounts = accounts;
  const microsoft = new MicrosoftAccountService(repo, auth, audit, bus, accounts);
  sessions.renewAuth = (identityId) => auth.renew(identityId);
  // Real servers only (tests with fake bots have no server to ping): see SessionManager.autoVersion
  if (!deps.botFactory && !deps.runtime) sessions.detectVersion = (host, port, network) => detectServerVersion(host, port, network);
  sessions.proxyFallbackVersion = PROXY_FALLBACK_VERSION;
  // One-time: chat kicks behind Velocity were caused by unanswered cookie requests, not by signing –
  // undo the automatic switch to unsigned chat made before that was fixed.
  if (!repo.getSetting('compat.cookies')) {
    for (const srv of repo.listServers()) if (repo.getSetting(`server.${srv.id}.unsignedChat`)) repo.setSetting(`server.${srv.id}.unsignedChat`, '');
    repo.setSetting('compat.cookies', '1');
  }
  const macros = new MacroService(db, runtime, audit, bus);
  sessions.macrosFor = (identityId, serverId) => macros.forSession(identityId, serverId);
  macros.runningSessions = () =>
    sessions
      .list()
      .filter((x) => ['ONLINE', 'CONNECTING', 'AUTHENTICATING', 'STARTING'].includes(x.state))
      .map((x) => ({ sessionId: x.id, identityId: x.identityId, serverId: x.serverId }));
  const backend = new BackendLink(repo, vault, audit, bus, runtime instanceof MineflayerRuntime ? runtime : null);
  backend.onAgentAvailable = (agentId) => sessions.agentAvailable(agentId);
  updater.authHeaders = (url) => backend.authHeadersFor(url);
  backend.onConnected = () => void updater.adoptBackend(backend.updatesUrl).catch(() => undefined);
  updater.autoInstallAllowed = () => !sessions.list().some((s) => s.runtime === 'game' || s.takeover !== 'none');
  // Several PCs of one backend account: only the active one runs the sessions (the others are in
  // standby) – and all of them share identities and settings (encrypted settings sync).
  backend.onRoleChanged = (reason) => sessions.setStandby(reason);
  // remote control: the active PC sends live events to its controllers; a standby PC shows those of the active one
  bus.on((ev) => backend.forwardEvent(ev as any));
  backend.onRemoteEvent = (ev) => bus.emit({ ...(ev as any), remote: true });
  if (repo.getSetting('backend.standbyFor') && repo.getSetting('backend.username')) sessions.setStandby(`the sessions run on "${repo.getSetting('backend.standbyFor')}"`);
  const sync = new SyncService(
    new SnapshotIO(db, vault.store, { deleteIdentity: (id) => identities.delete(id) }),
    repo,
    vault,
    backend,
    bus,
    audit,
    () => {
      void sessions.reconcile();
      macros.pushToSessions();
    },
  );
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
    everyMinutes(a.tokenRefreshHours * 60, 'token refresh', async () => {
      // Keeps Microsoft refresh tokens alive (they expire after long inactivity). In standby the
      // active PC does it (the tokens come over with the settings sync).
      if (sessions.standby) return;
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
    sync.start();
  }

  let closed = false;
  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const t of timers) clearInterval(t);
    metrics.stop();
    updater.stop();
    sync.stop();
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
    network,
    proxies,
    microsoft,
    accounts,
    macros,
    auth,
    linking,
    rewards,
    runtime,
    game,
    updater,
    backend,
    sync,
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
