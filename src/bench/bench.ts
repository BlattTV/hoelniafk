/**
 * Performance benchmark of the Minecraft runtime (LOCAL INTEGRATION).
 *
 *   npm run bench [-- --tiers 1,5,15,30,50,75,100 --steady 30 --out docs/PERFORMANCE.md]
 *
 * - local flying-squid servers run in a SEPARATE process (not measured)
 * - the suite runs in this process with real supervised runtime hosts
 * - per tier: time until all sessions are online, then steady-state samples of
 *   RAM / CPU / event-loop lag / threads / processes / network
 * - reconnect test: the server drops every connection → time until all are back
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, type Suite } from '../app.js';
import { DEFAULT_CONFIG, type AppConfig } from '../config.js';
import { openDatabase } from '../core/db.js';
import { setLogLevel } from '../core/logger.js';
import { parseRules } from '../core/rules.js';
import type { MetricsSample } from '../core/metrics.js';
import { StaticKeyProvider } from '../vault/keyProviders.js';
import { EncryptedFileVault } from '../vault/vault.js';

setLogLevel('warn');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const TIERS = arg('tiers', '1,5,15,30,50,75,100').split(',').map(Number);
const STEADY_SEC = Number(arg('steady', '30'));
const OUT = arg('out', 'docs/PERFORMANCE.md');
const PORT = Number(arg('port', '25711'));
const SERVERS = 2;

interface TierResult {
  label: string;
  sessions: number;
  hosts: number;
  sessionsPerHost: number;
  physics: string;
  connectSec: number;
  processes: number;
  threads: number | null;
  mainRssMb: number;
  hostsRssMb: number;
  totalRssMb: number;
  rssPerSessionMb: number;
  mainCpu: number;
  hostsCpu: number;
  mainLagMs: number;
  mainLagP99Ms: number;
  hostLagMs: number;
  netInBs: number;
  netOutBs: number;
  reconnectSec?: number;
  reconnectAttempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startServers(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/testserver/cli.ts'), '--port', String(PORT), '--count', String(SERVERS)], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('"ready":true')) resolve();
    });
    child.once('exit', () => reject(new Error('test servers exited')));
  });
  return child;
}

async function makeSuite(sessionsPerHost: number): Promise<Suite> {
  const rules = parseRules(fs.readFileSync('config/rules.yaml', 'utf8'));
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    port: 0,
    runtime: { ...DEFAULT_CONFIG.runtime, mode: 'process', sessionsPerHost, grouping: 'pooled', idleHostTtlMs: 3000 },
    sessions: { reconcileIntervalMs: 1000, maxConcurrentStarts: 8 },
  };
  const suite = createSuite({
    config,
    db: openDatabase(':memory:'),
    store: await EncryptedFileVault.open(null, new StaticKeyProvider()),
    rules: { ...rules, reconnect: { ...rules.reconnect, baseDelaySec: 2, maxDelaySec: 20 } },
  });
  const servers = Array.from({ length: SERVERS }, (_, i) => suite.repo.upsertServer({ name: `Bench${i + 1}`, host: '127.0.0.1', port: PORT + i, version: '1.20.1' }));
  for (let n = 1; n <= 50; n++) {
    const id = suite.identities.create({ label: `Bench${String(n).padStart(2, '0')}`, settings: { afk: { enabled: true, action: 'look', intervalSec: 45 } } }).identity.id;
    suite.repo.upsertMinecraft(id, { username: `Bench${String(n).padStart(2, '0')}`, authType: 'offline' });
    if (process.platform === 'linux') suite.repo.createNetworkProfile(id, { kind: 'BIND', localBindIp: `127.0.1.${n}` });
    for (const s of servers) suite.repo.assignServer(id, { serverId: s.id });
  }
  suite.sessions.startReconciler();
  // No background sampler: the benchmark takes the samples itself (rates are computed between samples).
  return suite;
}

/** Session k (0-based): identities 1..50 on server 1, then the same identities on server 2. */
function target(suite: Suite, count: number): Set<string> {
  const ids = suite.repo.listIdentities().map((i) => i.id);
  const servers = suite.repo.listServers();
  const out = new Set<string>();
  for (let k = 0; k < count; k++) out.add(`${ids[k % 50]}:${servers[Math.floor(k / 50)].id}`);
  return out;
}

