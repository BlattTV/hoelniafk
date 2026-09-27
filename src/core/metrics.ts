/**
 * Monitoring: periodic samples of the main process, every runtime host and
 * the sessions. Keeps a short history for the Monitoring page.
 */
import fs from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { SessionManager } from '../minecraft/sessionManager.js';
import type { MinecraftRuntime } from '../runtime/types.js';

export interface MetricsSample {
  ts: string;
  main: { pid: number; rss: number; heapUsed: number; cpuPercent: number; eventLoopLagMs: number; eventLoopLagP99Ms: number; threads: number | null };
  hosts: { count: number; rss: number; cpuPercent: number; maxLagMs: number; threads: number | null };
  sessions: { total: number; online: number; connecting: number; reconnecting: number; blocked: number; stopped: number; viewsOpen: number };
  network: { bytesIn: number; bytesOut: number; inPerSec: number; outPerSec: number };
  processes: number;
  system: { totalMem: number; freeMem: number; load1: number; cpus: number };
}

export function threadCount(pid = process.pid): number | null {
  try {
    const m = /^Threads:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export class MetricsCollector {
  private readonly history: MetricsSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private lastCpu = process.cpuUsage();
  private lastAt = Date.now();
  private lastBytes = { in: 0, out: 0, at: Date.now() };

  constructor(
    private readonly sessions: SessionManager,
    private readonly runtime: MinecraftRuntime,
    private readonly maxSamples = 180,
  ) {}

  start(intervalMs = 5000): void {
    this.lag.enable();
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.lag.disable();
  }

  sample(): MetricsSample {
    const now = Date.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsed = Math.max(1, now - this.lastAt);
    this.lastCpu = process.cpuUsage();
    this.lastAt = now;
    const mem = process.memoryUsage();
    const hosts = this.runtime.stats().hosts;
    const sessions = this.sessions.list();
    const count = (st: string[]) => sessions.filter((s) => st.includes(s.state)).length;
    let bytesIn = 0;
    let bytesOut = 0;
    for (const s of sessions) {
      bytesIn += s.stats?.bytesIn ?? 0;
      bytesOut += s.stats?.bytesOut ?? 0;
    }
    const dt = Math.max(1, (now - this.lastBytes.at) / 1000);
    const inPerSec = Math.max(0, (bytesIn - this.lastBytes.in) / dt);
    const outPerSec = Math.max(0, (bytesOut - this.lastBytes.out) / dt);
    this.lastBytes = { in: bytesIn, out: bytesOut, at: now };
    const hostThreads = hosts.map((h) => h.threads).filter((t): t is number => typeof t === 'number');
    const sample: MetricsSample = {
      ts: new Date(now).toISOString(),
      main: {
        pid: process.pid,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / elapsed) * 1000) / 10,
        eventLoopLagMs: Math.round((this.lag.mean / 1e6) * 10) / 10 || 0,
        eventLoopLagP99Ms: Math.round((this.lag.percentile(99) / 1e6) * 10) / 10 || 0,
        threads: threadCount(),
      },
      hosts: {
        count: hosts.length,
        rss: hosts.reduce((a, h) => a + h.rss, 0),
        cpuPercent: Math.round(hosts.reduce((a, h) => a + h.cpuPercent, 0) * 10) / 10,
        maxLagMs: hosts.reduce((a, h) => Math.max(a, h.eventLoopLagMs), 0),
        threads: hostThreads.length ? hostThreads.reduce((a, b) => a + b, 0) : null,
      },
      sessions: {
        total: sessions.length,
        online: count(['ONLINE']),
        connecting: count(['STARTING', 'CONNECTING', 'AUTHENTICATING']),
        reconnecting: count(['RECONNECTING']),
        blocked: count(['BLOCKED']),
        stopped: count(['STOPPED', 'STOPPING']),
        viewsOpen: sessions.filter((s) => s.viewOpen).length,
      },
      network: { bytesIn, bytesOut, inPerSec: Math.round(inPerSec), outPerSec: Math.round(outPerSec) },
      processes: 1 + hosts.filter((h) => h.pid !== process.pid).length,
      system: { totalMem: os.totalmem(), freeMem: os.freemem(), load1: Math.round(os.loadavg()[0] * 100) / 100, cpus: os.cpus().length },
    };
    this.lag.reset();
    this.history.push(sample);
    if (this.history.length > this.maxSamples) this.history.splice(0, this.history.length - this.maxSamples);
    return sample;
  }

  snapshot() {
    return {
      current: this.history.at(-1) ?? this.sample(),
      history: this.history,
      hosts: this.runtime.stats().hosts,
    };
  }
}
