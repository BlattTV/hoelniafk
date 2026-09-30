#!/usr/bin/env node
/**
 * Builds the Windows installers of the Hoelni Client Suite (desktop program) and the Hoelni Agent –
 * on Windows or on Linux (e.g. the update server in the LXC; no Wine, no Windows needed).
 *
 *   node scripts/build-installers.mjs [--out <dir>] [--only suite|agent] [--skip-build]
 *
 *   1. npm run build (unless --skip-build)
 *   2. one Windows runtime: dist, public, config, package files, the updatable window programs
 *      (desktop/, agent-app/), production dependencies for win32-x64 and Node for Windows
 *   3. electron-builder (NSIS). On Linux the uninstaller is read from the NSIS stub in JavaScript and
 *      the program icon / version info are written with resedit (no Wine).
 *
 * Prints one JSON line: { ok, version, installers: [{ kind, file, path, size, sha256 }] }.
 * Build tools come from desktop/node_modules (cd desktop && npm install).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = opt('only');
const outDir = path.resolve(opt('out') ?? path.join(repo, 'release'));
const isWin = process.platform === 'win32';
// makensis (NSIS) on Linux aborts with "main argv conversion failed" without a UTF-8 locale – e.g. under
// systemd, where LANG is not set – as soon as an argument contains a non-ASCII character ("–", "ü").
if (!isWin && !/utf-?8/i.test(`${process.env.LC_ALL ?? ''}${process.env.LC_CTYPE ?? ''}${process.env.LANG ?? ''}`)) {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';
}
const npm = isWin ? 'npm.cmd' : 'npm';
const say = (m) => process.stderr.write(`› ${m}\n`);
const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: isWin, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });

/** Files of the window programs that update themselves with every release (see desktop/loader.cjs). */
export const SHELL_FILES = [
  'desktop/main.cjs',
  'desktop/package.json',
  'desktop/build/icon.png',
  'desktop/build/tray.png',
  'desktop/build/logo.png',
  'desktop/build/icon.ico',
  'agent-app/main.cjs',
  'agent-app/preload.cjs',
  'agent-app/ui.html',
  'agent-app/ui.js',
  'agent-app/logo.png',
  'agent-app/mark.png',
  'agent-app/package.json',
  'agent-app/build/icon.png',
  'agent-app/build/tray.png',
  'agent-app/build/icon.ico',
];

// ------------------------------------------------------------------ Windows runtime

async function windowsNode(dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (isWin) {
    fs.copyFileSync(process.execPath, path.join(dest, 'node.exe'));
    const npmSrc = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
    if (fs.existsSync(npmSrc)) fs.cpSync(npmSrc, path.join(dest, 'node_modules', 'npm'), { recursive: true });
    return;
  }
  // Same Node version as the build machine, Windows edition (node.exe + npm for dependency updates).
  const ver = process.version;
  const cache = path.join(os.homedir(), '.cache', 'hoelni-build');
  const zipFile = path.join(cache, `node-${ver}-win-x64.zip`);
  if (!fs.existsSync(zipFile)) {
    say(`downloading Node ${ver} for Windows`);
    const res = await fetch(`https://nodejs.org/dist/${ver}/node-${ver}-win-x64.zip`);
    if (!res.ok) throw new Error(`Node for Windows: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sums = await (await fetch(`https://nodejs.org/dist/${ver}/SHASUMS256.txt`)).text();
    const want = sums.split('\n').find((l) => l.endsWith(`node-${ver}-win-x64.zip`))?.split(/\s+/)[0];
    if (!want || crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error('Node for Windows: checksum mismatch');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(zipFile, buf);
  }
  const { unzipSync } = createRequire(path.join(repo, 'package.json'))('fflate');
  const prefix = `node-${ver}-win-x64/`;
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipFile)), { filter: (f) => f.name === `${prefix}node.exe` || f.name.startsWith(`${prefix}node_modules/npm/`) });
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const target = path.join(dest, name.slice(prefix.length));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

