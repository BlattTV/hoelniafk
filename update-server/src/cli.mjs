#!/usr/bin/env node
/**
 * hoelni-updates – update server for the Hoelni Client Suite.
 *
 *   hoelni-updates init [--repo URL] [--branch B] [--port 8787]   create config, signing key, admin token
 *   hoelni-updates serve                                           run the HTTP server (+ auto build timer)
 *   hoelni-updates build [--if-changed] [--channel stable]         build a release from git now
 *   hoelni-updates list                                            releases and channels
 *   hoelni-updates promote <channel> <build>                       point a channel to a build (rollback)
 *   hoelni-updates attach-installer <build> <file.exe> [version]   add a Windows installer to a release
 *   hoelni-updates info                                            URL, key fingerprint, config path
 *   hoelni-updates rotate-token                                    new admin token
 *
 * Config: $HOELNI_UPDATES_CONFIG or /etc/hoelni-updates/config.json (created by init, mode 600).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Builder } from './builder.mjs';
import { createServer } from './server.mjs';
import { fingerprint, generateKeyPair, publicFromPrivate } from './sign.mjs';
import { Store } from './store.mjs';

const CONFIG = process.env.HOELNI_UPDATES_CONFIG ?? '/etc/hoelni-updates/config.json';
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && !['--if-changed'].includes(all[i - 1])));

function die(msg) {
  console.error(`hoelni-updates: ${msg}`);
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG)) die(`no config at ${CONFIG} – run "hoelni-updates init" first`);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg.dataDir ??= '/var/lib/hoelni-updates';
  cfg.keyFile ??= path.join(path.dirname(CONFIG), 'signing.key');
  cfg.workDir ??= path.join(cfg.dataDir, 'src');
  return cfg;
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function newToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}

function open() {
  const cfg = loadConfig();
  const privatePem = fs.readFileSync(cfg.keyFile, 'utf8');
  const store = new Store(cfg.dataDir, privatePem);
  const builder = cfg.repo
    ? new Builder(store, { repo: cfg.repo, branch: cfg.branch, channel: cfg.channel, workDir: cfg.workDir, runTests: !!cfg.runTests, keep: cfg.keep ?? 20, gitToken: cfg.gitToken || process.env.GIT_TOKEN || undefined })
    : null;
  return { cfg, store, builder, publicKey: publicFromPrivate(privatePem) };
}

switch (cmd) {
  case 'init': {
    if (fs.existsSync(CONFIG) && !flag('force')) die(`${CONFIG} exists (use --force to overwrite)`);
    const dataDir = flag('data-dir', '/var/lib/hoelni-updates');
    const keyFile = path.join(path.dirname(CONFIG), 'signing.key');
    let publicKey;
    if (fs.existsSync(keyFile)) publicKey = publicFromPrivate(fs.readFileSync(keyFile, 'utf8'));
    else {
      const kp = generateKeyPair();
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, kp.privatePem, { mode: 0o600 });
      publicKey = kp.publicB64;
    }
    const { token, hash } = newToken();
    const cfg = {
      host: flag('host', '0.0.0.0'),
      port: Number(flag('port', 8787)),
      publicUrl: flag('public-url', ''),
      dataDir,
      keyFile,
      repo: flag('repo', 'https://github.com/BlattTV/hoelniafk.git'),
      branch: flag('branch', 'claude/practical-hopper-o4bpyw'),
      channel: flag('channel', 'stable'),
      autoBuildMinutes: Number(flag('auto-build-minutes', 15)),
      runTests: flag('run-tests', false) === true,
      keep: 20,
      gitToken: typeof flag('git-token', '') === 'string' ? flag('git-token', '') : '',
      adminTokenHash: hash,
    };
    saveConfig(cfg);
    fs.mkdirSync(dataDir, { recursive: true });
    const url = cfg.publicUrl || `http://${lanAddress()}:${cfg.port}`;
    console.log(`Config:          ${CONFIG}`);
    console.log(`Update URL:      ${url}`);
    console.log(`Key fingerprint: ${fingerprint(publicKey)}`);
    console.log(`Admin token:     ${token}   (shown once – store it; "hoelni-updates rotate-token" makes a new one)`);
    break;
  }
  case 'rotate-token': {
    const cfg = loadConfig();
    const { token, hash } = newToken();
    saveConfig({ ...cfg, adminTokenHash: hash });
    console.log(`New admin token: ${token}   (restart the service to apply)`);
    break;
  }
  case 'info': {
    const { cfg, publicKey, store } = open();
    console.log(JSON.stringify({ config: CONFIG, url: cfg.publicUrl || `http://${lanAddress()}:${cfg.port}`, keyFingerprint: fingerprint(publicKey), repo: cfg.repo, branch: cfg.branch, channels: store.channels, state: store.state }, null, 2));
    break;
  }
  case 'serve': {
    const { cfg, store, builder, publicKey } = open();
    const server = createServer({ store, builder, publicKey, adminTokenHash: cfg.adminTokenHash });
    server.listen(cfg.port, cfg.host, () => console.log(`hoelni-updates listening on ${cfg.host}:${cfg.port} (key ${fingerprint(publicKey)})`));
    if (builder && cfg.autoBuildMinutes > 0) {
      const tick = () =>
        builder
          .build({ ifChanged: true })
          .then((r) => r.skipped || console.log(`auto build: published #${r.build}`))
          .catch((e) => console.error(`auto build failed: ${String(e.stderr || e.message).slice(-500)}`));
      setTimeout(tick, 5_000);
      setInterval(tick, cfg.autoBuildMinutes * 60_000);
    }
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    break;
  }
  case 'build': {
    const { builder } = open();
    if (!builder) die('no repository configured');
    builder
      .build({ ifChanged: flag('if-changed', false) === true, channel: typeof flag('channel') === 'string' ? flag('channel') : undefined })
      .then((r) => console.log(r.skipped ? `up to date (${r.commit.slice(0, 7)})` : `published build ${r.build} (${r.version})`))
      .catch((e) => die(String(e.stderr || e.message).slice(-2000)));
    break;
  }
  case 'list': {
    const { store } = open();
    const ch = store.channels;
    for (const m of store.list()) {
      const tags = Object.entries(ch).filter(([, b]) => b === m.build).map(([c]) => `[${c}]`).join(' ');
      console.log(`#${m.build}\t${m.version}\t${m.createdAt}\t${tags}${m.installer ? '\t+installer' : ''}`);
    }
    break;
  }
  case 'promote': {
    const [channel, build] = positional;
    if (!channel || !build) die('usage: promote <channel> <build>');
    open().store.promote(channel, Number(build));
    console.log(`${channel} → #${build}`);
    break;
  }
  case 'attach-installer': {
    const [build, file, version] = positional;
    if (!build || !file) die('usage: attach-installer <build> <file.exe> [desktopVersion]');
    const m = open().store.attachInstaller(Number(build), path.basename(file).replace(/\s+/g, '-'), fs.readFileSync(file), version ?? null);
    console.log(`installer attached to #${m.build}`);
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 16).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    if (cmd && cmd !== 'help') process.exit(1);
}
