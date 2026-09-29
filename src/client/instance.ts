/**
 * Per-session game instance helpers: game directory, options.txt defaults,
 * latest.log tailing, offline UUIDs and server version detection.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildHandshake, readVarInt, writeVarInt } from './forwarder.js';
import { openSocket, resolveMinecraftTarget, type ProxySecret } from '../network/connector.js';
import type { NetworkProfile } from '../core/types.js';

const require = createRequire(import.meta.url);

/**
 * Settings written to options.txt before every launch. They make an unattended
 * client behave: no pause menu on focus loss (Alt-Tab keeps the game running),
 * no first-start tutorial / accessibility onboarding / multiplayer warning.
 */
export const FORCED_OPTIONS: Record<string, string> = {
  pauseOnLostFocus: 'false',
  onboardAccessibility: 'false',
  skipMultiplayerWarning: 'true',
  joinedFirstServer: 'true',
  tutorialStep: 'none',
};

/** Defaults only applied when options.txt does not contain the key yet. */
export const DEFAULT_OPTIONS: Record<string, string> = {
  renderDistance: '8',
  simulationDistance: '8',
  maxFps: '60',
  inactivityFpsLimit: '"minimized"',
  narrator: '0',
  soundCategory_master: '0.5',
  lang: 'de_de',
};

export function writeOptions(gameDir: string, forced = FORCED_OPTIONS, defaults = DEFAULT_OPTIONS): void {
  fs.mkdirSync(gameDir, { recursive: true });
  const file = path.join(gameDir, 'options.txt');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const map = new Map<string, string>();
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) map.set(l.slice(0, i), l.slice(i + 1));
  }
  for (const [k, v] of Object.entries(defaults)) if (!map.has(k)) map.set(k, v);
  for (const [k, v] of Object.entries(forced)) map.set(k, v);
  fs.writeFileSync(file, [...map].map(([k, v]) => `${k}:${v}`).join('\n') + '\n');
}

/** UUID the vanilla server assigns to offline players ("OfflinePlayer:<name>", v3). */
export function offlineUuid(name: string): string {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex');
}

// ---------------------------------------------------------------- log tail

export type LogLine = { type: 'chat'; text: string } | { type: 'disconnect'; reason: string } | { type: 'connecting'; target: string } | { type: 'error'; text: string };

const CHAT_RE = /\[CHAT\]\s?(.*)$/;
const DISCONNECT_RES = [/Client disconnected with reason:\s*(.*)$/i, /Disconnected from server(?::\s*(.*))?$/i, /Connection lost:\s*(.*)$/i, /\[KICK\]\s*(.*)$/];
const CONNECTING_RE = /Connecting to (.+?), (\d+)\s*$/;

export function parseLogLine(line: string): LogLine | null {
  let m = CHAT_RE.exec(line);
  if (m) return { type: 'chat', text: m[1].replace(/§./g, '') };
  for (const re of DISCONNECT_RES) {
    m = re.exec(line);
    if (m) return { type: 'disconnect', reason: (m[1] ?? 'disconnected').trim() };
  }
  m = CONNECTING_RE.exec(line);
  if (m) return { type: 'connecting', target: `${m[1]}:${m[2]}` };
  if (/\/(ERROR|FATAL)\]:/.test(line)) return { type: 'error', text: line.slice(0, 300) };
  return null;
}

/** Polls a growing text file (log4j keeps it open; reading shared is fine on Windows). */
export class LogTail {
  private offset = 0;
  private rest = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly onLine: (line: string) => void,
    private readonly intervalMs = 400,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  poll(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return;
    }
    if (st.size < this.offset) {
      this.offset = 0;
      this.rest = '';
    }
    if (st.size === this.offset) return;
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = Math.min(st.size - this.offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += len;
      const text = this.rest + buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      this.rest = lines.pop() ?? '';
      for (const l of lines) if (l) this.onLine(l);
    } finally {
      fs.closeSync(fd);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.poll();
  }
}

// ---------------------------------------------------------------- server version

export interface ServerStatus {
  versionName: string;
  protocol: number;
}

