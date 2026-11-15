const currency = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const wholeCurrency = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
const compactCurrency = new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', notation: 'compact', maximumFractionDigits: 1,
});

/** $1,234.56 */
export function money(cents: number): string {
  return currency.format(cents / 100).replace('CA$', '$');
}

/** $1,235: for axis ticks and dense labels where cents are noise. */
export function moneyWhole(cents: number): string {
  return wholeCurrency.format(cents / 100).replace('CA$', '$');
}

/** Axis style: full under $10,000, compact above ($12.9K). */
export function moneyAxis(cents: number): string {
  return Math.abs(cents) >= 1_000_000 ? compactCurrency.format(cents / 100).replace('CA$', '$') : moneyWhole(cents);
}

export function percent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** "+12%" / "-8%" with a real minus sign. */
export function signedPercent(ratio: number): string {
  const rounded = Math.round(ratio * 100);
  if (rounded === 0) return '0%';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

/** "Oct 21" */
export function shortDate(iso: string): string {
  const [, m, d] = parts(iso);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "Oct 21, 2026" */
export function longDate(iso: string): string {
  const [y, m, d] = parts(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "Sep 22 – Oct 21, 2026", dropping a repeated year. */
export function dateRange(from: string, to: string): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${sameYear ? shortDate(from) : longDate(from)} – ${longDate(to)}`;
}

/** 0 = Monday ... 6 = Sunday, matching the API. */
export function weekdayIndex(iso: string): number {
  const [y, m, d] = parts(iso);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-CA')} ${noun}${count === 1 ? '' : 's'}`;
}

/** Parses what a person types ("12.50", "$1,200", "-4") into cents; null if it is not an amount. */
export function parseDollars(input: string): number | null {
  const text = input.trim().replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}
