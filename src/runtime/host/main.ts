/**
 * Entry point of a runtime host child process (forked by MineflayerRuntime).
 * Any uncaught error terminates only this host; the supervisor in the main
 * process restarts it and the reconciler brings the sessions back online.
 */
import { mineflayerBotFactory } from '../../minecraft/mineflayerBot.js';
import type { HostChannel, HostToMain, MainToHost } from '../protocol.js';
import { RuntimeHostCore } from './hostCore.js';

if (!process.send) {
  console.error('runtime host must be started via child_process.fork');
  process.exit(2);
}

const channel: HostChannel = {
  send: (msg: HostToMain) => {
    if (process.connected) process.send!(msg);
  },
  onMessage: (listener) => process.on('message', (m) => listener(m as MainToHost)),
};

process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (err) => {
  channel.send({ evt: 'log', level: 'error', message: `Runtime host crashed: ${err?.stack ?? err}` });
  setTimeout(() => process.exit(1), 50);
});
process.on('unhandledRejection', (err) => {
  channel.send({ evt: 'log', level: 'warn', message: `Unhandled rejection in runtime host: ${(err as Error)?.message ?? err}` });
});

new RuntimeHostCore(channel, mineflayerBotFactory, { exitOnCrash: true, heartbeatMs: Number(process.env.HOELNI_HOST_HEARTBEAT_MS ?? 5000) });