async function setTargets(suite: Suite, wanted: Set<string>): Promise<void> {
  for (const a of suite.repo.listAssignments()) {
    const id = `${a.identityId}:${a.serverId}`;
    const desired = wanted.has(id) ? 'ONLINE' : 'OFFLINE';
    if (a.desiredState !== desired) suite.sessions.setDesired(a.identityId, a.serverId, desired);
  }
}

async function waitAllOnline(suite: Suite, wanted: Set<string>, timeoutMs: number): Promise<number> {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const online = suite.sessions.list().filter((s) => wanted.has(s.id) && s.state === 'ONLINE').length;
    if (online === wanted.size) return (Date.now() - t) / 1000;
    await sleep(250);
  }
  throw new Error(`Timeout: not all ${wanted.size} sessions online`);
}

async function steady(suite: Suite, seconds: number): Promise<MetricsSample[]> {
  suite.metrics.sample(); // reset baselines
  const samples: MetricsSample[] = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await sleep(5000);
    samples.push(suite.metrics.sample());
  }
  return samples;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

function summarize(label: string, suite: Suite, sessions: number, connectSec: number, samples: MetricsSample[], physics: string, perHost: number): TierResult {
  const last = samples.at(-1)!;
  const mainRss = avg(samples.map((s) => s.main.rss)) / 1048576;
  const hostsRss = avg(samples.map((s) => s.hosts.rss)) / 1048576;
  return {
    label,
    sessions,
    hosts: last.hosts.count,
    sessionsPerHost: perHost,
    physics,
    connectSec: r1(connectSec),
    processes: last.processes,
    threads: last.main.threads !== null && last.hosts.threads !== null ? last.main.threads + last.hosts.threads : null,
    mainRssMb: r1(mainRss),
    hostsRssMb: r1(hostsRss),
    totalRssMb: r1(mainRss + hostsRss),
    rssPerSessionMb: r1((mainRss + hostsRss) / Math.max(1, sessions)),
    mainCpu: r1(avg(samples.map((s) => s.main.cpuPercent))),
    hostsCpu: r1(avg(samples.map((s) => s.hosts.cpuPercent))),
    mainLagMs: r1(avg(samples.map((s) => s.main.eventLoopLagMs))),
    mainLagP99Ms: r1(Math.max(...samples.map((s) => s.main.eventLoopLagP99Ms))),
    hostLagMs: r1(Math.max(...samples.map((s) => s.hosts.maxLagMs))),
    netInBs: Math.round(avg(samples.map((s) => s.network.inPerSec))),
    netOutBs: Math.round(avg(samples.map((s) => s.network.outPerSec))),
  };
}

async function reconnectTest(suite: Suite, servers: ChildProcess, wanted: Set<string>): Promise<{ sec: number; attempts: number }> {
  const before = suite.sessions.list().reduce((a, s) => a + s.reconnects, 0);
  servers.stdin!.write('drop\n');
  await sleep(1500);
  const sec = await waitAllOnline(suite, wanted, 240_000);
  const after = suite.sessions.list().reduce((a, s) => a + s.reconnects, 0);
  return { sec: r1(sec + 1.5), attempts: after - before };
}

