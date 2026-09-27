/**
 * Local stand-in for Mojang's and Fabric's download infrastructure, serving
 * synthetic but format-correct metadata (version manifest v2, version json with
 * rules/natives/quick play arguments, asset index, logging config, Java runtime
 * all.json + manifest, Fabric meta profile). Used through the launcher's mirror
 * mechanism: every official host is mapped to http://127.0.0.1:<port>/<host>.
 *
 * The "Java runtime" it serves is a tiny wrapper that runs the client emulator.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const sha1 = (b: Buffer | Uint8Array) => crypto.createHash('sha1').update(b).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));

export const HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'libraries.minecraft.net', 'resources.download.minecraft.net', 'meta.fabricmc.net', 'maven.fabricmc.net'];

export interface FakeMojang {
  port: number;
  mirrors: Record<string, string>;
  requests: string[];
  /** Corrupt a served file (for checksum tests). */
  corrupt(urlPath: string): void;
  close(): Promise<void>;
}

export async function startFakeMojang(opts: { version?: string; javaScript?: string } = {}): Promise<FakeMojang> {
  const version = opts.version ?? '1.20.1';
  const files = new Map<string, Buffer>();
  const requests: string[] = [];
  let base = '';
  const put = (host: string, p: string, data: Buffer | string) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    files.set(`/${host}${p}`, buf);
    return { url: `https://${host}${p}`, sha1: sha1(buf), size: buf.length };
  };
  const jar = (entries: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))));

  // --- libraries
  const lib = (name: string, entries: Record<string, string>) => {
    const [g, a, v, c] = name.split(':');
    const rel = `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? `-${c}` : ''}.jar`;
    const art = put('libraries.minecraft.net', `/${rel}`, jar(entries));
    return { path: rel, ...art };
  };
  const common = lib('com.mojang:brigadier:1.1.8', { 'com/mojang/brigadier/Command.class': 'x' });
  const asm = lib('org.ow2.asm:asm:9.3', { 'org/objectweb/asm/Opcodes.class': 'old' });
  const winOnly = lib('org.lwjgl:lwjgl-windows-only:3.3.1', { 'x.class': 'x' });
  const nativesLinux = lib('org.lwjgl.lwjgl:lwjgl-platform:2.9.4:natives-linux', { 'liblwjgl64.so': 'ELF', 'META-INF/MANIFEST.MF': 'x' });
  const nativesWin = lib('org.lwjgl.lwjgl:lwjgl-platform:2.9.4:natives-windows', { 'lwjgl64.dll': 'MZ', 'META-INF/MANIFEST.MF': 'x' });
  const nativesOsx = lib('org.lwjgl.lwjgl:lwjgl-platform:2.9.4:natives-osx', { 'liblwjgl.dylib': 'MACHO' });
  const client = put('piston-data.mojang.com', `/v1/objects/client/${version}.jar`, jar({ 'net/minecraft/client/main/Main.class': 'main' }));
  const logCfg = put('piston-data.mojang.com', '/v1/objects/log/client-1.12.xml', '<Configuration/>');

  // --- assets
  const objA = Buffer.from('{"pack":{"description":"emulated"}}');
  const objB = Buffer.from('sound-bytes');
  const assetIndex = { objects: { 'pack.mcmeta': { hash: sha1(objA), size: objA.length }, 'minecraft/sounds/x.ogg': { hash: sha1(objB), size: objB.length } } };
  for (const o of [objA, objB]) put('resources.download.minecraft.net', `/${sha1(o).slice(0, 2)}/${sha1(o)}`, o);
  const ai = put('piston-meta.mojang.com', `/v1/packages/index/5.json`, JSON.stringify(assetIndex));

  const versionJson = {
    id: version,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '5', sha1: ai.sha1, size: ai.size, totalSize: objA.length + objB.length, url: ai.url },
    downloads: { client: { sha1: client.sha1, size: client.size, url: client.url } },
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.12.xml', sha1: logCfg.sha1, size: logCfg.size, url: logCfg.url }, type: 'log4j2-xml' } },
    libraries: [
      { name: 'com.mojang:brigadier:1.1.8', downloads: { artifact: common } },
      { name: 'org.ow2.asm:asm:9.3', downloads: { artifact: asm } },
      { name: 'org.lwjgl:lwjgl-windows-only:3.3.1', downloads: { artifact: winOnly }, rules: [{ action: 'allow', os: { name: 'windows' } }] },
      {
        name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4',
        downloads: { classifiers: { 'natives-linux': nativesLinux, 'natives-windows': nativesWin, 'natives-osx': nativesOsx } },
        natives: { linux: 'natives-linux', windows: 'natives-windows', osx: 'natives-osx' },
        extract: { exclude: ['META-INF/'] },
      },
    ],
    arguments: {
      game: [
        '--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--assetsDir', '${assets_root}',
        '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--clientId', '${clientid}',
        '--xuid', '${auth_xuid}', '--userType', '${user_type}', '--versionType', '${version_type}',
        { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
        { rules: [{ action: 'allow', features: { has_quick_plays_support: true } }], value: ['--quickPlayPath', '${quickPlayPath}'] },
        { rules: [{ action: 'allow', features: { is_quick_play_singleplayer: true } }], value: ['--quickPlaySingleplayer', '${quickPlaySingleplayer}'] },
        { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] },
      ],
      jvm: [
        { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
        { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump' },
        '-Djava.library.path=${natives_directory}', '-Dminecraft.launcher.brand=${launcher_name}', '-Dminecraft.launcher.version=${launcher_version}', '-cp', '${classpath}',
      ],
    },
  };
  const vj = put('piston-meta.mojang.com', `/v1/packages/abc/${version}.json`, JSON.stringify(versionJson));
  put('piston-meta.mojang.com', '/mc/game/version_manifest_v2.json', JSON.stringify({ latest: { release: version, snapshot: version }, versions: [{ id: version, type: 'release', url: vj.url, sha1: vj.sha1 }] }));

  // --- Fabric
  const fabricLoader = '0.16.0';
  const fabricLib = (name: string) => {
    const [g, a, v] = name.split(':');
    put('maven.fabricmc.net', `/${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}.jar`, jar({ [`${a}.class`]: name }));
    return { name, url: 'https://maven.fabricmc.net/' };
  };
  put('meta.fabricmc.net', `/v2/versions/loader/${version}`, JSON.stringify([{ loader: { version: fabricLoader, stable: true } }]));
  put(
    'meta.fabricmc.net',
    `/v2/versions/loader/${version}/${fabricLoader}/profile/json`,
    JSON.stringify({
      id: `fabric-loader-${fabricLoader}-${version}`,
      inheritsFrom: version,
      type: 'release',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      arguments: { game: [], jvm: ['-DFabricMcEmu=true'] },
      libraries: [fabricLib('org.ow2.asm:asm:9.6'), fabricLib(`net.fabricmc:fabric-loader:${fabricLoader}`), fabricLib('net.fabricmc:intermediary:' + version)],
    }),
  );

  // --- Java runtime: "bin/java" runs the client emulator
  const emulator = path.join(here, 'clientEmulator.mjs');
  const javaScript = opts.javaScript ?? `#!/bin/sh\nexec "${process.execPath}" "${emulator}" "$@"\n`;
  const javaFile = put('piston-data.mojang.com', '/v1/objects/java/bin-java', javaScript);
  const release = put('piston-data.mojang.com', '/v1/objects/java/release', 'JAVA_VERSION="17.0.8"');
  const plat = process.platform === 'win32' ? 'windows-x64' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os') : process.arch === 'arm64' ? 'linux-arm64' : 'linux';
  const exeName = process.platform === 'win32' ? 'bin/javaw.exe' : 'bin/java';
  const manifest = put(
    'piston-meta.mojang.com',
    '/v1/packages/java/manifest.json',
    JSON.stringify({
      files: {
        bin: { type: 'directory' },
        [exeName]: { type: 'file', executable: true, downloads: { raw: { sha1: javaFile.sha1, size: javaFile.size, url: javaFile.url } } },
        release: { type: 'file', executable: false, downloads: { raw: { sha1: release.sha1, size: release.size, url: release.url } } },
        'bin/java-link': { type: 'link', target: 'java' },
      },
    }),
  );
  put(
    'launchermeta.mojang.com',
    '/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
    JSON.stringify({ [plat]: { 'java-runtime-gamma': [{ manifest: { sha1: manifest.sha1, size: manifest.size, url: manifest.url }, version: { name: '17.0.8' } }] } }),
  );

  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    requests.push(p);
    const body = files.get(p);
    if (!body) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port as number;
  base = `http://127.0.0.1:${port}`;
  const mirrors = Object.fromEntries(HOSTS.map((h) => [h, `${base}/${h}`]));
  return {
    port,
    mirrors,
    requests,
    corrupt: (p) => {
      const b = files.get(p);
      if (b) files.set(p, Buffer.concat([b, Buffer.from('!')]));
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Writes a java stand-in that runs the emulator (for tests that pass javaPath explicitly). */
export function writeJavaWrapper(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'java-emulator.sh');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'clientEmulator.mjs')}" "$@"\n`, { mode: 0o755 });
  return file;
}
