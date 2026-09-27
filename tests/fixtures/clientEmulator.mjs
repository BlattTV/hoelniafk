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
 *     real Minecraft protocol (minecraft-protocol) – i.e. through the local forwarder
 *   - writes logs/latest.log in the vanilla format ("[CHAT] …", disconnect reason)
 *   - stays open after a disconnect (like the game's disconnect screen) until closed
 *
 * EMULATOR_EXIT_AFTER_MS: exit on its own (simulates the user closing the game).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mc = require('minecraft-protocol');

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
} else {
  log('Render thread', 'INFO', `Connecting to ${host}, ${port}`);
  const client = mc.createClient({ host, port, username, auth: 'offline', version: gameVersion, hideErrors: true });
  const flatten = (c) => {
    if (c == null) return '';
    if (typeof c === 'string') {
      try {
        return flatten(JSON.parse(c));
      } catch {
        return c;
      }
    }
    if (typeof c !== 'object') return String(c);
    if (c.type === 'compound' || c.value) return flatten(simplify(c));
    return (c.text ?? '') + (c.translate ?? '') + (Array.isArray(c.extra) ? c.extra.map(flatten).join('') : '') + (Array.isArray(c.with) ? ' ' + c.with.map(flatten).join(' ') : '');
  };
  const simplify = (n) => {
    try {
      return require('prismarine-nbt').simplify(n);
    } catch {
      return n;
    }
  };
  client.on('packet', (data, meta) => {
    if (meta.name === 'system_chat') log('Render thread', 'INFO', `[System] [CHAT] ${flatten(data.content ?? data.formattedMessage)}`);
    else if (meta.name === 'player_chat') log('Render thread', 'INFO', `[CHAT] ${flatten(data.unsignedChatContent) || data.plainMessage || ''}`);
    else if (meta.name === 'chat') log('Render thread', 'INFO', `[CHAT] ${flatten(data.message)}`);
  });
  client.on('kick_disconnect', (p) => log('Render thread', 'INFO', `Client disconnected with reason: ${flatten(p.reason)}`));
  client.on('login', () => log('Render thread', 'INFO', 'Joined world (emulated)'));
  client.on('end', (reason) => log('Render thread', 'INFO', `Connection lost: ${reason ?? 'closed'}`));
  client.on('error', (e) => log('Render thread', 'ERROR', `Network error: ${e.message}`));
}

const quit = () => {
  log('Render thread', 'INFO', 'Stopping!');
  process.exit(0);
};
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
if (process.env.EMULATOR_EXIT_AFTER_MS) setTimeout(quit, Number(process.env.EMULATOR_EXIT_AFTER_MS));
setInterval(() => undefined, 1 << 30);