/** Server list ping through the identity's network profile (never directly). */
export async function pingServer(host: string, port: number, network: { profile: NetworkProfile | null; secret: ProxySecret | null }, timeoutMs = 8000, protocol = 0x7fffffff): Promise<ServerStatus> {
  const target = await resolveMinecraftTarget(host, port);
  const socket = await openSocket(network.profile, network.secret, target, timeoutMs);
  return new Promise<ServerStatus>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Status ping timed out'));
    }, timeoutMs);
    let buf = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const len = readVarInt(buf, 0);
      if (!len || buf.length < len.size + len.value) return;
      let o = len.size;
      const id = readVarInt(buf, o)!;
      o += id.size;
      const sl = readVarInt(buf, o)!;
      o += sl.size;
      clearTimeout(timer);
      socket.destroy();
      try {
        const json = JSON.parse(buf.subarray(o, o + sl.value).toString('utf8'));
        resolve({ versionName: String(json.version?.name ?? ''), protocol: Number(json.version?.protocol ?? -1) });
      } catch (e) {
        reject(e as Error);
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    // handshake (protocol -1 = "unknown", next state 1 = status) + status request
    const hs = buildHandshake({ protocol, host, port, nextState: 1 });
    socket.write(Buffer.concat([hs, writeVarInt(1), writeVarInt(0)]));
  });
}

/** Version used behind a proxy when the backend version cannot be seen (widely supported; corrected from kicks). */
export const PROXY_FALLBACK_VERSION = '1.21.1';

export interface DetectedVersion {
  version: string | null;
  /** The address answers with whatever version it is asked with (Velocity / BungeeCord without ping passthrough). */
  proxy: boolean;
  name: string;
}

const protocolOf = (v: string): number => {
  try {
    return Number(require('minecraft-data')(v)?.version?.version ?? -1);
  } catch {
    return -1;
  }
};

/**
 * Server version for new connections. A plain server reports its own version. A proxy like Velocity
 * mirrors the protocol it is asked with – then the backend version is unknown: a version from the
 * status name is used if there is one (e.g. "Paper 1.21.4"), otherwise none (caller falls back).
 */
export async function detectServerVersion(host: string, port: number, network: { profile: NetworkProfile | null; secret: ProxySecret | null }, timeoutMs = 8000): Promise<DetectedVersion> {
  const pa = protocolOf('1.20.4');
  const pb = protocolOf('1.21.4');
  const a = await pingServer(host, port, network, timeoutMs, pa);
  const b = await pingServer(host, port, network, timeoutMs, pb);
  if (pa > 0 && pb > 0 && a.protocol === pa && b.protocol === pb) {
    const m = /\b(1\.\d+(?:\.\d+)?)\b/.exec(b.versionName);
    return { version: m ? m[1] : null, proxy: true, name: b.versionName };
  }
  return { version: versionForProtocol(b.protocol, b.versionName), proxy: false, name: b.versionName };
}

/** "Outdated client! Please use 1.21.4" / "Outdated server! I'm still on 1.20.1" → the version the server wants. */
export function versionFromKick(text: string | null | undefined): string | null {
  const t = String(text ?? '');
  if (!/outdated|please use|still on|incompatible|unsupported (client )?version/i.test(t)) return null;
  const m = /(?:please use|still on|running|requires?|version)\s*:?\s*(?:minecraft\s*)?(1\.\d+(?:\.\d+)?|\d{2}\.\d+(?:\.\d+)?)/i.exec(t) ?? /\b(1\.\d+(?:\.\d+)?)\b/.exec(t);
  return m ? m[1] : null;
}

/** Maps a protocol number to the newest release version using it (minecraft-data). */
export function versionForProtocol(protocol: number, versionName = ''): string | null {
  try {
    const md = require('minecraft-data');
    const list: Array<{ minecraftVersion: string; releaseType?: string }> = md.postNettyVersionsByProtocolVersion.pc[protocol] ?? [];
    const release = list.find((v) => v.releaseType === 'release') ?? list[0];
    if (release) return release.minecraftVersion;
  } catch {
    /* minecraft-data unavailable */
  }
  const m = /\b(1\.\d+(?:\.\d+)?|\d{2}\.\d+(?:\.\d+)?)\b/.exec(versionName);
  return m ? m[1] : null;
}
