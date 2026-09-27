import mineflayer from 'mineflayer';
import { openSocket, resolveMinecraftTarget } from '../network/connector.js';
import type { BotFactory, BotLike } from './sessionManager.js';

/**
 * Real bot factory based on mineflayer. The TCP connection (including the
 * version-detection ping) is always opened through the identity's own network
 * profile, and the token cache is the identity-scoped vault cache.
 */
export const mineflayerBotFactory: BotFactory = (spec) => {
  const { network, server } = spec;
  const bot = mineflayer.createBot({
    host: server.host,
    port: server.port,
    username: spec.username,
    auth: spec.authType,
    version: server.version || undefined,
    profilesFolder: (spec.cacheFactory ?? undefined) as any,
    onMsaCode: spec.onMsaCode as any,
    hideErrors: true,
    checkTimeoutInterval: 60_000,
    connect: (client: any) => {
      resolveMinecraftTarget(server.host, server.port)
        .then((target) => openSocket(network.profile, network.secret, target))
        .then((socket) => {
          client.setSocket(socket);
          client.emit('connect');
        })
        .catch((err) => {
          client.emit('error', err);
          client.emit('end', 'connectFailed');
        });
    },
  } as any) as unknown as BotLike & { look: Function; swingArm: Function; setControlState: Function; entity?: any };

  bot.antiAfk = (action) => {
    if (action === 'look') {
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = (Math.random() - 0.5) * 0.6;
      (bot as any).look(yaw, pitch, false);
    } else if (action === 'swing') {
      (bot as any).swingArm('right');
    } else if (action === 'jump') {
      (bot as any).setControlState('jump', true);
      setTimeout(() => (bot as any).setControlState('jump', false), 400);
    }
  };
  return bot;
};