async function main(): Promise<void> {
  const servers = await startServers();
  const results: TierResult[] = [];
  try {
    // ---- tiers with the default runtime configuration
    const perHost = DEFAULT_CONFIG.runtime.sessionsPerHost;
    const suite = await makeSuite(perHost);
    for (const n of TIERS) {
      const wanted = target(suite, n);
      await setTargets(suite, wanted);
      const connectSec = await waitAllOnline(suite, wanted, 300_000);
      await sleep(8000); // settle (and reap hosts emptied by a smaller tier)
      const samples = await steady(suite, STEADY_SEC);
      const res = summarize(`${n} sessions`, suite, n, connectSec, samples, 'lightweight', perHost);
      if (n === Math.max(...TIERS) || n === 15) {
        const rc = await reconnectTest(suite, servers, wanted);
        res.reconnectSec = rc.sec;
        res.reconnectAttempts = rc.attempts;
      }
      results.push(res);
      console.log(JSON.stringify(res));
    }
    // ---- lightweight vs physics at 30 sessions
    const n = Math.min(30, Math.max(...TIERS));
    const wanted = target(suite, n);
    await setTargets(suite, wanted);
    for (const i of suite.repo.listIdentities()) suite.repo.updateIdentity(i.id, { settings: { lightweight: false } });
    for (const id of wanted) await suite.sessions.reconnect(id);
    const c2 = await waitAllOnline(suite, wanted, 300_000);
    await sleep(12_000); // let emptied hosts from the 100-session tier be reaped
    const physicsRes = summarize(`${n} sessions, physics always on`, suite, n, c2, await steady(suite, STEADY_SEC), 'physics on', perHost);
    results.push(physicsRes);
    console.log(JSON.stringify(physicsRes));
    await suite.shutdown();

    // ---- one process per session (maximum isolation) at 15 sessions
    const iso = await makeSuite(1);
    const w15 = target(iso, Math.min(15, Math.max(...TIERS)));
    await setTargets(iso, w15);
    const c3 = await waitAllOnline(iso, w15, 300_000);
    await sleep(3000);
    const isoRes = summarize(`${w15.size} sessions, 1 session per host process`, iso, w15.size, c3, await steady(iso, STEADY_SEC), 'lightweight', 1);
    results.push(isoRes);
    console.log(JSON.stringify(isoRes));
    await iso.shutdown();
  } finally {
    servers.kill('SIGTERM');
  }
  writeReport(results);
}

function writeReport(results: TierResult[]): void {
  const cpu = os.cpus()[0]?.model ?? 'unknown';
  const lines = [
    '# Performance measurements',
    '',
    '> Generated by `npm run bench` (LOCAL INTEGRATION). Numbers are from the environment below –',
    '> re-run the benchmark on your Windows VM for your own figures.',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- CPU: ${cpu} × ${os.cpus().length} · RAM ${Math.round(os.totalmem() / 1073741824)} GB · ${os.platform()} ${os.release()} · Node ${process.version}`,
    `- Servers: ${SERVERS} local flying-squid 1.20.1 servers in a separate process (not included in the numbers); all bots stand at the same spawn point (worst case for entity traffic)`,
    `- Suite: process runtime, pooled hosts, ${DEFAULT_CONFIG.runtime.sessionsPerHost} sessions per host unless noted (idle hosts reaped after 3 s); view distance "tiny"; AFK action "look" every 45 s; source IP 127.0.1.x per identity (Linux)`,
    `- Steady-state window: ${STEADY_SEC} s per tier, samples every 5 s. Sessions > 50 = the same 50 accounts additionally on a second server.`,
    '',
    '| Scenario | Sessions | Host procs | Connect all (s) | RAM total (MB) | RAM/session (MB) | Main RSS (MB) | Hosts RSS (MB) | CPU main % | CPU hosts % | Lag main avg/p99 (ms) | Lag hosts max (ms) | Threads | Net in / out (B/s) | Reconnect all after drop (s) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map((r) =>
      `| ${r.label} | ${r.sessions} | ${r.hosts} | ${r.connectSec} | ${r.totalRssMb} | ${r.rssPerSessionMb} | ${r.mainRssMb} | ${r.hostsRssMb} | ${r.mainCpu} | ${r.hostsCpu} | ${r.mainLagMs} / ${r.mainLagP99Ms} | ${r.hostLagMs} | ${r.threads ?? '–'} | ${r.netInBs} / ${r.netOutBs} | ${r.reconnectSec !== undefined ? `${r.reconnectSec} (${r.reconnectAttempts} attempts)` : '–'} |`),
    '',
    'CPU % is per core (100 % = one core fully used). "Connect all" includes the concurrency limit of 8 simultaneous connection attempts.',
    '',
  ];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'));
  fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify(results, null, 2));
  console.log(`Report written to ${OUT}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
