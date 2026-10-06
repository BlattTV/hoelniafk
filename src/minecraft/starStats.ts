import type { IdentityRepository } from '../identity/repository.js';

export interface StarStats {
  /** Current balance of all identities (sum over their servers). */
  total: number;
  /** Balance of the identities that are online right now. */
  online: number;
  /** Stars gained (positive changes) and spent (negative, as a positive number) per period. */
  gained: { h24: number; d7: number; d30: number; d365: number };
  spent: { h24: number; d7: number; d30: number; d365: number };
  /** Gained per hour, the last 24 hours (oldest first, `t` = start of the hour). */
  hourly: Array<{ t: string; gained: number }>;
  /** Gained per day, the last 30 days (oldest first, `day` = YYYY-MM-DD local time). */
  daily: Array<{ day: string; gained: number }>;
  perIdentity: Array<{ id: number; name: string; stars: number; online: boolean; h24: number; d7: number; d30: number; servers?: Array<{ serverId: number; name: string; stars: number; source: 'scoreboard' | 'chat' | null }> }>;
  at: string;
}

const H = 3_600_000;
const D = 24 * H;
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Star statistics from the reward history (calibrations and manual corrections do not count as gained). */
export function starStats(
  repo: IdentityRepository,
  identities: Array<{ id: number; name: string; stars: number; online: boolean; servers?: Array<{ serverId: number; name: string; stars: number; source: 'scoreboard' | 'chat' | null }> }>,
  now = new Date(),
): StarStats {
  const t = now.getTime();
  const rows = repo.starHistory(new Date(t - 365 * D).toISOString());
  const zero = () => ({ h24: 0, d7: 0, d30: 0, d365: 0 });
  const gained = zero();
  const spent = zero();
  const per = new Map<number, { h24: number; d7: number; d30: number }>();
  const hourStart = new Date(now);
  hourStart.setMinutes(0, 0, 0);
  const hourly = Array.from({ length: 24 }, (_, i) => ({ t: new Date(hourStart.getTime() - (23 - i) * H).toISOString(), gained: 0 }));
  const daily: Array<{ day: string; gained: number }> = [];
  const dayIndex = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    dayIndex.set(dayKey(d), daily.length);
    daily.push({ day: dayKey(d), gained: 0 });
  }
  for (const r of rows) {
    const ts = Date.parse(r.ts);
    const age = t - ts;
    const target = r.delta > 0 ? gained : spent;
    const v = Math.abs(r.delta);
    target.d365 += v;
    if (age <= 30 * D) target.d30 += v;
    if (age <= 7 * D) target.d7 += v;
    if (age <= D) target.h24 += v;
    if (r.delta <= 0) continue;
    const p = per.get(r.identityId) ?? { h24: 0, d7: 0, d30: 0 };
    if (age <= 30 * D) p.d30 += v;
    if (age <= 7 * D) p.d7 += v;
    if (age <= D) p.h24 += v;
    per.set(r.identityId, p);
    const hi = Math.floor((ts - (hourStart.getTime() - 23 * H)) / H);
    if (hi >= 0 && hi < 24) hourly[hi].gained += v;
    const di = dayIndex.get(dayKey(new Date(ts)));
    if (di !== undefined) daily[di].gained += v;
  }
  return {
    total: identities.reduce((a, i) => a + i.stars, 0),
    online: identities.filter((i) => i.online).reduce((a, i) => a + i.stars, 0),
    gained,
    spent,
    hourly,
    daily,
    perIdentity: identities
      .map((i) => ({ ...i, ...(per.get(i.id) ?? { h24: 0, d7: 0, d30: 0 }) }))
      .sort((a, b) => b.h24 - a.h24 || b.d7 - a.d7 || b.stars - a.stars),
    at: now.toISOString(),
  };
}

// ------------------------------------------------------------------ "portfolio" (Control app)

export type StarRange = '1d' | '1w' | '1m' | '1y' | 'max';
export const STAR_RANGES: StarRange[] = ['1d', '1w', '1m', '1y', 'max'];

export interface StarSeries {
  /** Balance over the range, oldest first (the last point is now). */
  points: Array<{ t: string; v: number }>;
  /** Balance now minus balance at the start of the range; pct relative to the start (null if it was 0). */
  change: number;
  changePct: number | null;
}

const SPAN: Record<Exclude<StarRange, 'max'>, { span: number; steps: number }> = {
  '1d': { span: D, steps: 96 }, // every 15 minutes
  '1w': { span: 7 * D, steps: 84 }, // every 2 hours
  '1m': { span: 30 * D, steps: 120 }, // every 6 hours
  '1y': { span: 365 * D, steps: 122 }, // every 3 days
};

/**
 * The balance over time, rebuilt backwards from the balance now with the recorded changes (first
 * readings and manual corrections are not changes – the line does not jump there).
 */
export function starSeries(
  history: Array<{ identityId: number; ts: string; delta: number }>,
  total: number,
  range: StarRange,
  now = Date.now(),
  identityId?: number,
): StarSeries {
  const rows = history
    .filter((r) => identityId === undefined || r.identityId === identityId)
    .map((r) => ({ t: Date.parse(r.ts), d: r.delta }))
    .filter((r) => r.t <= now)
    .sort((a, b) => a.t - b.t);
  let span: number;
  let steps: number;
  if (range === 'max') {
    const first = rows.length ? rows[0].t : now - D;
    span = Math.max(D, now - first + H);
    steps = 120;
  } else ({ span, steps } = SPAN[range]);
  const start = now - span;
  const step = span / steps;
  // value at time x = total − sum of the changes after x
  const points: Array<{ t: string; v: number }> = [];
  let after = rows.filter((r) => r.t > start).reduce((a, r) => a + r.d, 0);
  let i = rows.findIndex((r) => r.t > start);
  if (i < 0) i = rows.length;
  for (let k = 0; k <= steps; k++) {
    const x = k === steps ? now : start + k * step;
    while (i < rows.length && rows[i].t <= x) after -= rows[i++].d;
    points.push({ t: new Date(x).toISOString(), v: total - after });
  }
  const first = points[0].v;
  const change = total - first;
  return { points, change, changePct: first > 0 ? (change / first) * 100 : null };
}
