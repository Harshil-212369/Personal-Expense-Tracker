import type { ImportRecord, Range } from './api.ts';
import { addDays, dateRange, longDate, todayIso } from './format.ts';

export interface PeriodOption {
  id: string;
  label: string;
  hint?: string;
  /** For a statement this carries `importId`, so reports match the statement to the cent. */
  range: Range;
}

function monthRange(year: number, month: number): Range {
  const first = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { from: first, to: last };
}

type StatementImport = Pick<ImportRecord, 'id' | 'kind' | 'periodStart' | 'periodEnd' | 'rowsInserted'>;

/**
 * The choices offered by the period picker. Statements come first because a
 * card statement is how spending actually arrives, and comparing one statement
 * with the one before it is the comparison people want.
 */
export function buildPeriodOptions(imports: StatementImport[], bounds: Range | null, today: string = todayIso()): PeriodOption[] {
  const options: PeriodOption[] = [];

  const statements = imports
    // An import that added no rows (the same statement again as CSV) is not a period of its own.
    .filter((i) => !i.kind.includes('receipt') && i.periodStart && i.periodEnd && i.rowsInserted > 0)
    .sort((a, b) => b.periodEnd!.localeCompare(a.periodEnd!));
  statements.slice(0, 6).forEach((statement, index) => {
    options.push({
      id: `statement:${statement.id}`,
      label: index === 0 ? 'Latest statement' : `Statement to ${longDate(statement.periodEnd!)}`,
      hint: dateRange(statement.periodStart!, statement.periodEnd!),
      range: { from: statement.periodStart!, to: statement.periodEnd!, importId: statement.id },
    });
  });

  const [year, month] = today.split('-').map(Number) as [number, number];
  const thisMonth = { from: monthRange(year, month - 1).from, to: today };
  options.push({ id: 'this-month', label: 'This month', hint: dateRange(thisMonth.from, thisMonth.to), range: thisMonth });
  const lastMonth = monthRange(year, month - 2);
  options.push({ id: 'last-month', label: 'Last month', hint: dateRange(lastMonth.from, lastMonth.to), range: lastMonth });
  for (const days of [30, 90]) {
    const range = { from: addDays(today, -(days - 1)), to: today };
    options.push({ id: `last-${days}`, label: `Last ${days} days`, hint: dateRange(range.from, range.to), range });
  }
  if (bounds) options.push({ id: 'all', label: 'All time', hint: dateRange(bounds.from, bounds.to), range: bounds });
  return options;
}

/** What to show before the person has chosen: the newest statement, else everything, else this month. */
export function defaultPeriod(options: PeriodOption[]): PeriodOption {
  return (
    options.find((o) => o.id.startsWith('statement:')) ??
    options.find((o) => o.id === 'all') ??
    options.find((o) => o.id === 'this-month')!
  );
}

export function matchOption(options: PeriodOption[], range: Range): PeriodOption | undefined {
  if (range.importId) return options.find((o) => o.range.importId === range.importId);
  return options.find((o) => !o.range.importId && o.range.from === range.from && o.range.to === range.to);
}
