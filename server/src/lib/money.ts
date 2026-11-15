/**
 * Money is stored and computed as integer cents everywhere. Floats only appear
 * at the edges (parsing text, formatting for display), never in arithmetic.
 */

const MONEY_PATTERN = /^\(?-?\$?\s*-?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\)?-?$/;

/**
 * Parses "$1,234.56", "-41.85", "41.85-", "(12.00)" or "7" into integer cents.
 * Returns null instead of guessing when the text is not a money amount.
 */
export function parseMoneyToCents(input: string): number | null {
  const text = input.trim().replace(/\s+/g, '').replace(/^CAD\$?/i, '');
  const match = MONEY_PATTERN.exec(text);
  if (!match) return null;
  const whole = Number(match[1]!.replaceAll(',', ''));
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = whole * 100 + Number(fraction || '0');
  if (!Number.isSafeInteger(cents)) return null;
  const negative = text.includes('-') || (text.startsWith('(') && text.endsWith(')'));
  return negative ? -cents : cents;
}

/** Converts a decimal number from JSON (for example 12.34) to cents without float drift. */
export function decimalToCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toLocaleString('en-CA');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

export function sumCents(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
