import type { IdentityRepository } from '../identity/repository.js';

/**
 * Notices when star earning is abnormal and raises an alert (shown in the suite and the Control app,
 * which turns new alerts into phone notifications). Per account and counted server, compared with what
 * that account normally does (the last 7 days):
 * - stall: online for a while, but no star for much longer than its usual gap between two stars
 * - spike: far more stars in the last hour than in its usual hour
 * - drop:  the balance went down by many stars within an hour
 * The same alert is not repeated until it cleared (or 12 hours passed).
 */
export interface StarAlert {
  id: string;
  ts: string;
  kind: 'stall' | 'spike' | 'drop' | 'test';
  identityId: number | null;
  serverId: number | null;
  name: string;
  server: string;
  text: string;
  /** The same in German (Control app, phone notification). */
  textDe: string;
}

export interface StarAlertSettings {
  enabled: boolean;
  /** No star for this many times the usual gap (and at least stallMinMinutes) → alert. */
  stallFactor: number;
  stallMinMinutes: number;
  /** More than this many times the usual stars per hour (and at least spikeMin) → alert. */
  spikeFactor: number;
  spikeMin: number;
  /** Lost at least this many stars within an hour → alert (0 = off). */
  dropMin: number;
}

export const DEFAULT_ALERT_SETTINGS: StarAlertSettings = { enabled: true, stallFactor: 3, stallMinMinutes: 60, spikeFactor: 3, spikeMin: 10, dropMin: 10 };

export interface OnlineSession {
  identityId: number;
  serverId: number;
  serverName: string;
  state: string;
  onlineSince: string | null;
}

