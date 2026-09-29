#!/usr/bin/env node
/**
 * Test stand-in for `java … net.minecraft.client.main.Main …`.
 *
 * The build environment cannot download or run the real Minecraft client, so the
 * launcher tests install this script as the "Java runtime". It receives exactly
 * the command line the launcher builds and behaves like the game where the suite
 * can observe it:
 *   - verifies the classpath / natives directory / asset index exist (launcher output)
 *   - joins the server given by --quickPlayMultiplayer or --server/--port with the
 *     real Minecraft protocol (mineflayer: teleport confirms, chunk batches, keep-alives
 *     like the game) – through the local forwarder or the live-takeover endpoint
 *   - writes emulator-state.json (spawned, position, chunks, players, inventory …)
 *   - writes logs/latest.log in the vanilla format ("[CHAT] …", disconnect reason)
 *   - stays open after a disconnect (like the game's disconnect screen) until closed
 *
 * EMULATOR_EXIT_AFTER_MS: exit on its own (simulates the user closing the game).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const gameDir = opt('--gameDir') ?? process.cwd();
const logDir = path.join(gameDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'latest.log');
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (thread, level, msg) => fs.appendFileSync(logFile, `[${ts()}] [${thread}/${level}]: ${msg}\n`);

// --- launcher output checks -------------------------------------------------------
const problems = [];
const cpIdx = argv.indexOf('-cp');
const cp = cpIdx >= 0 ? argv[cpIdx + 1] : '';
if (!cp) problems.push('no classpath');
for (const entry of cp.split(path.delimiter).filter(Boolean)) if (!fs.existsSync(entry)) problems.push(`missing classpath entry ${entry}`);
const nativesArg = argv.find((a) => a.startsWith('-Djava.library.path='));
if (!nativesArg || !fs.existsSync(nativesArg.split('=')[1])) problems.push('natives directory missing');
const assetsDir = opt('--assetsDir');
const assetIndex = opt('--assetIndex');
if (!assetsDir || !fs.existsSync(path.join(assetsDir, 'indexes', `${assetIndex}.json`))) problems.push('asset index missing');
for (const need of ['--username', '--version', '--accessToken', '--uuid']) if (!opt(need)) problems.push(`argument ${need} missing`);
if (argv.some((a) => /\$\{[a-z_]+\}/i.test(a))) problems.push('unsubstituted placeholder');
if (problems.length) {
  console.error(`Emulator: invalid launch – ${problems.join('; ')}`);
  process.exit(3);
}

const username = opt('--username');
const versionId = opt('--version');
const gameVersion = /(\d+\.\d+(?:\.\d+)?)$/.exec(versionId)?.[1] ?? '1.20.1';
let host;
let port;
const qp = opt('--quickPlayMultiplayer');
if (qp) {
  const i = qp.lastIndexOf(':');
  host = qp.slice(0, i);
  port = Number(qp.slice(i + 1));
} else {
  host = opt('--server');
  port = Number(opt('--port') ?? 25565);
}
fs.writeFileSync(path.join(gameDir, 'emulator-args.json'), JSON.stringify({ argv, pid: process.pid }, null, 1));
log('main', 'INFO', `Setting user: ${username}`);
log('Render thread', 'INFO', `Backend library: LWJGL version 3.3.1 (emulated, ${gameVersion})`);
if (!host) {
  log('Render thread', 'INFO', 'No server given – staying in the title screen');
} else if (fs.existsSync(path.join(gameDir, 'reject-once.txt'))) {
  // like the real client when the server's configuration cannot be decoded: error screen, still running
  const reason = fs.readFileSync(path.join(gameDir, 'reject-once.txt'), 'utf8');
  fs.rmSync(path.join(gameDir, 'reject-once.txt'));
  log('Render thread', 'INFO', `Connecting to ${host}, ${port}`);
  setTimeout(() => log('Render thread', 'WARN', `Client disconnected with reason: ${reason}`), 800);
} else {
  log('Render thread', 'INFO', `Connecting to ${host}, ${port}`);
  // mineflayer behaves like a vanilla client on the wire (teleport confirms, chunk batches, keep-alives)
  const mineflayer = require('mineflayer');
  const bot = mineflayer.createBot({ host, port, username, auth: 'offline', version: gameVersion, hideErrors: true, physicsEnabled: true, checkTimeoutInterval: 60_000 });
  const stateFile = path.join(gameDir, 'emulator-state.json');
  const writeState = () => {
    try {
      const inv = bot.inventory?.items?.() ?? [];
      fs.writeFileSync(stateFile, JSON.stringify({
        spawned, uuid: bot.player?.uuid ?? null, entityId: bot.entity?.id ?? null,
        position: bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
        chunks: bot.world ? Object.keys(bot.world.async?.columns ?? {}).length : 0,
        blockBelow: bot.entity?.position ? bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name ?? null : null,
        players: Object.keys(bot.players ?? {}), entities: Object.keys(bot.entities ?? {}).length,
        inventory: inv.map((i) => `${i.name}x${i.count}`), health: bot.health ?? null, gameMode: bot.game?.gameMode ?? null,
        dimension: bot.game?.dimension ?? null, logins, ended, messages: messages.slice(-10), ts: Date.now(),
      }));
    } catch {}
  };
  let spawned = false;
  let logins = 0;
  let ended = false;
  const messages = [];
  bot.on('login', () => {
    logins++;
    log('Render thread', 'INFO', 'Joined world (emulated)');
  });
  bot.once('spawn', () => {
    spawned = true;
    writeState();
    const actions = (process.env.EMULATOR_ACTIONS ?? '').split('|').filter(Boolean);
    let delay = 500;
    for (const a of actions) {
      const [kind, arg] = a.split(':');
      setTimeout(() => {
        if (kind === 'chat') bot.chat(arg);
        if (kind === 'walk') {
          bot.setControlState('forward', true);
          setTimeout(() => bot.setControlState('forward', false), Number(arg));
        }
        if (kind === 'quit') bot.quit();
        if (kind === 'fail') {
          // like the real client when a packet cannot be read: error screen, connection dropped
          log('Render thread', 'INFO', 'Client disconnected with reason: Network Protocol Error');
          bot.quit();
        }
      }, delay);
      delay += kind === 'walk' ? Number(arg) + 500 : 700;
    }
  });
  setInterval(writeState, 300).unref();
  bot.on('messagestr', (text, position) => {
    if (position !== 'game_info') messages.push(String(text));
    if (position !== 'game_info') log('Render thread', 'INFO', `[System] [CHAT] ${text}`);
  });
  bot.on('kicked', (reason) => log('Render thread', 'INFO', `Client disconnected with reason: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
  bot.on('end', (reason) => {
    log('Render thread', 'INFO', `Connection lost: ${reason ?? 'closed'}`);
    spawned = false;
    ended = true;
    writeState();
  });
  bot.on('error', (e) => log('Render thread', 'ERROR', `Network error: ${e.message}`));
}

const quit = () => {
  log('Render thread', 'INFO', 'Stopping!');
  process.exit(0);
};
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
if (process.env.EMULATOR_EXIT_AFTER_MS) setTimeout(quit, Number(process.env.EMULATOR_EXIT_AFTER_MS));
setInterval(() => undefined, 1 << 30);
