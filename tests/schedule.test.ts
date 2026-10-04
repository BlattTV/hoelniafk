/** MOCK: weekly schedules – time math and reconciler behaviour (inline runtime, fake bots). */
import { describe, expect, it } from 'vitest';
import { describeSchedule, nextScheduleChange, normalizeSchedule, scheduleActive } from '../src/core/schedule.js';
import { createTestSuite, settle, waitFor } from './helpers.js';

const range = (a: number, b: number) => {
  let m = 0;
  for (let x = a; x < b; x++) m |= 1 << x;
  return m;
};
// 2026-09-28 is a Monday
const at = (day: number, hour: number, min = 0) => new Date(2026, 8, 28 + day, hour, min);

describe('schedule math', () => {
  const evenings = normalizeSchedule({ enabled: true, hours: [...Array(5).fill(range(18, 24)), 0xffffff, 0xffffff] });

  it('knows when a window is active', () => {
    expect(scheduleActive(evenings, at(0, 17, 59))).toBe(false);
    expect(scheduleActive(evenings, at(0, 18, 0))).toBe(true);
    expect(scheduleActive(evenings, at(4, 23, 59))).toBe(true);
    expect(scheduleActive(evenings, at(5, 9))).toBe(true); // Saturday all day
    expect(scheduleActive(null)).toBe(true);
    expect(scheduleActive({ enabled: false, hours: Array(7).fill(0) })).toBe(true);
  });

  it('finds the next change, also across days', () => {
    expect(nextScheduleChange(evenings, at(0, 12, 30))).toEqual(at(0, 18));
    expect(nextScheduleChange(evenings, at(0, 19))).toEqual(at(1, 0)); // Tuesday 00:00 → off
    expect(nextScheduleChange(evenings, at(5, 10))).toEqual(at(7, 0)); // weekend ends Monday 00:00
    expect(nextScheduleChange(normalizeSchedule({ enabled: true, hours: Array(7).fill(0xffffff) }))).toBeNull();
  });

  it('describes schedules and sanitises input', () => {
    expect(describeSchedule(evenings)).toBe('Mon–Fri 18–24 · Sat–Sun all day');
    expect(describeSchedule(null)).toBe('always');
    expect(normalizeSchedule({ enabled: 1, hours: [0x1ffffff, 'x'] }).hours).toEqual([0xffffff, 0, 0, 0, 0, 0, 0]);
  });
});

describe('reconciler with schedules', () => {
  async function setup(hours: number[]) {
    const t = await createTestSuite({ sessionOptions: { reconcileIntervalMs: 60_000 } });
    const srv = t.suite.repo.upsertServer({ name: 'SMP', host: 'smp.example.com' });
    const id = t.suite.identities.create({ label: 'Sched' }).identity.id;
    t.suite.repo.upsertMinecraft(id, { username: 'Sched01', authType: 'offline' });
    t.suite.repo.assignServer(id, { serverId: srv.id });
    t.suite.repo.setSchedule(id, srv.id, { enabled: true, hours });
    return { ...t, id, srv, sid: `${id}:${srv.id}` };
  }

  it('does not start a desired session outside its window, starts it inside', async () => {
    const now = new Date();
    const day = (now.getDay() + 6) % 7;
    const hours = Array(7).fill(0);
    const t = await setup(hours);
    t.suite.sessions.setDesired(t.id, t.srv.id, 'ONLINE');
    await t.suite.sessions.reconcile();
    await settle();
    expect(t.bots).toHaveLength(0);
    const info = t.suite.sessions.list().find((s) => s.id === t.sid)!;
    expect(info.desiredState).toBe('ONLINE');
    expect(info.schedule).toMatchObject({ active: false });
    // open the window for the current hour
    hours[day] = 1 << now.getHours();
    t.suite.repo.setSchedule(t.id, t.srv.id, { enabled: true, hours });
    await t.suite.sessions.reconcile();
    await waitFor(() => t.bots.length === 1, 2000, 'bot started');
    t.bots[0].join();
    await settle();
    expect(t.suite.sessions.getState(t.sid).state).toBe('ONLINE');
    // close the window again → session stops, desired state stays ONLINE
    t.suite.repo.setSchedule(t.id, t.srv.id, { enabled: true, hours: Array(7).fill(0) });
    await t.suite.sessions.reconcile();
    await waitFor(() => t.suite.sessions.getState(t.sid).state === 'STOPPED', 3000, 'stopped by schedule');
    expect(t.suite.repo.getAssignment(t.id, t.srv.id)!.desiredState).toBe('ONLINE');
    expect(t.suite.repo.sessionEvents({ sessionId: t.sid }).some((e) => e.kind === 'state:STOPPING')).toBe(true);
    await t.suite.shutdown();
  });

  it('a manual start outside the window overrides it until the next change', async () => {
    const t = await setup(Array(7).fill(0)); // never – no next change → 1 h override
    await t.suite.sessions.startSession(t.id, t.srv.id);
    await waitFor(() => t.bots.length === 1, 2000, 'bot started');
    t.bots[0].join();
    await settle();
    await t.suite.sessions.reconcile();
    await settle();
    const s = t.suite.sessions.getState(t.sid);
    expect(s.state).toBe('ONLINE');
    expect(s.schedule).toMatchObject({ active: false, override: true });
    await t.suite.shutdown();
  });
});

describe('rest times (online limit per session)', () => {
  it('generates a different week per session within the online hours, shifted by a minute offset', async () => {
    const { generateRestSchedule, scheduleActive, nextScheduleChange } = await import('../src/core/schedule.js');
    const bits = (m: number) => m.toString(2).split('').filter((b) => b === '1').length;
    const a = generateRestSchedule({ onlineMin: 14, onlineMax: 18 });
    const b = generateRestSchedule({ onlineMin: 14, onlineMax: 18 });
    for (const s of [a, b]) {
      expect(s.enabled).toBe(true);
      expect(s.hours).toHaveLength(7);
      for (const m of s.hours) expect(bits(m)).toBeGreaterThanOrEqual(14), expect(bits(m)).toBeLessThanOrEqual(18);
      expect(s.offsetMin).toBeGreaterThanOrEqual(0);
      expect(s.offsetMin).toBeLessThanOrEqual(59);
    }
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b)); // every account its own times
    // the offset shifts the windows: online 10:00–10:59 with offset 20 → 10:20–11:19
    const s = { enabled: true, hours: Array(7).fill(1 << 10), offsetMin: 20 };
    const at = (h: number, m: number) => new Date(2026, 9, 5, h, m); // a Monday
    expect(scheduleActive(s, at(10, 10))).toBe(false);
    expect(scheduleActive(s, at(10, 25))).toBe(true);
    expect(scheduleActive(s, at(11, 15))).toBe(true);
    expect(scheduleActive(s, at(11, 25))).toBe(false);
    expect(nextScheduleChange(s, at(9, 0))!.getTime()).toBe(at(10, 20).getTime());
    expect(nextScheduleChange(s, at(10, 30))!.getTime()).toBe(at(11, 20).getTime());
  });
});
