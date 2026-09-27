/**
 * Verified downloads for the launcher: SHA-1 check, atomic writes, retries,
 * bounded parallelism and optional mirror rewriting (e.g. for regions where
 * Mojang/Fabric hosts are slow or blocked).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadItem {
  url: string;
  file: string;
  sha1?: string;
  size?: number;
  executable?: boolean;
}

export interface DownloadProgress {
  done: number;
  total: number;
  bytes: number;
  current?: string;
}

/** host → base URL replacement, e.g. { 'piston-meta.mojang.com': 'https://mirror.example/meta' } */
export type MirrorMap = Record<string, string>;

export function applyMirror(url: string, mirrors: MirrorMap = {}): string {
  try {
    const u = new URL(url);
    const base = mirrors[u.host];
    if (!base) return url;
    return base.replace(/\/$/, '') + u.pathname + u.search;
  } catch {
    return url;
  }
}

export async function sha1File(file: string): Promise<string> {
  const h = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Is the file present and (if a hash is known) correct? */
export async function isValid(item: DownloadItem): Promise<boolean> {
  if (!fs.existsSync(item.file)) return false;
  const st = fs.statSync(item.file);
  if (item.size !== undefined && st.size !== item.size) return false;
  if (!item.sha1) return st.size > 0;
  return (await sha1File(item.file)) === item.sha1.toLowerCase();
}

export class Downloader {
  constructor(
    private readonly mirrors: MirrorMap = {},
    private readonly concurrency = 16,
    private readonly retries = 3,
    private readonly timeoutMs = 60_000,
  ) {}

  async fetchJson<T>(url: string): Promise<T> {
    const res = await this.fetchWithRetry(url);
    return (await res.json()) as T;
  }

  /** Downloads a JSON document to a file (verified), then parses it. */
  async jsonFile<T>(item: DownloadItem): Promise<T> {
    await this.downloadOne(item);
    return JSON.parse(fs.readFileSync(item.file, 'utf8')) as T;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    const target = applyMirror(url, this.mirrors);
    let last: unknown;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const res = await fetch(target, { signal: AbortSignal.timeout(this.timeoutMs), headers: { 'User-Agent': 'HoelniClientSuite/0.2' } });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${target}`);
        return res;
      } catch (e) {
        last = e;
        if (attempt < this.retries) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`Download failed: ${target} (${(last as Error)?.message ?? last})`);
  }

  async downloadOne(item: DownloadItem): Promise<number> {
    if (await isValid(item)) return 0;
    fs.mkdirSync(path.dirname(item.file), { recursive: true });
    const tmp = `${item.file}.part`;
    const res = await this.fetchWithRetry(item.url);
    if (!res.body) throw new Error(`Empty response for ${item.url}`);
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
    if (item.sha1) {
      const got = await sha1File(tmp);
      if (got !== item.sha1.toLowerCase()) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`Checksum mismatch for ${path.basename(item.file)} (expected ${item.sha1}, got ${got})`);
      }
    }
    fs.renameSync(tmp, item.file);
    if (item.executable && process.platform !== 'win32') fs.chmodSync(item.file, 0o755);
    return fs.statSync(item.file).size;
  }

  async downloadAll(items: DownloadItem[], onProgress?: (p: DownloadProgress) => void): Promise<void> {
    const unique = [...new Map(items.map((i) => [path.resolve(i.file), i])).values()];
    let next = 0;
    let done = 0;
    let bytes = 0;
    const errors: string[] = [];
    const worker = async () => {
      while (next < unique.length) {
        const item = unique[next++];
        try {
          bytes += await this.downloadOne(item);
        } catch (e) {
          errors.push((e as Error).message);
        }
        done++;
        onProgress?.({ done, total: unique.length, bytes, current: path.basename(item.file) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, unique.length || 1) }, worker));
    if (errors.length) throw new Error(`${errors.length} download(s) failed: ${errors.slice(0, 3).join('; ')}`);
  }
}
