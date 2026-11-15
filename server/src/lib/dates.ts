/** Dates are ISO `YYYY-MM-DD` strings in the statement's local calendar; no timezones involved. */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function monthFromName(name: string): number | null {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

export function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function toIsoDate(year: number, month: number, day: number): string {
  if (!isValidYmd(year, month, day)) {
    throw new RangeError(`Invalid calendar date ${year}-${month}-${day}`);
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return !!m && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

function toUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  return new Date(toUtc(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(iso: string): number {
  return (new Date(toUtc(iso)).getUTCDay() + 6) % 7;
}

export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/**
 * Statement rows print "Sep 21" with no year. The year comes from the
 * statement period: a row cannot be dated after the period ends, so a month
 * that would land in the future belongs to the previous year (a December row
 * on a statement that closes in January).
 */
export function resolveYear(month: number, day: number, periodEnd: string): string {
  const endYear = Number(periodEnd.slice(0, 4));
  for (const year of [endYear, endYear - 1]) {
    if (!isValidYmd(year, month, day)) continue;
    const candidate = toIsoDate(year, month, day);
    // Allow a small grace window: posting dates can trail the period by a few days.
    if (daysBetween(periodEnd, candidate) <= 10) return candidate;
  }
  throw new RangeError(`Cannot place ${month}/${day} relative to statement period ending ${periodEnd}`);
}

/** Parses "October 21, 2026" or "Oct 21, 2026". */
export function parseLongDate(text: string): string | null {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (!m) return null;
  const month = monthFromName(m[1]!);
  if (!month || !isValidYmd(Number(m[3]), month, Number(m[2]))) return null;
  return toIsoDate(Number(m[3]), month, Number(m[2]));
}

/** Every ISO date from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
