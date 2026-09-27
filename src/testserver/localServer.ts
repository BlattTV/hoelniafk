/**
 * Local Minecraft test server (flying-squid, offline mode) with a small
 * "Hoelni" plugin that emits the kind of messages the real server sends:
 *
 *   join            → "Link your account using code ABC123"   (until linked)
 *   /link           → "Discord linked successfully" + "Rewards: Discord linked"
 *   every N sec     → "You received 1 star" (linked players only), "You have N stars"
 *   /stars          → "You have N stars"
 *   /claim          → "Reward received!"
 *
 * Used for LOCAL INTEGRATION tests, the demo and performance measurements.
 * It is NOT a replacement for tests against the real server.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface LocalServerOptions {
  port: number;
  version?: string;
  motd?: string;
  /** Interval for automatic star rewards (0 = off). */
  starIntervalSec?: number;
  hoelniPlugin?: boolean;
  quiet?: boolean;
  viewDistance?: number;
}

export interface LocalServer {
  port: number;
  version: string;
  players(): string[];
  broadcast(text: string): void;
  say(username: string, text: string): boolean;
  kick(username: string, reason: string): boolean;
  /** Drops all connections without a kick packet (simulates a crash/network loss). */
  dropAll(): void;
  linked: Set<string>;
  stars: Map<string, number>;
  /** Remote (source) address of a connected player – used to verify bind-IP routing. */
  _remoteOf(username: string): string | undefined;
  close(): Promise<void>;
}

export async function startLocalServer(opts: LocalServerOptions): Promise<LocalServer> {
  const mcServer = require('flying-squid');
  const version = opts.version ?? '1.20.1';
  const restoreLog = opts.quiet !== false ? silenceConsole() : () => undefined;
  const serv = mcServer.createMCServer({
    motd: opts.motd ?? 'Hoelni local test server',
    port: opts.port,
    'max-players': 500,
    'online-mode': false,
    logging: false,
    gameMode: 0,
    difficulty: 0,
    generation: { name: 'superflat', options: { worldHeight: 80 } },
    kickTimeout: 30000,
    plugins: {},
    modpe: false,
    'view-distance': opts.viewDistance ?? 2,
    'player-list-text': { header: 'Hoelni', footer: 'local' },
    'everybody-op': false,
    'max-entities': 20,
    version,
  });
  await new Promise<void>((resolve, reject) => {
    serv.once('listening', () => resolve());
    serv.once('error', reject);
  });

  const linked = new Set<string>();
  const stars = new Map<string, number>();
  const codes = new Map<string, string>();
  const findPlayer = (name: string) => serv.players.find((p: any) => p.username === name);

  if (opts.hoelniPlugin !== false) {
    serv.on('newPlayer', (player: any) => {
      setTimeout(() => {
        if (!serv.players.includes(player)) return;
        if (!linked.has(player.username)) {
          const code = codes.get(player.username) ?? Math.random().toString(36).slice(2, 8).toUpperCase();
          codes.set(player.username, code);
          player.chat(`Link your account using code ${code}`);
          player.chat('Link your Discord to receive rewards');
        } else {
          player.chat('Rewards: Discord linked');
        }
        player.chat(`You have ${stars.get(player.username) ?? 0} stars`);
      }, 1200);
    });
    serv.commands.add({
      base: 'link',
      info: 'link Discord (test)',
      usage: '/link',
      onlyPlayer: true,
      action(_p: unknown, ctx: any) {
        linked.add(ctx.player.username);
        ctx.player.chat('Discord linked successfully');
        ctx.player.chat('Rewards: Discord linked');
      },
    });
    serv.commands.add({
      base: 'stars',
      info: 'show stars (test)',
      usage: '/stars',
      onlyPlayer: true,
      action(_p: unknown, ctx: any) {
        ctx.player.chat(`You have ${stars.get(ctx.player.username) ?? 0} stars`);
      },
    });
    serv.commands.add({
      base: 'claim',
      info: 'claim reward (test)',
      usage: '/claim',
      onlyPlayer: true,
      action(_p: unknown, ctx: any) {
        if (!linked.has(ctx.player.username)) ctx.player.chat('Reward pending – link your Discord first');
        else ctx.player.chat('Reward received!');
      },
    });
  }

  let timer: NodeJS.Timeout | null = null;
  if (opts.starIntervalSec && opts.starIntervalSec > 0) {
    timer = setInterval(() => {
      for (const p of serv.players as any[]) {
        if (!linked.has(p.username)) continue;
        const n = (stars.get(p.username) ?? 0) + 1;
        stars.set(p.username, n);
        p.chat('You received 1 star');
        p.chat(`You have ${n} stars`);
      }
    }, opts.starIntervalSec * 1000);
    timer.unref?.();
  }

  return {
    port: opts.port,
    version,
    _remoteOf: (name: string) => findPlayer(name)?._client?.socket?.remoteAddress,
    linked,
    stars,
    players: () => (serv.players as any[]).map((p) => p.username),
    broadcast: (text) => serv.broadcast(text),
    say: (username, text) => {
      const p = findPlayer(username);
      if (!p) return false;
      p.chat(text);
      return true;
    },
    kick: (username, reason) => {
      const p = findPlayer(username);
      if (!p) return false;
      p.kick(reason);
      return true;
    },
    dropAll: () => {
      for (const p of serv.players as any[]) p._client?.socket?.destroy();
    },
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => {
        try {
          serv.quit('Server closed');
        } catch {
          /* ignore */
        }
        setTimeout(resolve, 300);
      });
      try {
        serv._server?.close?.();
      } catch {
        /* ignore */
      }
      restoreLog();
    },
  };
}

/** flying-squid logs to stdout unconditionally; keep test/demo output readable. */
function silenceConsole(): () => void {
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (/\[\x1b\[3\dm(INFO|WARN)|Server listening|World seed|connected|spawning player|disconnected|Kicking/.test(first)) return;
    orig(...args);
  };
  return () => {
    console.log = orig;
  };
}
