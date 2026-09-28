/**
 * Weekly online schedule of a session (identity × server), in local time.
 * hours[d] is a 24-bit mask for day d (0 = Monday … 6 = Sunday): bit h = online during h:00–h:59.
 */
export interface WeekSchedule {
  enabled: boolean;
  hours: number[];
}

export const ALL_HOURS = 0xffffff;

export function normalizeSchedule(input: unknown): WeekSchedule {
  const s = (input ?? {}) as Partial<WeekSchedule>;
  const hours = Array.isArray(s.hours) ? s.hours.slice(0, 7) : [];
  while (hours.length < 7) hours.push(0);
  return { enabled: !!s.enabled, hours: hours.map((m) => (Number.isInteger(m) ? (m as number) & ALL_HOURS : 0)) };
}

/** 0 = Monday … 6 = Sunday */
const dayIndex = (d: Date) => (d.getDay() + 6) % 7;

export function scheduleActive(s: WeekSchedule | null | undefined, at = new Date()): boolean {
  if (!s || !s.enabled) return true;
  return ((s.hours[dayIndex(at)] ?? 0) >> at.getHours()) & 1 ? true : false;
}

/** Next time (full hour) at which the schedule switches between active and inactive, or null if it never does. */
export function nextScheduleChange(s: WeekSchedule | null | undefined, from = new Date()): Date | null {
  if (!s || !s.enabled) return null;
  const now = scheduleActive(s, from);
  const t = new Date(from);
  t.setMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 8; i++) {
    t.setHours(t.getHours() + 1);
    if (scheduleActive(s, t) !== now) return new Date(t);
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
  return parts.join(' · ');
}