async function prepareRuntime(dest) {
  say('copying runtime files');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const item of ['dist', 'public', 'config', 'package.json', 'package-lock.json', 'build-info.json', ...SHELL_FILES]) {
    const src = path.join(repo, item);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(dest, item)), { recursive: true });
    fs.cpSync(src, path.join(dest, item), { recursive: true, filter: (s) => !/app\.yaml$/.test(s) || s.endsWith('app.example.yaml') });
  }
  say('installing production dependencies (win32-x64)');
  run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--os=win32', '--cpu=x64'], dest, { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });
  if (!fs.existsSync(path.join(dest, 'node_modules', 'yaml'))) throw new Error('node_modules missing after npm ci');
  await windowsNode(path.join(dest, 'node'));
}

// ------------------------------------------------------------------ installers

async function setExeResources(exe, ico, meta) {
  const ResEdit = await import(pathToFileURL(createRequire(path.join(repo, 'desktop', 'package.json')).resolve('resedit')).href);
  const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);
  if (!fs.existsSync(ico)) throw new Error(`Icon missing: ${ico}`);
  {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const id = groups[0]?.id ?? 1;
    const lang = groups[0]?.lang ?? 1033;
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, iconFile.icons.map((i) => i.data));
  }
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = meta.version.split(/[.+-]/).map((n) => Number(n) || 0);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: meta.productName, FileDescription: meta.productName, CompanyName: 'Hoelni', OriginalFilename: path.basename(exe), InternalName: meta.productName, FileVersion: meta.version, ProductVersion: meta.version });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
}

async function buildInstaller(kind) {
  const dir = path.join(repo, kind === 'suite' ? 'desktop' : 'agent-app');
  const tools = createRequire(path.join(repo, 'desktop', 'package.json'));
  if (!isWin) tools('app-builder-lib/out/util/macosVersion').isMacOsCatalina = () => true; // uninstaller via JS, not Wine
  const builder = tools('electron-builder');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const electronVersion = JSON.parse(fs.readFileSync(tools.resolve('electron/package.json'), 'utf8')).version;
  say(`building the ${pkg.productName} installer`);
  const release = path.join(dir, 'release');
  fs.rmSync(release, { recursive: true, force: true });
  const files = await builder.build({
    projectDir: dir,
    targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64),
    publish: 'never',
    config: {
      electronVersion,
      publish: null,
      win: { signAndEditExecutable: isWin },
      afterPack: isWin ? undefined : async (ctx) => {
        const exe = path.join(ctx.appOutDir, `${pkg.productName}.exe`);
        await setExeResources(exe, path.join(dir, 'build', 'icon.ico'), { productName: pkg.productName, version: pkg.version });
      },
    },
  });
  const exe = files.find((f) => f.endsWith('.exe') && !f.includes('__uninstaller'));
  if (!exe) throw new Error(`No installer produced for ${kind}`);
  const name = kind === 'suite' ? `Hoelni-Client-Suite-Setup-${pkg.version}.exe` : `Hoelni-Agent-Setup-${pkg.version}.exe`;
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, name);
  fs.copyFileSync(exe, target);
  const data = fs.readFileSync(target);
  return { kind, file: name, path: target, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), version: pkg.version };
}

// ------------------------------------------------------------------ main

const kinds = only ? [only] : ['suite', 'agent'];
if (!argv.includes('--skip-build')) {
  say('building the suite');
  run(npm, ['run', 'build'], repo);
}
const staging = path.join(repo, '.installer-runtime');
await prepareRuntime(staging);
const installers = [];
for (const kind of kinds) {
  // electron-builder drops a node_modules folder at the ROOT of an extraResources source → one level deeper
  const bundle = path.join(repo, kind === 'suite' ? 'desktop' : 'agent-app', 'bundle', kind === 'suite' ? 'backend' : 'runtime');
  fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.cpSync(staging, bundle, { recursive: true });
  installers.push(await buildInstaller(kind));
}
fs.rmSync(staging, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, installers }));
