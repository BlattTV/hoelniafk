import fs from 'node:fs';
import path from 'node:path';
import { createSuite } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { createKeyProvider } from './vault/keyProviders.js';
import { EncryptedFileVault } from './vault/vault.js';
import { buildServer } from './web/server.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const keyProvider = createKeyProvider(config.vault.keyProvider, path.join(config.dataDir, 'vault.key.dpapi'));
  const store = await EncryptedFileVault.open(path.join(config.dataDir, 'vault.json'), keyProvider);
  const suite = createSuite({ config, store });
  const { app } = await buildServer(suite);
  await app.listen({ host: config.host, port: config.port });
  suite.startAutomation();
  log.info(`Hoelni Client Suite running on http://127.0.0.1:${config.port} (vault: ${suite.vault.backend})`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down…');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await app.close().catch(() => undefined);
    await suite.shutdown().catch((e) => log.error('Shutdown error:', e));
    log.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  log.error('Startup failed:', e);
  process.exit(1);
});
