/** Game time (§4.8): an absolute minute counter. Time of day is clock mod 1440; days are chapters (§3.6). */
export const MINUTES_PER_DAY = 1440;

export function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export const timeOfDay = (clock: number) => ((clock % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

export function formatClock(clock: number): string {
  const t = timeOfDay(clock);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** True if time-of-day `hhmm` falls within the absolute window (from, to]. */
export function crossed(hhmm: string, from: number, to: number): boolean {
  if (to <= from) return false;
  if (to - from >= MINUTES_PER_DAY) return true;
  const target = parseClock(hhmm);
  const a = timeOfDay(from);
  const span = to - from;
  const delta = (target - a + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return delta > 0 && delta <= span;
}

/** True if the time of day is within [from, to), wrapping past midnight when to < from. */
export function between(clock: number, from: string, to: string): boolean {
  const t = timeOfDay(clock);
  const a = parseClock(from);
  const b = parseClock(to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}
