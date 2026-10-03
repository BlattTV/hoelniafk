import { detectPublicIp, DEFAULT_IP_ENDPOINTS } from './publicIp.js';

export interface PublicIpState {
  /** Public IP of this device as the internet sees it (direct, without proxy) – null until known. */
  ip: string | null;
  checkedAt: string | null;
  error: string | null;
}

/** IP echo services (HOELNI_IP_ENDPOINTS, comma separated, overrides them – tests, own service). */
export function ipEndpoints(): string[] {
  const env = process.env.HOELNI_IP_ENDPOINTS?.split(',').map((x) => x.trim()).filter(Boolean);
  return env?.length ? env : DEFAULT_IP_ENDPOINTS;
}

/**
 * Keeps the public IP of this device (suite or agent) up to date: on start, every 30 minutes and on
 * demand. Sessions without a proxy / network profile connect to the Minecraft servers with this IP.
 */
export class PublicIpWatcher {
  state: PublicIpState = { ip: null, checkedAt: null, error: null };
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<PublicIpState> | null = null;

  private readonly intervalMs: number;
  private readonly detect: () => Promise<string>;

  constructor(
    private readonly onChange: (s: PublicIpState) => void = () => undefined,
    opts: { intervalMs?: number; detect?: () => Promise<string> } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 30 * 60_000;
    this.detect = opts.detect ?? (() => detectPublicIp(null, null, ipEndpoints(), 8000));
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<PublicIpState> {
    if (this.running) return this.running;
    this.running = (async () => {
      const before = this.state.ip;
      try {
        const ip = await this.detect();
        this.state = { ip, checkedAt: new Date().toISOString(), error: null };
      } catch (e) {
        // keep the last known IP – a short outage of the echo services says nothing about it
        this.state = { ip: this.state.ip, checkedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 300) };
      }
      if (before !== this.state.ip || this.state.error) this.onChange(this.state);
      return this.state;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
