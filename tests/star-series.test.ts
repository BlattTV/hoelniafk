/** The star balance over time (Control app "portfolio"), rebuilt from the balance now. */
import { describe, expect, it } from 'vitest';
import { starSeries } from '../src/minecraft/starStats.js';

const H = 3_600_000;

describe('star series', () => {
  it('rebuilds the balance backwards; change and percent over the range; per identity', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const at = (h: number) => new Date(now - h * H).toISOString();
    const history = [
      { identityId: 1, ts: at(30), delta: 5 }, // before the day
      { identityId: 1, ts: at(10), delta: 10 },
      { identityId: 2, ts: at(5), delta: 4 },
      { identityId: 1, ts: at(2), delta: -3 }, // spent
    ];
    const day = starSeries(history, 100, '1d', now);
    expect(day.points).toHaveLength(97);
    expect(day.points[0].v).toBe(89); // 100 − (10 + 4 − 3)
    expect(day.points.at(-1)).toEqual({ t: new Date(now).toISOString(), v: 100 });
    expect(day.change).toBe(11);
    expect(day.changePct).toBeCloseTo(12.36, 1);
    // the line steps exactly where the changes happened
    const v = (h: number) => day.points.find((p) => Date.parse(p.t) >= now - h * H)!.v;
    expect(v(11)).toBe(89);
    expect(v(9)).toBe(99);
    expect(v(4)).toBe(103);
    expect(v(1)).toBe(100);
    // one identity (balance 60 now)
    const one = starSeries(history, 60, '1w', now, 1);
    expect(one.points[0].v).toBe(48); // 60 − (5 + 10 − 3)
    expect(one.change).toBe(12);
    // max: from the first change; start at 0 → no percent
    const max = starSeries([{ identityId: 3, ts: at(48), delta: 7 }], 7, 'max', now);
    expect(max.points[0].v).toBe(0);
    expect(max.change).toBe(7);
    expect(max.changePct).toBeNull();
  });
});
