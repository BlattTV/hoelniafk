/**
 * Installs the official Minecraft Java client (and optionally Fabric) the same
 * way the official launcher does:
 *
 *   version_manifest_v2 → version json → client jar, libraries (+ natives),
 *   asset index + objects, logging config, Mojang Java runtime
 *
 * Every file is SHA-1 verified. Libraries/assets/runtimes are shared by all
 * instances; each session gets its own game directory (see ClientManager).
 */
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { DownloadItem, DownloadProgress, Downloader } from './download.js';
import { javaRuntimePlatform, mavenPath, rulesAllow, type Platform } from './rules.js';
import type { AssetIndex, JavaRuntimeIndex, JavaRuntimeManifest, Library, VersionJson, VersionManifest } from './types.js';

export const ENDPOINTS = {
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  javaRuntimes: 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
  resources: 'https://resources.download.minecraft.net',
  libraries: 'https://libraries.minecraft.net',
  fabricMeta: 'https://meta.fabricmc.net',
};

export type Loader = 'vanilla' | 'fabric';

export interface InstallRequest {
  version: string; // e.g. "1.21.4" or "latest-release"
  loader: Loader;
  loaderVersion?: string; // fabric loader version, default = latest stable
}

export interface InstalledVersion {
  id: string;
  gameVersion: string;
  loader: Loader;
  json: VersionJson;
  mainClass: string;
  classpath: string[];
  nativesDir: string;
  librariesDir: string;
  assetsRoot: string;
  assetIndexId: string;
  javaComponent: string;
  javaMajor: number;
  logConfigArg: string | null;
  supportsQuickPlay: boolean;
}

export type ProgressFn = (stage: string, p: DownloadProgress) => void;

export class Installer {
  readonly dirs: { versions: string; libraries: string; assets: string; runtimes: string; natives: string; logConfigs: string };

  constructor(
    readonly root: string,
    private readonly dl: Downloader,
    private readonly platform: Platform,
    private readonly endpoints = ENDPOINTS,
  ) {
    this.dirs = {
      versions: path.join(root, 'versions'),
      libraries: path.join(root, 'libraries'),
      assets: path.join(root, 'assets'),
      runtimes: path.join(root, 'runtime'),
      natives: path.join(root, 'natives'),
      logConfigs: path.join(root, 'assets', 'log_configs'),
    };
  }

  async manifest(): Promise<VersionManifest> {
    return this.dl.fetchJson<VersionManifest>(this.endpoints.versionManifest);
  }

  async resolveVersion(req: string): Promise<string> {
    if (req !== 'latest-release' && req !== 'latest-snapshot') return req;
    const m = await this.manifest();
    return req === 'latest-release' ? m.latest.release : m.latest.snapshot;
  }

