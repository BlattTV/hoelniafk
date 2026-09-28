/**
 * What an agent accepts from the manager. The agent runs on a PC in someone else's household, so
 * it checks every command itself instead of trusting the manager:
 *  - Minecraft servers and proxies must be public addresses (no access to the household's LAN,
 *    router, NAS or this PC's own services),
 *  - identifiers and game settings are validated (they end up in file paths and launch arguments),
 *  - bind-IP profiles only make sense on the manager's PC.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import type { MainToHost } from '../runtime/protocol.js';
import type { RuntimeSessionSpec } from '../runtime/types.js';
import { assertLoopsTakeTime, validateBlocks, validateTrigger } from '../macros/types.js';

/** Macros from the manager are re-validated on the agent (limits, no tight loops). */
function checkMacros(list: unknown): void {
  if (list === undefined) return;
  if (!Array.isArray(list) || list.length > 100) throw new Error('invalid macro list');
  for (const m of list as any[]) {
    if (!Number.isInteger(m?.id)) throw new Error('invalid macro id');
    validateTrigger(m.trigger);
    assertLoopsTakeTime(validateBlocks(m.blocks));
  }
}

const SESSION_ID = /^\d{1,9}:\d{1,9}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const VERSION = /^(auto|latest-release|latest-snapshot|[0-9A-Za-z][0-9A-Za-z._-]{0,39})$/;
const USERNAME = /^[A-Za-z0-9_]{1,16}$/;

/** True for addresses that must not be reached from an agent (private, loopback, link-local, CGNAT, multicast, …). */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(s);
  }
  return true;
}

async function assertPublicHost(host: string, what: string, allowPrivate: boolean): Promise<void> {
  if (!host || (!net.isIP(host) && !HOSTNAME.test(host))) throw new Error(`${what}: invalid address`);
  if (allowPrivate) return;
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true, verbatim: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`${what} ${host} could not be resolved`);
  if (addrs.some(isPrivateAddress)) throw new Error(`${what} ${host} is a local/private address – agents only connect to public servers`);
}

async function checkSpec(spec: RuntimeSessionSpec, allowPrivate: boolean): Promise<void> {
  if (!SESSION_ID.test(String(spec?.sessionId))) throw new Error('invalid session id');
  if (!USERNAME.test(String(spec.username))) throw new Error('invalid username');
  const port = Number(spec.server?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid server port');
  if (spec.server.version != null && !VERSION.test(String(spec.server.version))) throw new Error('invalid server version');
  await assertPublicHost(String(spec.server.host), 'Server', allowPrivate);
  const p = spec.network?.profile;
  if (p) {
    if (p.kind === 'BIND') throw new Error('Bind-IP network profiles only work on the manager PC – give this identity a proxy or no profile to run it on an agent');
    if (p.kind === 'SOCKS5' || p.kind === 'HTTP') {
      const pp = Number(p.proxyPort);
      if (!Number.isInteger(pp) || pp < 1 || pp > 65535) throw new Error('invalid proxy port');
      await assertPublicHost(String(p.proxyHost), 'Proxy', allowPrivate);
    }
  }
}

/** Returns null when the command may run, else the reason it is refused. */
export async function refuseReason(m: MainToHost, allowPrivate: boolean): Promise<string | null> {
  try {
    if (m.cmd === 'start') {
      await checkSpec(m.spec, allowPrivate);
      checkMacros(m.spec.macros);
    } else if (m.cmd === 'macros.set') {
      if (!SESSION_ID.test(String(m.sessionId))) throw new Error('invalid session id');
      checkMacros(m.macros);
    }
    else if (m.cmd === 'game.open') {
      await checkSpec(m.spec, allowPrivate);
      if (m.spec.sessionId !== m.sessionId) throw new Error('session id mismatch');
      const s = m.settings;
      if (!s || !VERSION.test(String(s.version))) throw new Error('invalid game version');
      if (s.loader !== 'vanilla' && s.loader !== 'fabric') throw new Error('invalid loader');
      if (!Number.isInteger(s.memoryMb) || s.memoryMb < 1024 || s.memoryMb > 32768) throw new Error('invalid game memory');
      if (!USERNAME.test(String(m.auth?.username)) || !/^[0-9a-f-]{0,36}$/i.test(String(m.auth?.uuid ?? ''))) throw new Error('invalid game profile');
    } else if ('sessionId' in m && m.sessionId !== undefined && !SESSION_ID.test(String(m.sessionId))) throw new Error('invalid session id');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
