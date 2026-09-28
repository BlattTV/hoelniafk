import fs from 'node:fs';
import path from 'node:path';
import { createSuite } from './app.js';
import { loadConfig } from './config.js';
import { createLogger, setLogLevel, setupFileLogging } from './core/logger.js';
import { createKeyProvider } from './vault/keyProviders.js';
import { EncryptedFileVault } from './vault/vault.js';
import { buildServer } from './web/server.js';
import { RESTART_FOR_UPDATE } from './ops/updateApply.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  setLogLevel(config.logging.level);
  if (config.logging.file) setupFileLogging(path.join(config.dataDir, 'logs'), config.logging.maxFileMb, config.logging.keepFiles);
  process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err as Error));
  process.on('uncaughtException', (err) => {
    // State is persisted (desired sessions, vault); the supervisor restarts us and the reconciler restores sessions.
    log.error('Uncaught exception – exiting for a clean restart:', err);
    setTimeout(() => process.exit(1), 200);
  });
  const keyProvider = createKeyProvider(config.vault.keyProvider, path.join(config.dataDir, 'vault.key.dpapi'));
  const store = await EncryptedFileVault.open(path.join(config.dataDir, 'vault.json'), keyProvider);
  const suite = createSuite({ config, store });
  const { app } = await buildServer(suite);
  await app.listen({ host: config.host, port: config.port });
  suite.startAutomation();
  log.info(`Hoelni Client Suite running on http://127.0.0.1:${config.port} (vault: ${suite.vault.backend})`);

  let stopping = false;
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    log.info(exitCode === RESTART_FOR_UPDATE ? 'Restarting to install the update…' : 'Shutting down…');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await app.close().catch(() => undefined);
    await suite.shutdown().catch((e) => log.error('Shutdown error:', e));
    log.info('Shutdown complete');
    process.exit(exitCode);
  };
  suite.updater.restart = () => stop(RESTART_FOR_UPDATE);
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('message', (m: any) => {
    if (m?.cmd === 'shutdown') void stop();
  });
}

main().catch((e) => {
  log.error('Startup failed:', e);
  process.exit(1);
});