const MIN = 60_000;
const H = 60 * MIN;
const REPEAT_AFTER = 12 * H;
const KEEP = 50;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export class StarAlerts {
  private timer: NodeJS.Timeout | null = null;
  /** key (kind:identity:server) → when it fired; cleared when the condition is gone */
  private readonly active = new Map<string, number>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: () => OnlineSession[],
    private readonly nameOf: (identityId: number) => string,
    private readonly onAlert: (a: StarAlert) => void = () => undefined,
  ) {}

  start(intervalMs = 5 * MIN): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  settings(): StarAlertSettings {
    try {
      return { ...DEFAULT_ALERT_SETTINGS, ...JSON.parse(this.repo.getSetting('stars.alertSettings') ?? '{}') };
    } catch {
      return { ...DEFAULT_ALERT_SETTINGS };
    }
  }

  setSettings(patch: Partial<StarAlertSettings>): StarAlertSettings {
    const cur = this.settings();
    const num = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
    const next: StarAlertSettings = {
      enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
      stallFactor: num(patch.stallFactor ?? cur.stallFactor, 1.5, 20, cur.stallFactor),
      stallMinMinutes: num(patch.stallMinMinutes ?? cur.stallMinMinutes, 15, 24 * 60, cur.stallMinMinutes),
      spikeFactor: num(patch.spikeFactor ?? cur.spikeFactor, 1.5, 50, cur.spikeFactor),
      spikeMin: num(patch.spikeMin ?? cur.spikeMin, 1, 10_000, cur.spikeMin),
      dropMin: num(patch.dropMin ?? cur.dropMin, 0, 100_000, cur.dropMin),
    };
    this.repo.setSetting('stars.alertSettings', JSON.stringify(next));
    return next;
  }

  /** Newest first. */
  list(): StarAlert[] {
    try {
      const v = JSON.parse(this.repo.getSetting('stars.alerts') ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  clear(): void {
    this.repo.setSetting('stars.alerts', '[]');
  }

  /** A test alert, to check that notifications arrive on the phone. */
  test(): StarAlert {
    return this.raise({ kind: 'test', identityId: null, serverId: null, name: 'Hoelni', server: '', text: 'Test notification – star alerts arrive on this phone.', textDe: 'Testbenachrichtigung – Stern-Warnungen kommen auf diesem Handy an.' });
  }

  private raise(a: Omit<StarAlert, 'id' | 'ts'>, now = Date.now()): StarAlert {
    const alert: StarAlert = { id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, ts: new Date(now).toISOString(), ...a };
    this.repo.setSetting('stars.alerts', JSON.stringify([alert, ...this.list()].slice(0, KEEP)));
    this.onAlert(alert);
    return alert;
  }

  /** Checks all online accounts; returns the alerts raised now. */
  check(now = Date.now()): StarAlert[] {
    const cfg = this.settings();
    if (!cfg.enabled) return [];
    const counted = this.repo.starServerIds();
    const history = this.repo.starHistory(new Date(now - 7 * 24 * H).toISOString());
    const byKey = new Map<string, Array<{ t: number; delta: number }>>();
    for (const r of history) {
      const k = `${r.identityId}:${r.serverId}`;
      const list = byKey.get(k) ?? [];
      list.push({ t: Date.parse(r.ts), delta: r.delta });
      byKey.set(k, list);
    }
    const out: StarAlert[] = [];
    const fire = (kind: StarAlert['kind'], s: OnlineSession, text: string, textDe: string, firing: boolean) => {
      const key = `${kind}:${s.identityId}:${s.serverId}`;
      if (!firing) {
        this.active.delete(key);
        return;
      }
      const last = this.active.get(key);
      if (last !== undefined && now - last < REPEAT_AFTER) return;
      this.active.set(key, now);
      out.push(this.raise({ kind, identityId: s.identityId, serverId: s.serverId, name: this.nameOf(s.identityId), server: s.serverName, text, textDe }, now));
    };
    for (const s of this.sessions()) {
      if (!counted.has(s.serverId)) continue;
      const rows = byKey.get(`${s.identityId}:${s.serverId}`) ?? [];
      const gains = rows.filter((r) => r.delta > 0);
      // drop: lost many stars within the last hour (online or not)
      const lost = -rows.filter((r) => r.delta < 0 && now - r.t <= H).reduce((a, r) => a + r.delta, 0);
      fire('drop', s, `lost ${lost} stars within an hour`, `${lost} Sterne in einer Stunde verloren`, cfg.dropMin > 0 && lost >= cfg.dropMin);
      if (s.state !== 'ONLINE' || !s.onlineSince) continue;
      // the usual pace needs some history: at least 5 stars on at least 3 different hours
      const activeHours = new Map<number, number>();
      for (const g of gains) activeHours.set(Math.floor(g.t / H), (activeHours.get(Math.floor(g.t / H)) ?? 0) + g.delta);
      if (gains.length < 5 || activeHours.size < 3) continue;
      // stall: online, but no star for far longer than usual
      const gaps: number[] = [];
      for (let i = 1; i < gains.length; i++) gaps.push(gains[i].t - gains[i - 1].t);
      const usualGap = Math.max(median(gaps), MIN);
      const since = Math.max(Date.parse(s.onlineSince), gains[gains.length - 1].t);
      const quiet = now - since;
      const limit = Math.max(cfg.stallFactor * usualGap, cfg.stallMinMinutes * MIN);
      fire('stall', s, `no star for ${Math.round(quiet / MIN)} min while online (usually one every ${Math.max(1, Math.round(usualGap / MIN))} min)`, `seit ${Math.round(quiet / MIN)} Min. online ohne Stern (sonst etwa alle ${Math.max(1, Math.round(usualGap / MIN))} Min. einer)`, quiet > limit);
      // spike: far more than in a usual hour
      const lastHour = gains.filter((g) => now - g.t <= H).reduce((a, g) => a + g.delta, 0);
      const before = [...activeHours.entries()].filter(([h]) => (h + 1) * H < now - H).map(([, v]) => v);
      const usualHour = before.length >= 3 ? before.reduce((a, v) => a + v, 0) / before.length : 0;
      fire('spike', s, `${lastHour} stars in the last hour (usually about ${Math.round(usualHour)})`, `${lastHour} Sterne in der letzten Stunde (sonst etwa ${Math.round(usualHour)})`, usualHour > 0 && lastHour >= cfg.spikeMin && lastHour > cfg.spikeFactor * usualHour);
    }
    return out;
  }
}
