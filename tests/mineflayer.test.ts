/**
 * Integration: the real mineflayer bot factory connects through the identity's
 * network profile (bind IP) to a local offline-mode minecraft-protocol server.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { mineflayerBotFactory } from '../src/minecraft/mineflayerBot.js';

const require = createRequire(import.meta.url);
const mc = require('minecraft-protocol');

describe('mineflayer session transport', () => {
  it('connects via the bind-IP profile and logs in with the identity username', async () => {
    const server = mc.createServer({ 'online-mode': false, host: '127.0.0.1', port: 0, version: '1.20.1' });
    await new Promise((r) => server.on('listening', r));
    const port = server.socketServer.address().port;
    const seen = new Promise<{ username: string; remote: string }>((resolve) =>
      server.on('login', (client: any) => {
        resolve({ username: client.username, remote: client.socket.remoteAddress });
        client.end('test done');
      }),
    );
    const bot = mineflayerBotFactory({
      identityId: 1,
      server: { id: 1, name: 'local', host: '127.0.0.1', port, version: '1.20.1' },
      username: 'Player01',
      authType: 'offline',
      msaAccount: null,
      cacheFactory: null,
      network: {
        profile: {
          id: 1, identityId: 1, name: 'bind', kind: 'BIND', localBindIp: '127.0.0.1', proxyHost: null, proxyPort: null, proxyUsername: null,
          credentialRef: null, expectedPublicIp: null, actualPublicIp: null, exitLabel: null, checkStatus: 'UNKNOWN', lastCheckedAt: null, lastError: null,
        },
        secret: null,
      },
      onMsaCode: () => {},
    });
    bot.on('error', () => {});
    const result = await seen;
    expect(result.username).toBe('Player01');
    expect(result.remote).toMatch(/127\.0\.0\.1$/);
    bot.quit();
    server.close();
  }, 30000);
});
