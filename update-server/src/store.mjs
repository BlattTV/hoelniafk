/**
 * Release store on disk.
 *
 *   <dataDir>/releases/<build>/manifest.json   signed envelope
 *   <dataDir>/releases/<build>/<files>          backend bundle, optional Windows installer
 *   <dataDir>/channels.json                     { stable: <build>, beta: <build> }
 *   <dataDir>/state.json                        { nextBuild, lastCommit }
 *   <dataDir>/downloads/                        latest Windows installers (suite + agent) + downloads.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256, signManifest } from './sign.mjs';

export const PRODUCT = 'hoelni-client-suite';
const SAFE_FILE = /^[A-Za-z0-9._-]{1,120}$/;

export class Store {
  constructor(dataDir, privatePem) {
    this.dataDir = dataDir;
    this.privatePem = privatePem;
    fs.mkdirSync(path.join(dataDir, 'releases'), { recursive: true });
  }

  readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJson(name, value) {
    const file = path.join(this.dataDir, name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  get state() {
    return this.readJson('state.json', { nextBuild: 1, lastCommit: null });
  }

  set state(v) {
    this.writeJson('state.json', v);
  }

  get channels() {
    return this.readJson('channels.json', {});
  }

  releaseDir(build) {
    return path.join(this.dataDir, 'releases', String(Number(build)));
  }

  envelope(build) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.releaseDir(build), 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  list() {
    return fs
      .readdirSync(path.join(this.dataDir, 'releases'))
      .filter((d) => /^\d+$/.test(d))
      .map(Number)
      .sort((a, b) => b - a)
      .map((b) => this.envelope(b)?.manifest)
      .filter(Boolean);
  }

  latest(channel) {
    const build = this.channels[channel];
    return build ? this.envelope(build) : null;
  }

  /** Absolute path of a release file, only for files named in its manifest. */
  filePath(build, name) {
    if (!SAFE_FILE.test(name)) return null;
    const m = this.envelope(build)?.manifest;
    if (!m) return null;
    const known = [m.backend?.file, m.installer?.file].filter(Boolean);
    if (!known.includes(name)) return null;
    const p = path.join(this.releaseDir(build), name);
    return fs.existsSync(p) ? p : null;
  }

  /** Creates a new release from a finished backend bundle (zip bytes). */
  publish({ bundle, version, commit, branch, notes, lockHash, channel }) {
    const st = this.state;
    const build = st.nextBuild;
    const dir = this.releaseDir(build);
    fs.mkdirSync(dir, { recursive: true });
    const file = `backend-${build}.zip`;
    fs.writeFileSync(path.join(dir, file), bundle);
    const manifest = {
      schema: 1,
      product: PRODUCT,
      build,
      version: `${version}+${build}${commit ? `.${commit.slice(0, 7)}` : ''}`,
      commit: commit ?? null,
      branch: branch ?? null,
      createdAt: new Date().toISOString(),
      notes: notes ?? [],
      lockHash,
      backend: { file, sha256: sha256(bundle), size: bundle.length },
      installer: null,
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(signManifest(manifest, this.privatePem), null, 2));
    this.state = { ...st, nextBuild: build + 1, lastCommit: commit ?? st.lastCommit };
    if (channel) this.promote(channel, build);
    return manifest;
  }

  /** Attaches a Windows installer (built on Windows with `npm run dist` in desktop/). */
  attachInstaller(build, name, bytes, desktopVersion) {
    if (!SAFE_FILE.test(name) || !/\.exe$/i.test(name)) throw new Error('Installer name must be a plain *.exe file name');
    const env = this.envelope(build);
    if (!env) throw new Error(`Unknown build ${build}`);
    fs.writeFileSync(path.join(this.releaseDir(build), name), bytes);
    const manifest = { ...env.manifest, installer: { file: name, sha256: sha256(bytes), size: bytes.length, desktopVersion: desktopVersion ?? null } };
    fs.writeFileSync(path.join(this.releaseDir(build), 'manifest.json'), JSON.stringify(signManifest(manifest, this.privatePem), null, 2));
    return manifest;
  }

  // ---------------------------------------------------------------- downloads (installers for new PCs)

  get downloads() {
    return this.readJson(path.join('downloads', 'downloads.json'), { items: {}, inputsHash: null });
  }

  /** Replaces the offered installers: entries { kind, path, file, size, sha256, version } from build-installers.mjs. */
  setDownloads(entries, meta = {}) {
    const dir = path.join(this.dataDir, 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const items = { ...this.downloads.items };
    for (const e of entries) {
      if (!SAFE_FILE.test(e.file) || !/\.exe$/i.test(e.file)) throw new Error(`Bad installer name ${e.file}`);
      fs.copyFileSync(e.path, path.join(dir, `${e.file}.tmp`));
      fs.renameSync(path.join(dir, `${e.file}.tmp`), path.join(dir, e.file));
      items[e.kind] = { kind: e.kind, file: e.file, size: e.size, sha256: e.sha256, version: e.version, build: meta.build ?? null, builtAt: new Date().toISOString() };
    }
    const keep = new Set([...Object.values(items).map((i) => i.file), 'downloads.json']);
    for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
    this.writeJson(path.join('downloads', 'downloads.json'), { items, inputsHash: meta.inputsHash ?? this.downloads.inputsHash });
    return this.downloads;
  }

  downloadPath(name) {
    if (!SAFE_FILE.test(name)) return null;
    if (!Object.values(this.downloads.items).some((i) => i.file === name)) return null;
    const p = path.join(this.dataDir, 'downloads', name);
    return fs.existsSync(p) ? p : null;
  }

  promote(channel, build) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(channel)) throw new Error('Invalid channel name');
    if (!this.envelope(build)) throw new Error(`Unknown build ${build}`);
    this.writeJson('channels.json', { ...this.channels, [channel]: Number(build) });
  }

  /** Keeps the newest `keep` releases plus everything a channel points to. */
  prune(keep) {
    const pinned = new Set(Object.values(this.channels).map(Number));
    const builds = this.list().map((m) => m.build);
    for (const b of builds.slice(keep)) if (!pinned.has(b)) fs.rmSync(this.releaseDir(b), { recursive: true, force: true });
  }
}