  /** Loads (downloading if needed) the vanilla version json. */
  private async vanillaJson(id: string): Promise<VersionJson> {
    const file = path.join(this.dirs.versions, id, `${id}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as VersionJson;
    const m = await this.manifest();
    const entry = m.versions.find((v) => v.id === id);
    if (!entry) throw new Error(`Unknown Minecraft version "${id}"`);
    return this.dl.jsonFile<VersionJson>({ url: entry.url, file, sha1: entry.sha1 });
  }

  private async fabricJson(gameVersion: string, loaderVersion?: string): Promise<VersionJson> {
    let lv = loaderVersion;
    if (!lv) {
      const loaders = await this.dl.fetchJson<Array<{ loader: { version: string; stable: boolean } }>>(`${this.endpoints.fabricMeta}/v2/versions/loader/${gameVersion}`);
      const stable = loaders.find((l) => l.loader.stable) ?? loaders[0];
      if (!stable) throw new Error(`Fabric does not support Minecraft ${gameVersion}`);
      lv = stable.loader.version;
    }
    const id = `fabric-loader-${lv}-${gameVersion}`;
    const file = path.join(this.dirs.versions, id, `${id}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as VersionJson;
    const json = await this.dl.fetchJson<VersionJson>(`${this.endpoints.fabricMeta}/v2/versions/loader/${gameVersion}/${lv}/profile/json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 1));
    return json;
  }

  /** Child (e.g. Fabric) + parent (vanilla) → one effective version json. */
  static merge(child: VersionJson, parent: VersionJson): VersionJson {
    const key = (l: Library) => l.name.split(':').slice(0, 2).join(':') + (l.name.split(':')[3] ? `:${l.name.split(':')[3]}` : '');
    const childKeys = new Set(child.libraries.map(key));
    return {
      ...parent,
      id: child.id,
      mainClass: child.mainClass || parent.mainClass,
      libraries: [...child.libraries, ...parent.libraries.filter((l) => !childKeys.has(key(l)))],
      arguments: {
        game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
        jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])],
      },
      minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
      inheritsFrom: undefined,
    };
  }

  /** Library → download item (+ whether it is a natives archive to extract). */
  libraryItems(json: VersionJson): Array<DownloadItem & { natives: boolean; exclude: string[] }> {
    const out: Array<DownloadItem & { natives: boolean; exclude: string[] }> = [];
    for (const lib of json.libraries) {
      if (!rulesAllow(lib.rules, this.platform)) continue;
      const exclude = lib.extract?.exclude ?? [];
      if (lib.downloads?.artifact) {
        const a = lib.downloads.artifact;
        const rel = a.path ?? mavenPath(lib.name);
        if (a.url) out.push({ url: a.url, file: path.join(this.dirs.libraries, rel), sha1: a.sha1, size: a.size, natives: false, exclude });
      } else if (!lib.downloads && lib.url !== undefined) {
        const rel = mavenPath(lib.name);
        out.push({ url: `${lib.url.replace(/\/$/, '')}/${rel}`, file: path.join(this.dirs.libraries, rel), sha1: lib.sha1, size: lib.size, natives: false, exclude });
      } else if (!lib.downloads && !lib.url) {
        const rel = mavenPath(lib.name);
        out.push({ url: `${this.endpoints.libraries}/${rel}`, file: path.join(this.dirs.libraries, rel), natives: false, exclude });
      }
      // old-style natives: classifier selected by the "natives" map
      const nativeKey = lib.natives?.[this.platform.name];
      if (nativeKey && lib.downloads?.classifiers) {
        const cls = nativeKey.replace('${arch}', this.platform.arch === 'x86' ? '32' : '64');
        const a = lib.downloads.classifiers[cls];
        if (a) out.push({ url: a.url, file: path.join(this.dirs.libraries, a.path ?? mavenPath(`${lib.name}:${cls}`)), sha1: a.sha1, size: a.size, natives: true, exclude });
      }
    }
    return out;
  }

  private extractNatives(archives: Array<{ file: string; exclude: string[] }>, dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const a of archives) {
      const entries = unzipSync(new Uint8Array(fs.readFileSync(a.file)));
      for (const [name, data] of Object.entries(entries)) {
        if (name.endsWith('/') || a.exclude.some((ex) => name.startsWith(ex)) || name.startsWith('META-INF/')) continue;
        const target = path.join(dir, name);
        if (!target.startsWith(path.resolve(dir))) continue; // zip-slip guard
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      }
    }
  }

  async install(req: InstallRequest, onProgress?: ProgressFn): Promise<InstalledVersion> {
    const gameVersion = await this.resolveVersion(req.version);
    const vanilla = await this.vanillaJson(gameVersion);
    const json = req.loader === 'fabric' ? Installer.merge(await this.fabricJson(gameVersion, req.loaderVersion), vanilla) : vanilla;
    const id = json.id;

    // client jar
    const clientJar = path.join(this.dirs.versions, gameVersion, `${gameVersion}.jar`);
    const client = vanilla.downloads?.client;
    if (!client) throw new Error(`Version ${gameVersion} has no client download`);
    const libs = this.libraryItems(json);
    await this.dl.downloadAll([{ url: client.url, file: clientJar, sha1: client.sha1, size: client.size }, ...libs], (p) => onProgress?.('libraries', p));

    // natives
    const nativesDir = path.join(this.dirs.natives, id);
    const nativeArchives = libs.filter((l) => l.natives);
    if (nativeArchives.length) this.extractNatives(nativeArchives, nativesDir);
    else fs.mkdirSync(nativesDir, { recursive: true });

    // assets
    const ai = vanilla.assetIndex;
    if (!ai) throw new Error(`Version ${gameVersion} has no asset index`);
    const index = await this.dl.jsonFile<AssetIndex>({ url: ai.url, file: path.join(this.dirs.assets, 'indexes', `${ai.id}.json`), sha1: ai.sha1 });
    const objects = Object.values(index.objects).map((o) => ({
      url: `${this.endpoints.resources}/${o.hash.slice(0, 2)}/${o.hash}`,
      file: path.join(this.dirs.assets, 'objects', o.hash.slice(0, 2), o.hash),
      sha1: o.hash,
      size: o.size,
    }));
    await this.dl.downloadAll(objects, (p) => onProgress?.('assets', p));

    // logging config
    let logConfigArg: string | null = null;
    const lc = vanilla.logging?.client;
    if (lc) {
      const file = path.join(this.dirs.logConfigs, lc.file.id);
      await this.dl.downloadOne({ url: lc.file.url, file, sha1: lc.file.sha1 });
      logConfigArg = lc.argument.replace('${path}', file);
    }

    const classpath = [...libs.filter((l) => !l.natives).map((l) => l.file), clientJar];
    const supportsQuickPlay = JSON.stringify(json.arguments?.game ?? []).includes('is_quick_play_multiplayer');
    return {
      id,
      gameVersion,
      loader: req.loader,
      json,
      mainClass: json.mainClass,
      classpath: [...new Set(classpath)],
      nativesDir,
      librariesDir: this.dirs.libraries,
      assetsRoot: this.dirs.assets,
      assetIndexId: ai.id,
      javaComponent: vanilla.javaVersion?.component ?? 'jre-legacy',
      javaMajor: vanilla.javaVersion?.majorVersion ?? 8,
      logConfigArg,
      supportsQuickPlay,
    };
  }

  /** Installs Mojang's Java runtime for the component (e.g. "java-runtime-delta") and returns the java executable. */
  async ensureJava(component: string, onProgress?: ProgressFn): Promise<string> {
    const plat = javaRuntimePlatform(this.platform);
    const dir = path.join(this.dirs.runtimes, component, plat);
    const exe = path.join(dir, 'bin', this.platform.name === 'windows' ? 'javaw.exe' : 'java');
    const exeMac = path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
    const marker = path.join(dir, '.hoelni-complete');
    if (fs.existsSync(marker)) return fs.existsSync(exe) ? exe : exeMac;
    const index = await this.dl.fetchJson<JavaRuntimeIndex>(this.endpoints.javaRuntimes);
    const entry = index[plat]?.[component]?.[0];
    if (!entry) throw new Error(`No Mojang Java runtime "${component}" for ${plat} – configure client.javaPath instead`);
    const manifest = await this.dl.fetchJson<JavaRuntimeManifest>(entry.manifest.url);
    const items: DownloadItem[] = [];
    const links: Array<[string, string]> = [];
    for (const [rel, f] of Object.entries(manifest.files)) {
      const target = path.join(dir, rel);
      if (f.type === 'directory') fs.mkdirSync(target, { recursive: true });
      else if (f.type === 'file') items.push({ url: f.downloads.raw.url, file: target, sha1: f.downloads.raw.sha1, size: f.downloads.raw.size, executable: f.executable });
      else if (f.type === 'link') links.push([target, f.target]);
    }
    await this.dl.downloadAll(items, (p) => onProgress?.('java', p));
    for (const [target, to] of links) {
      if (this.platform.name === 'windows') continue;
      try {
        fs.rmSync(target, { force: true });
        fs.symlinkSync(to, target);
      } catch {
        /* ignore */
      }
    }
    fs.writeFileSync(marker, entry.version.name);
    return fs.existsSync(exe) ? exe : exeMac;
  }
}
