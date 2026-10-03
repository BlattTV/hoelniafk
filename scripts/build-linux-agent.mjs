#!/usr/bin/env node
/**
 * Builds the Hoelni Agent for Linux as a tar.gz per architecture (x64, arm64 – e.g. Raspberry Pi 4/5):
 *
 *   hoelni-agent/
 *     node/                 official Node.js build (same version as this machine), with npm for updates
 *     dist/  package.json  package-lock.json  build-info.json
 *     node_modules/         production dependencies (pure JavaScript – the same for every architecture)
 *     agent-linux/          service supervisor, command line, install / uninstall
 *     install.sh            sudo ./install.sh → /opt/hoelni-agent + systemd service hoelni-agent
 *     LIESMICH.txt
 *
 *   node scripts/build-linux-agent.mjs [--out <dir>] [--arch x64,arm64] [--build <n>] [--skip-build] [--cache <dir>]
 *
 * Prints one JSON line at the end: { ok, items: [{ kind: 'linux-x64', file, path, size, sha256, version, build }] }.
 * The agent updates itself afterwards (signed releases through the backend, like on Windows).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = path.resolve(flag('out') ?? path.join(repo, 'release'));
const arches = (flag('arch') ?? 'x64,arm64').split(',').map((a) => a.trim()).filter(Boolean);
const build = flag('build') ? Number(flag('build')) : null;
const cache = path.resolve(flag('cache') ?? path.join(os.homedir(), '.cache', 'hoelni-build'));
const say = (m) => process.stderr.write(`› ${m}\n`);
const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts });
  } catch (e) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${String(e.stderr || e.message).slice(-1500)}`);
  }
};

for (const a of arches) if (!['x64', 'arm64'].includes(a)) throw new Error(`unknown architecture ${a} (x64, arm64)`);
if (!argv.includes('--skip-build')) {
  say('building the agent (npm run build)');
  run('npm', ['run', 'build'], { cwd: repo });
}
if (!fs.existsSync(path.join(repo, 'dist', 'agent', 'main.js'))) throw new Error('dist/agent/main.js missing – build first');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const ver = process.version;

/** Official Node.js for Linux (checked against nodejs.org's SHASUMS256.txt), cached. */
async function nodeTarball(arch) {
  const name = `node-${ver}-linux-${arch}.tar.gz`;
  const file = path.join(cache, name);
  if (fs.existsSync(file)) return file;
  say(`downloading Node ${ver} for Linux ${arch}`);
  const res = await fetch(`https://nodejs.org/dist/${ver}/${name}`);
  if (!res.ok) throw new Error(`Node for Linux ${arch}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sums = await (await fetch(`https://nodejs.org/dist/${ver}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.trim().endsWith(name))?.split(/\s+/)[0];
  if (!want || crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error(`Node for Linux ${arch}: checksum mismatch`);
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, buf);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

const README = `Hoelni Agent für Linux
=====================

Installation als Dienst (startet automatisch, aktualisiert sich selbst):

  sudo ./install.sh
  sudo hoelni-agent login --user DEIN-NAME --name "Name dieses Rechners"

Danach erscheint der Rechner in der Suite unter "Agents". Dort bei einer Identität
"Läuft auf" diesen Agent wählen.

  sudo hoelni-agent status        Status
  sudo hoelni-agent log           Protokoll (journalctl)
  sudo hoelni-agent logout        abmelden
  sudo /opt/hoelni-agent/agent-linux/uninstall.sh [--purge]

Ohne Dienst (z. B. im Container, ohne root):

  ./agent-linux/hoelni-agent login --user DEIN-NAME
  ./agent-linux/hoelni-agent run

Daten: /var/lib/hoelni-agent (Dienst) bzw. ~/.hoelni-agent. Das "Spiel öffnen" geht auf einem
Server ohne Desktop nicht – das macht man am PC.
`;

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-linux-agent-'));
const items = [];
try {
  // the architecture-independent part once: program, dependencies, scripts
  const common = path.join(staging, 'common');
  fs.mkdirSync(common, { recursive: true });
  for (const d of ['dist']) fs.cpSync(path.join(repo, d), path.join(common, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repo, f), path.join(common, f));
  fs.cpSync(path.join(repo, 'agent-linux'), path.join(common, 'agent-linux'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'agent-linux', 'install.sh'), path.join(common, 'install.sh'));
  fs.writeFileSync(path.join(common, 'LIESMICH.txt'), README);
  const commit = (() => {
    try {
      return run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }).toString().trim();
    } catch {
      return null;
    }
  })();
  fs.writeFileSync(path.join(common, 'build-info.json'), JSON.stringify({ version: pkg.version, build, commit, createdAt: new Date().toISOString() }, null, 2));
  say('installing the production dependencies (npm ci --omit=dev)');
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: common, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
  for (const f of ['install.sh', 'agent-linux/install.sh', 'agent-linux/uninstall.sh', 'agent-linux/hoelni-agent']) fs.chmodSync(path.join(common, f), 0o755);
  // not needed by the agent: Bedrock data (~330 MB unpacked) and the desktop key-ring binaries (the Linux
  // agent keeps its vault key in a file; those binaries would be x64-only anyway)
  const bedrock = path.join(common, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'bedrock');
  // minecraft-data loads bedrock/common when it is required – only the per-version data goes
  for (const d of fs.existsSync(bedrock) ? fs.readdirSync(bedrock) : []) if (d !== 'common') fs.rmSync(path.join(bedrock, d), { recursive: true, force: true });
  for (const d of fs.existsSync(path.join(common, 'node_modules', '@napi-rs')) ? fs.readdirSync(path.join(common, 'node_modules', '@napi-rs')) : []) {
    if (d.startsWith('keyring-')) fs.rmSync(path.join(common, 'node_modules', '@napi-rs', d), { recursive: true, force: true });
  }

  fs.mkdirSync(out, { recursive: true });
  for (const arch of arches) {
    const tarball = await nodeTarball(arch);
    const dir = path.join(staging, arch);
    const top = path.join(dir, 'hoelni-agent');
    fs.mkdirSync(top, { recursive: true });
    fs.cpSync(common, top, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', top]);
    fs.renameSync(path.join(top, `node-${ver}-linux-${arch}`), path.join(top, 'node'));
    // npm stays (dependency changes in updates), headers / docs do not
    for (const p of ['include', 'share', 'CHANGELOG.md', 'README.md']) fs.rmSync(path.join(top, 'node', p), { recursive: true, force: true });
    const file = `Hoelni-Agent-Linux-${arch}-${pkg.version}${build ? `-${build}` : ''}.tar.gz`;
    const target = path.join(out, file);
    say(`packing ${file}`);
    run('tar', ['--owner=0', '--group=0', '-czf', target, '-C', dir, 'hoelni-agent']);
    const data = fs.readFileSync(target);
    items.push({ kind: `linux-${arch}`, file, path: target, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), version: pkg.version, build });
    say(`${file} (${(data.length / 1e6).toFixed(1)} MB)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, items }));
