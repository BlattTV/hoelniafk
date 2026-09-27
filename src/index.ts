import fs from 'node:fs';
import path from 'node:path';
import { createSuite } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { mineflayerBotFactory } from './minecraft/mineflayerBot.js';
import { createKeyProvider } from './vault/keyProviders.js';
import { EncryptedFileVault } from './vault/vault.js';
import { buildServer } from './web/server.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const keyProvider = createKeyProvider(config.vault.keyProvider, path.join(config.dataDir, 'vault.key.dpapi'));
  const store = await EncryptedFileVault.open(path.join(config.dataDir, 'vault.json'), keyProvider);
  const suite = createSuite({ config, store, botFactory: mineflayerBotFactory });
  const { app } = await buildServer(suite);
  await app.listen({ host: config.host, port: config.port });
  suite.startAutomation();
  log.info(`Hoelni Client Suite running on http://127.0.0.1:${config.port} (vault: ${suite.vault.backend})`);

  const stop = async () => {
    log.info('Shutting down…');
    await app.close();
    suite.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  log.error('Startup failed:', e);
  process.exit(1);
});
