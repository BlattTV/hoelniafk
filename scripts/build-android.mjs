#!/usr/bin/env node
/**
 * Builds the Hoelni Agent for Android (APK) – on Linux, without Gradle, Android Studio or the NDK.
 *
 *   node scripts/build-android.mjs [--out <dir>] [--build <n>] [--skip-build] [--cache <dir>] [--keystore <file.p12>]
 *
 *   Tools (Debian / Ubuntu): apt-get install default-jdk-headless aapt zipalign apksigner clang lld zip unzip
 *
 *   1. npm run build (unless --skip-build)
 *   2. agent payload: dist, package.json, build-info.json and only the packages the agent uses
 *      (Minecraft data without the Bedrock files) → assets/agent.zip
 *   3. Node.js for Android: libnode.so from nodejs-mobile (npm), libc++_shared.so (Maven Central),
 *      a small JNI bridge compiled with clang for aarch64-linux-android
 *   4. Java against the Android 14 framework (Robolectric android-all, Maven Central), dex with dx
 *      (dalvik-dx, Maven Central – Debian has no dx package),
 *      resources with aapt, zipalign, apksigner
 *
 * Downloads are cached (--cache, default ~/.cache/hoelni-android) and checked against fixed SHA-256
 * sums. The signing key is created on the first build (<cache>/release.p12 + .pass) and must stay the
 * same – Android installs an update only over an app signed with the same key.
 *
 * Prints one JSON line: { ok, kind: 'android', file, path, size, sha256, version, build, versionCode }.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const outDir = path.resolve(opt('out') ?? path.join(repo, 'release'));
const cacheDir = path.resolve(opt('cache') ?? path.join(os.homedir(), '.cache', 'hoelni-android'));
const keystore = path.resolve(opt('keystore') ?? path.join(cacheDir, 'release.p12'));
const say = (m) => process.stderr.write(`› ${m}\n`);
const run = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString();
const require = createRequire(path.join(repo, 'package.json'));

const ABI = 'arm64-v8a';
const DOWNLOADS = {
  nodejsMobile: {
    url: 'https://registry.npmjs.org/nodejs-mobile-react-native/-/nodejs-mobile-react-native-18.20.4.tgz',
    sha256: 'abd4b954dc69ddedb57c1e44906e84ffe7cbb21674faf43c85fa60257122bd12',
  },
  fbjni: {
    url: 'https://repo.maven.apache.org/maven2/com/facebook/fbjni/fbjni/0.7.0/fbjni-0.7.0.aar',
    sha256: '7e319ae110ac5e5ef18904170aea5c3e753e915d196699d7fd39d36c8e1dfe36',
  },
  dx: {
    url: 'https://repo.maven.apache.org/maven2/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar',
    sha256: '1e4b645628e3bdb097b5331d669e177ef235a551582a8c646dbe36865e541907',
  },
  androidAll: {
    url: 'https://repo.maven.apache.org/maven2/org/robolectric/android-all/14-robolectric-10818077/android-all-14-robolectric-10818077.jar',
    sha256: '6be2218c6a53fe3c57bc22ebdc723edcb7270a8a6f187545708aa5c0ed813977',
  },
};

// ------------------------------------------------------------------ tools
const TOOLS = ['java', 'javac', 'keytool', 'aapt', 'zipalign', 'apksigner', 'clang', 'ld.lld', 'tar', 'zip', 'unzip'];
function which(cmd) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, cmd);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const missing = TOOLS.filter((t) => !which(t));
if (missing.length) {
  console.log(JSON.stringify({ ok: false, error: `missing build tools: ${missing.join(', ')} – apt-get install default-jdk-headless aapt zipalign apksigner clang lld zip unzip`, missing }));
  process.exit(2);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fetchCached(name) {
  const d = DOWNLOADS[name];
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, path.basename(new URL(d.url).pathname));
  if (fs.existsSync(file) && sha256(file) === d.sha256) return file;
  say(`downloading ${path.basename(file)}`);
  const r = await fetch(d.url);
  if (!r.ok) throw new Error(`${d.url}: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== d.sha256) throw new Error(`${path.basename(file)}: checksum mismatch (${got})`);
  fs.writeFileSync(file, bytes);
  return file;
}

// ------------------------------------------------------------------ 1. compile the agent
if (!argv.includes('--skip-build')) {
  say('npm run build');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
}
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const build = opt('build') ? Number(opt('build')) : null;
// versionCode must grow with every APK: the release build number, else minutes since 2024
const versionCode = build ?? Math.floor((Date.now() - Date.UTC(2024, 0, 1)) / 60000);
const versionName = build ? `${pkg.version}-${build}` : pkg.version;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-android-'));
try {
  // ---------------------------------------------------------------- 2. payload
  say('collecting the agent payload');
  const payload = path.join(work, 'payload');
  fs.cpSync(path.join(repo, 'dist'), path.join(payload, 'dist'), { recursive: true, filter: (f) => !f.endsWith('.map') });
  fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', private: true }, null, 2));
  let commit = null;
  try {
    commit = run('git', ['rev-parse', '--short', 'HEAD']).trim();
  } catch {
    /* not a git checkout */
  }
  fs.writeFileSync(path.join(payload, 'build-info.json'), JSON.stringify({ version: pkg.version, build, commit, builtAt: new Date().toISOString(), platform: 'android' }, null, 2));

  // packages the agent imports (esbuild follows the imports from the entry), then their dependencies
  const esbuild = require('esbuild');
  const meta = (
    await esbuild.build({ entryPoints: [path.join(repo, 'dist/agent/android.js')], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, packages: 'external', logLevel: 'silent' })
  ).metafile;
  const roots = new Set();
  for (const input of Object.values(meta.inputs)) {
    for (const imp of input.imports ?? []) {
      if (!imp.external || imp.path.startsWith('node:')) continue;
      const name = imp.path.startsWith('@') ? imp.path.split('/').slice(0, 2).join('/') : imp.path.split('/')[0];
      if (!builtinModules.includes(name)) roots.add(name);
    }
  }
  const seen = new Map(); // package dir → name
  const visit = (name, fromDir) => {
    let dir = fromDir;
    for (;;) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        const real = fs.realpathSync(candidate);
        if (seen.has(real)) return;
        seen.set(real, path.relative(repo, candidate));
        const pj = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
        for (const dep of Object.keys({ ...(pj.dependencies ?? {}), ...(pj.optionalDependencies ?? {}) })) visit(dep, candidate);
        return;
      }
      const up = path.dirname(dir);
      if (up === dir) return; // optional dependency not installed (e.g. native helpers for other systems)
      dir = up;
    }
  };
  for (const r of roots) visit(r, repo);
  const SKIP_DIR = /^(test|tests|__tests__|docs?|examples?|benchmarks?|\.github)(\/|$)/i;
  const SKIP_FILE = /\.(md|markdown|map|ts|tsx|flow|node|dll|exe|dylib)$/i; // .node: native addons of the build machine
  for (const [real, rel] of seen) {
    const mcData = rel.endsWith('minecraft-data');
    fs.cpSync(real, path.join(payload, rel), {
      recursive: true,
      dereference: true,
      filter: (f) => {
        const r = path.relative(real, f).split(path.sep).join('/');
        if (!r) return true;
        if (r.startsWith('node_modules')) return false; // nested packages are visited on their own
        if (SKIP_DIR.test(r) || SKIP_FILE.test(r)) return false;
        if (mcData && (/^minecraft-data\/data\/bedrock\/(?!common)/.test(r) || /^(bin|typings)(\/|$)/.test(r))) return false; // Java servers only
        return true;
      },
    });
  }
  say(`payload: ${seen.size} packages`);
  const payloadZip = path.join(work, 'agent.zip');
  run('zip', ['-q', '-r', '-9', '-X', payloadZip, '.'], payload);

  // ---------------------------------------------------------------- 3. native libraries
  say('preparing Node.js for Android');
  const libDir = path.join(work, 'apk', 'lib', ABI);
  fs.mkdirSync(libDir, { recursive: true });
  const nm = await fetchCached('nodejsMobile');
  run('tar', ['-xzf', nm, '-C', work, `package/android/libnode/bin/${ABI}/libnode.so`]);
  fs.renameSync(path.join(work, `package/android/libnode/bin/${ABI}/libnode.so`), path.join(libDir, 'libnode.so'));
  const aar = await fetchCached('fbjni');
  run('unzip', ['-q', '-o', aar, `jni/${ABI}/libc++_shared.so`, '-d', work]);
  fs.renameSync(path.join(work, `jni/${ABI}/libc++_shared.so`), path.join(libDir, 'libc++_shared.so'));
  // JNI bridge – no C library or NDK headers needed (stdio.h is only included by jni.h, unused)
  const jdk = path.resolve(path.dirname(fs.realpathSync(which('javac'))), '..');
  const inc = path.join(work, 'inc');
  fs.mkdirSync(inc);
  fs.writeFileSync(path.join(inc, 'stdio.h'), '');
  const resDir = run('clang', ['-print-resource-dir']).trim();
  run('clang', [
    '--target=aarch64-linux-android24', '-nostdinc', '-isystem', path.join(resDir, 'include'), '-isystem', inc,
    '-I', path.join(jdk, 'include'), '-I', path.join(jdk, 'include', 'linux'),
    '-fPIC', '-shared', '-nostdlib', '-ffreestanding', '-fno-builtin', '-fno-stack-protector', '-O2',
    '-fuse-ld=lld', '-Wl,-soname,libhoelni.so', '-Wl,-z,max-page-size=16384', '-Wl,--allow-shlib-undefined',
    '-L', libDir, '-lnode', path.join(repo, 'android-agent/jni/bridge.c'), '-o', path.join(libDir, 'libhoelni.so'),
  ]);

  // ---------------------------------------------------------------- 4. app
  say('compiling the app');
  const androidJar = await fetchCached('androidAll');
  const gen = path.join(work, 'gen');
  const classes = path.join(work, 'classes');
  fs.mkdirSync(gen);
  fs.mkdirSync(classes);
  const assets = path.join(work, 'assets');
  fs.cpSync(path.join(repo, 'android-agent/assets'), assets, { recursive: true });
  fs.copyFileSync(payloadZip, path.join(assets, 'agent.zip'));
  const unsigned = path.join(work, 'app-unsigned.apk');
  run('aapt', [
    'package', '-f', '-M', path.join(repo, 'android-agent/AndroidManifest.xml'), '-S', path.join(repo, 'android-agent/res'), '-A', assets,
    '-I', androidJar, '-J', gen, '-F', unsigned, '-0', 'zip', '--version-code', String(versionCode), '--version-name', versionName,
  ]);
  const rJava = run('find', [gen, '-name', 'R.java']).trim().split('\n')[0];
  const sources = run('find', [path.join(repo, 'android-agent/java'), '-name', '*.java']).trim().split('\n');
  run('javac', ['-nowarn', '-Xlint:-options', '--release', '8', '-classpath', androidJar, '-d', classes, rJava, ...sources]);
  run('java', ['-cp', await fetchCached('dx'), 'com.android.dx.command.Main', '--dex', '--min-sdk-version=24', `--output=${path.join(work, 'apk', 'classes.dex')}`, classes]);
  run('aapt', ['add', unsigned, 'classes.dex', ...fs.readdirSync(libDir).map((f) => `lib/${ABI}/${f}`)], path.join(work, 'apk'));
  const aligned = path.join(work, 'app-aligned.apk');
  run('zipalign', ['-f', '-p', '4', unsigned, aligned]);

  // signing key: created once, then always the same (updates install only over the same key)
  if (!fs.existsSync(keystore)) {
    say(`creating the signing key ${keystore}`);
    fs.mkdirSync(path.dirname(keystore), { recursive: true });
    const pass = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(`${keystore}.pass`, pass, { mode: 0o600 });
    run('keytool', ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-storepass', pass, '-keypass', pass, '-alias', 'hoelni', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '18250', '-dname', 'CN=Hoelni Agent, O=Hoelni']);
    fs.chmodSync(keystore, 0o600);
  }
  const pass = fs.readFileSync(`${keystore}.pass`, 'utf8').trim();
  const file = `Hoelni-Agent-Android-${versionName}.apk`;
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, file);
  run('apksigner', ['sign', '--ks', keystore, '--ks-pass', `pass:${pass}`, '--ks-key-alias', 'hoelni', '--min-sdk-version', '24', '--out', target, aligned]);
  run('apksigner', ['verify', target]);
  const size = fs.statSync(target).size;
  say(`${file} (${(size / 1e6).toFixed(1)} MB)`);
  console.log(JSON.stringify({ ok: true, kind: 'android', file, path: target, size, sha256: sha256(target), version: versionName, build, versionCode }));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
