/**
 * Weekly online schedule of a session (identity × server), in local time.
 * hours[d] is a 24-bit mask for day d (0 = Monday … 6 = Sunday): bit h = online during h:00–h:59.
 */
export interface WeekSchedule {
  enabled: boolean;
  hours: number[];
  /**
   * Minutes the whole schedule is shifted (0–59): windows start and end at hh:MM instead of hh:00, so
   * sessions with generated rest times do not all switch at the same full hour.
   */
  offsetMin?: number;
}

export const ALL_HOURS = 0xffffff;

export function normalizeSchedule(input: unknown): WeekSchedule {
  const s = (input ?? {}) as Partial<WeekSchedule>;
  const hours = Array.isArray(s.hours) ? s.hours.slice(0, 7) : [];
  while (hours.length < 7) hours.push(0);
  const offset = Math.max(0, Math.min(59, Math.round(Number(s.offsetMin) || 0)));
  return { enabled: !!s.enabled, hours: hours.map((m) => (Number.isInteger(m) ? (m as number) & ALL_HOURS : 0)), ...(offset ? { offsetMin: offset } : {}) };
}

const offsetMs = (s: WeekSchedule) => (s.offsetMin ?? 0) * 60_000;

/** 0 = Monday … 6 = Sunday */
const dayIndex = (d: Date) => (d.getDay() + 6) % 7;

export function scheduleActive(s: WeekSchedule | null | undefined, at = new Date()): boolean {
  if (!s || !s.enabled) return true;
  const t = new Date(at.getTime() - offsetMs(s));
  return ((s.hours[dayIndex(t)] ?? 0) >> t.getHours()) & 1 ? true : false;
}

/** Next time (full hour) at which the schedule switches between active and inactive, or null if it never does. */
export function nextScheduleChange(s: WeekSchedule | null | undefined, from = new Date()): Date | null {
  if (!s || !s.enabled) return null;
  const plain = { ...s, offsetMin: 0 };
  const now = scheduleActive(s, from);
  // walk the hours of the unshifted schedule, then shift the change back by the offset
  const t = new Date(from.getTime() - offsetMs(s));
  t.setMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 8; i++) {
    t.setHours(t.getHours() + 1);
    if (scheduleActive(plain, t) !== now) return new Date(t.getTime() + offsetMs(s));
  }
  return null;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Short human description, e.g. "Mon–Fri 18–24, Sat–Sun always". */
export function describeSchedule(s: WeekSchedule | null | undefined): string {
  if (!s || !s.enabled) return 'always';
  const ranges = (mask: number) => {
    if (mask === ALL_HOURS) return 'all day';
    if (mask === 0) return 'off';
    const out: string[] = [];
    for (let h = 0; h < 24; h++) {
      if (!((mask >> h) & 1)) continue;
      let e = h;
      while (e + 1 < 24 && (mask >> (e + 1)) & 1) e++;
      out.push(`${h}–${e + 1}`);
      h = e;
    }
    return out.join(', ');
  };
  const parts: string[] = [];
  for (let d = 0; d < 7; d++) {
    let e = d;
    while (e + 1 < 7 && s.hours[e + 1] === s.hours[d]) e++;
    parts.push(`${d === e ? DAYS[d] : `${DAYS[d]}–${DAYS[e]}`} ${ranges(s.hours[d])}`);
    d = e;
  }
  return parts.join(' · ') + (s.offsetMin ? ` (at :${String(s.offsetMin).padStart(2, '0')})` : '');
}

/**
 * Rest times for one session (online limit, e.g. for a "not 24/7" server rule): every day of the week
 * gets its own number of online hours between onlineMin and onlineMax, with one longer rest block and
 * sometimes a short break, at random hours – and the whole schedule a random minute offset. Called once
 * per session, so every account gets different times.
 */
export function generateRestSchedule(opts: { onlineMin: number; onlineMax: number }, rnd: () => number = Math.random): WeekSchedule {
  const lo = Math.max(1, Math.min(23, Math.round(opts.onlineMin)));
  const hi = Math.max(lo, Math.min(23, Math.round(opts.onlineMax)));
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const hours: number[] = [];
  for (let d = 0; d < 7; d++) {
    const online = int(lo, hi);
    const rest = 24 - online;
    const extra = rest >= 4 && rnd() < 0.5 ? int(1, Math.min(2, rest - 2)) : 0;
    const main = rest - extra;
    let mask = ALL_HOURS;
    const start = int(0, 23);
    for (let h = 0; h < main; h++) mask &= ~(1 << ((start + h) % 24));
    if (extra) {
      // the short break somewhere in the online part
      for (let tries = 0; tries < 24; tries++) {
        const s = int(0, 23);
        let free = true;
        for (let h = -1; h <= extra; h++) if (!((mask >> ((s + h + 24) % 24)) & 1)) free = false;
        if (!free) continue;
        for (let h = 0; h < extra; h++) mask &= ~(1 << ((s + h) % 24));
        break;
      }
    }
    hours.push(mask & ALL_HOURS);
  }
  return { enabled: true, hours, offsetMin: int(0, 59) };
}
