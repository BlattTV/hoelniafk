/**
 * Local Minecraft test servers for trying out the suite without the real server.
 *
 *   npm run testserver -- --port 25601 --count 3 --version 1.20.1 [--stars 30]
 *
 * Offline mode. Emits Hoelni-like link/reward messages (see localServer.ts).
 * Prints one JSON line {"ready":true,"ports":[…]} once all servers listen.
 */
import { startLocalServer, type LocalServer } from './localServer.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const port = Number(arg('port', '25601'));
  const count = Number(arg('count', '1'));
  const version = arg('version', '1.20.1');
  const stars = Number(arg('stars', '0'));
  const servers: LocalServer[] = [];
  for (let i = 0; i < count; i++) servers.push(await startLocalServer({ port: port + i, version, starIntervalSec: stars, motd: `Hoelni local test server ${i + 1}` }));
  process.stdout.write(JSON.stringify({ ready: true, ports: servers.map((s) => s.port), version }) + '\n');
  const stop = async () => {
    for (const s of servers) await s.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Commands on stdin (used by the benchmark): "drop" disconnects every player.
  process.stdin.on('data', (d) => {
    const cmd = d.toString().trim();
    if (cmd === 'drop') for (const s of servers) s.dropAll();
    if (cmd.startsWith('kick ')) for (const s of servers) for (const p of s.players()) s.kick(p, cmd.slice(5));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
