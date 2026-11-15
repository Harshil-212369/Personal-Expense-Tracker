import { describe, expect, it } from 'vitest';
import { heatLevel, weekLabels } from '../charts/CalendarHeatmap.tsx';
import { shareNote } from '../charts/RankedBars.tsx';
import { toQuery } from './api.ts';
import { addDays, dateRange, longDate, money, moneyAxis, parseDollars, plural, shortDate, signedPercent, weekdayIndex } from './format.ts';
import { buildPeriodOptions, defaultPeriod, matchOption } from './periods.ts';

describe('format', () => {
  it('formats money from integer cents', () => {
    expect(money(123456)).toBe('$1,234.56');
    expect(money(5)).toBe('$0.05');
    expect(money(-4185)).toBe('-$41.85');
    expect(moneyAxis(150000)).toBe('$1,500');
    expect(moneyAxis(1290000)).toBe('$12.9K');
  });

  it('formats deltas with a real minus sign', () => {
    expect(signedPercent(0.124)).toBe('+12%');
    expect(signedPercent(-0.08)).toBe('−8%');
    expect(signedPercent(0.001)).toBe('0%');
  });

  it('formats dates and ranges', () => {
    expect(shortDate('2026-10-05')).toBe('Oct 5');
    expect(longDate('2026-10-05')).toBe('Oct 5, 2026');
    expect(dateRange('2026-09-22', '2026-10-21')).toBe('Sep 22 – Oct 21, 2026');
    expect(dateRange('2025-12-22', '2026-01-21')).toBe('Dec 22, 2025 – Jan 21, 2026');
    expect(weekdayIndex('2026-11-09')).toBe(0);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('pluralizes', () => {
    expect(plural(1, 'purchase')).toBe('1 purchase');
    expect(plural(1200, 'purchase')).toBe('1,200 purchases');
  });

  it('parses typed dollar amounts and rejects anything else', () => {
    expect(parseDollars('12.50')).toBe(1250);
    expect(parseDollars(' $1,200 ')).toBe(120000);
    expect(parseDollars('-4')).toBe(-400);
    expect(parseDollars('0.5')).toBe(50);
    for (const bad of ['', 'abc', '1.234', '12.5.0', '1e3']) expect(parseDollars(bad)).toBeNull();
  });

  it('builds query strings without empty values', () => {
    expect(toQuery({ from: '2026-01-01', q: '', page: undefined, n: 0, flag: false })).toBe('?from=2026-01-01&n=0&flag=false');
    expect(toQuery({})).toBe('');
    expect(toQuery({ q: 'tim hortons & co' })).toBe('?q=tim+hortons+%26+co');
  });
});

describe('periods', () => {
  const imports = [
    { id: 1, kind: 'cibc-credit-pdf', periodStart: '2026-08-22', periodEnd: '2026-09-21', rowsInserted: 60 },
    { id: 2, kind: 'cibc-credit-pdf', periodStart: '2026-09-22', periodEnd: '2026-10-21', rowsInserted: 55 },
    { id: 3, kind: 'metro-receipt-email', periodStart: '2026-11-12', periodEnd: '2026-11-12', rowsInserted: 5 },
    { id: 4, kind: 'cibc-csv', periodStart: '2026-09-22', periodEnd: '2026-10-21', rowsInserted: 0 }, // same statement again
  ];
  const bounds = { from: '2026-08-21', to: '2026-10-21' };
  const options = buildPeriodOptions(imports, bounds, '2026-11-15');

  it('lists statements newest first, without receipts or imports that added nothing', () => {
    const statements = options.filter((o) => o.id.startsWith('statement:'));
    expect(statements.map((o) => o.range.importId)).toEqual([2, 1]);
    expect(statements[0]!.label).toBe('Latest statement');
    expect(statements[0]!.hint).toBe('Sep 22 \u2013 Oct 21, 2026');
    expect(statements[1]!.label).toBe('Statement to Sep 21, 2026');
  });

  it('adds calendar presets relative to today', () => {
    const byId = Object.fromEntries(options.map((o) => [o.id, o.range]));
    expect(byId['this-month']).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(byId['last-month']).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(byId['last-30']).toEqual({ from: '2026-10-17', to: '2026-11-15' });
    expect(byId['all']).toEqual(bounds);
  });

  it('defaults to the latest statement, then all time, then this month', () => {
    expect(defaultPeriod(options).id).toBe('statement:2');
    expect(defaultPeriod(buildPeriodOptions([], bounds, '2026-11-15')).id).toBe('all');
    expect(defaultPeriod(buildPeriodOptions([], null, '2026-11-15')).id).toBe('this-month');
  });

  it('recognizes a range that matches a preset', () => {
    expect(matchOption(options, { from: '2026-10-01', to: '2026-10-31' })?.id).toBe('last-month');
    expect(matchOption(options, { from: '2026-10-02', to: '2026-10-31' })).toBeUndefined();
    // A statement is matched by its id, and plain dates never match a statement.
    expect(matchOption(options, { from: '2026-01-01', to: '2026-01-02', importId: 1 })?.id).toBe('statement:1');
    expect(matchOption(options, { from: '2026-09-22', to: '2026-10-21' })).toBeUndefined();
  });
});

describe('chart helpers', () => {
  it('maps spending onto five heat levels, zero staying empty', () => {
    expect(heatLevel(0, 10000)).toBe(0);
    expect(heatLevel(-500, 10000)).toBe(0);
    expect(heatLevel(1, 10000)).toBe(1);
    expect(heatLevel(10000, 10000)).toBe(5);
    expect(heatLevel(2500, 10000)).toBe(3); // sqrt(0.25) = 0.5 -> level 3
    expect(heatLevel(500, 0)).toBe(0);
  });

  it('labels week columns, naming the month only when it changes', () => {
    expect(weekLabels('2026-09-21', 5)).toEqual(['Sep 21', '28', 'Oct 5', '12', '19']);
    expect(weekLabels('2026-09-21', 10).filter(Boolean)).toHaveLength(5);
  });

  it('never rounds a real share down to 0%', () => {
    expect(shareNote(0.004)).toBe('<1%');
    expect(shareNote(0)).toBe('0%');
    expect(shareNote(0.256)).toBe('26%');
  });
});
