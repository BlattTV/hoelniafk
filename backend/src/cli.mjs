#!/usr/bin/env node
/**
 * hoelni-backend – accounts + relay for the Hoelni AFK suite (afk.hoelni.de).
 *
 *   hoelni-backend init [--host 0.0.0.0] [--port 8480] [--trust-proxy] [--data-dir DIR] [--public-url URL] [--tls-cert F --tls-key F]
 *   hoelni-backend serve
 *   hoelni-backend user add <name> [--admin] [--password PW]     (asks for the password if not given)
 *   hoelni-backend user passwd <name> [--password PW]
 *   hoelni-backend user role <name> admin|user
 *   hoelni-backend user disable|enable|delete <name>
 *   hoelni-backend user list
 *   hoelni-backend devices                                      signed-in managers and agents
 *   hoelni-backend info                                         address, certificate fingerprint, accounts
 *   hoelni-backend config set <key> <value>                     host | port | trustProxy | publicUrl | updatesUpstream
 *
 * Config: $HOELNI_BACKEND_CONFIG or /etc/hoelni-backend/config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { Accounts } from './accounts.mjs';
import { openDb } from './db.mjs';
import { Relay } from './relay.mjs';
import { createBackendServer } from './server.mjs';

const CONFIG = process.env.HOELNI_BACKEND_CONFIG ?? '/etc/hoelni-backend/config.json';
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--admin' && argv[i - 1] !== '--trust-proxy'));
const die = (m) => {
  console.error(`hoelni-backend: ${m}`);
  process.exit(1);
};
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function loadConfig() {
  if (!fs.existsSync(CONFIG)) die(`no config at ${CONFIG} – run "hoelni-backend init" first`);
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  return { host: '0.0.0.0', port: 8480, dataDir: '/var/lib/hoelni-backend', trustProxy: false, tls: { cert: '', key: '' }, ...c };
}

function openAccounts() {
  const cfg = loadConfig();
  return { cfg, accounts: new Accounts(openDb(path.join(cfg.dataDir, 'backend.db'))) };
}

async function askPassword(q) {
  const given = flag('password');
  if (typeof given === 'string') return given;
  if (!process.stdin.isTTY) die('pass --password or run interactively');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = process.stdout;
  const orig = out.write.bind(out);
  const ask = (text) =>
    new Promise((resolve) => {
      rl.question(text, (a) => {
        out.write = orig;
        orig('\n');
        resolve(a);
      });
      out.write = (chunk) => (String(chunk).includes(text) ? orig(chunk) : true);
    });
  const a = await ask(q);
  const b = await ask('Repeat: ');
  rl.close();
  if (a !== b) die('passwords do not match');
  return a;
}

const [cmd, sub, name, extra] = pos;

switch (cmd) {
  case 'init': {
    if (fs.existsSync(CONFIG) && !flag('force')) die(`${CONFIG} exists (use --force)`);
    const cfg = { host: flag('host', '0.0.0.0'), port: Number(flag('port', 8480)), dataDir: flag('data-dir', '/var/lib/hoelni-backend'), trustProxy: flag('trust-proxy', false) === true, publicUrl: flag('public-url', ''), tls: { cert: flag('tls-cert', ''), key: flag('tls-key', '') } };
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    console.log(`Config written: ${CONFIG}`);
    break;
  }
  case 'serve': {
    const { cfg, accounts } = openAccounts();
    const log = { info: (m) => console.log(`${new Date().toISOString()} ${m}`), error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`) };
    const relay = new Relay(accounts, log);
    const server = createBackendServer({ accounts, relay, config: cfg, version: pkg.version, log });
    server.listen(cfg.port, cfg.host, () => log.info(`hoelni-backend ${pkg.version} listening on ${cfg.host}:${cfg.port}${cfg.tls?.cert ? ' (TLS)' : cfg.trustProxy ? ' (behind a reverse proxy)' : ''}`));
    if (!accounts.admins().length) log.info('No admin account yet – create one: hoelni-backend user add <name> --admin');
    const stop = () => {
      relay.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    break;
  }
  case 'user': {
    const { accounts } = openAccounts();
    const byName = (n) => accounts.listUsers().find((u) => u.username.toLowerCase() === String(n ?? '').toLowerCase()) ?? die(`no user "${n}"`);
    try {
      if (sub === 'add') {
        if (!name) die('usage: user add <name> [--admin]');
        const u = accounts.createUser(name, await askPassword(`Password for ${name} (min. 10 characters): `), flag('admin', false) === true ? 'admin' : 'user');
        accounts.audit('cli', 'User created', `${u.username} (${u.role})`);
        console.log(`created ${u.username} (${u.role})`);
      } else if (sub === 'passwd') {
        const u = byName(name);
        accounts.updateUser(u.id, { password: await askPassword(`New password for ${u.username}: `) });
        console.log('password changed');
      } else if (sub === 'role') {
        accounts.updateUser(byName(name).id, { role: extra });
        console.log(`${name} is now ${extra}`);
      } else if (sub === 'disable' || sub === 'enable') {
        accounts.updateUser(byName(name).id, { disabled: sub === 'disable' });
        console.log(`${name} ${sub}d (restart not needed; devices are signed out on their next connect)`);
      } else if (sub === 'delete') {
        accounts.deleteUser(byName(name).id);
        console.log(`${name} deleted`);
      } else if (sub === 'list' || !sub) {
        for (const u of accounts.listUsers()) console.log(`${u.username}\t${u.role}\t${u.disabled ? 'disabled' : 'active'}\tlast sign-in ${u.lastLoginAt ?? '–'}`);
      } else die(`unknown: user ${sub}`);
    } catch (e) {
      die(e.message);
    }
    break;
  }
  case 'devices': {
    const { accounts } = openAccounts();
    for (const d of accounts.listDevices()) if (!d.revoked) console.log(`#${d.id}\t${d.username}\t${d.kind}\t${d.name}\tlast ${d.lastSeenAt ?? '–'} ${d.lastIp ?? ''}`);
    break;
  }
  case 'config': {
    const keys = { host: String, port: Number, trustProxy: (v) => v === 'true' || v === '1', publicUrl: String, updatesUpstream: String };
    if (sub !== 'set' || !(name in keys) || extra === undefined) die(`usage: config set <${Object.keys(keys).join('|')}> <value>   ("" clears)`);
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    cfg[name] = keys[name](extra);
    if (name === 'updatesUpstream' && cfg[name] && !/^https?:\/\/[^/]+$/.test(cfg[name])) die('updatesUpstream must look like http://127.0.0.1:8787');
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    console.log(`${name} = ${JSON.stringify(cfg[name])} – restart: systemctl restart hoelni-backend`);
    break;
  }
  case 'info': {
    const { cfg, accounts } = openAccounts();
    const users = accounts.listUsers();
    const devices = accounts.listDevices().filter((d) => !d.revoked);
    console.log(`hoelni-backend ${pkg.version}`);
    // which code is installed (the checkout of the installer / "hoelni-backend update")
    try {
      const head = new URL('../../.git/HEAD', import.meta.url);
      const ref = fs.readFileSync(head, 'utf8').trim();
      const commit = ref.startsWith('ref:') ? fs.readFileSync(new URL(`../../.git/${ref.slice(5).trim()}`, import.meta.url), 'utf8').trim() : ref;
      console.log(`Installed:     ${commit.slice(0, 7)} (${fs.statSync(head).mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC) – newer: hoelni-backend update`);
    } catch {
      /* not a git checkout */
    }
    console.log(`Control app:   ${fs.existsSync(new URL('../../control-app/inter-latin.woff2', import.meta.url)) ? 'current design (light / dark)' : 'old design – run: hoelni-backend update'}`);
    console.log(`Listening:     ${cfg.host}:${cfg.port}${cfg.tls?.cert ? ' (TLS)' : cfg.trustProxy ? ' (behind a reverse proxy)' : ' (plain HTTP)'}`);
    if (cfg.publicUrl) console.log(`Public URL:    ${cfg.publicUrl}`);
    console.log(`Updates:       ${cfg.updatesUpstream ? `${cfg.publicUrl || ''}/updates  → ${cfg.updatesUpstream}` : 'not distributed (hoelni-backend config set updatesUpstream http://127.0.0.1:8787)'}`);
    if (cfg.tls?.cert) {
      const cert = new crypto.X509Certificate(fs.readFileSync(cfg.tls.cert));
      console.log(`Certificate:   ${cert.subject.replace(/\n/g, ', ')} (valid until ${cert.validTo})`);
      console.log(`Fingerprint:   ${cert.fingerprint256}`);
      console.log('               → compare with the fingerprint the manager / agent shows on first sign-in');
    }
    console.log(`Accounts:      ${users.length} (${users.filter((u) => u.role === 'admin').length} admin) – ${users.map((u) => `${u.username}${u.role === 'admin' ? '*' : ''}`).join(', ') || 'none'}`);
    console.log(`Devices:       ${devices.filter((d) => d.kind === 'manager').length} manager, ${devices.filter((d) => d.kind === 'agent').length} agent(s) signed in`);
    if (!accounts.admins().length) console.log('\nNo admin yet – create one: hoelni-backend user add <name> --admin');
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 17).map((l) => l.replace(/^ \* ?/, '')).filter((l) => l !== '/').join('\n'));
    if (cmd && cmd !== 'help') process.exit(1);
}
