import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import type { Db } from '../src/db/database.ts';
import * as analytics from '../src/services/analytics.ts';
import { ruleBasedInsights, buildRollup } from '../src/services/insights.ts';
import { createTransaction } from '../src/services/transactions.ts';

let db: Db;
const add = (txnDate: string, description: string, dollars: number, type: 'purchase' | 'refund' | 'payment' | 'credit' = 'purchase') =>
  createTransaction(db, { txnDate, description, amountCents: Math.round(dollars * 100), type });
const MARCH = { from: '2026-03-01', to: '2026-03-31' };

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('summary', () => {
  it('nets refunds, excludes payments and reward credits', () => {
    add('2026-03-02', 'METRO 100', 40);
    add('2026-03-03', 'TIM HORTONS #1', 5);
    add('2026-03-10', 'WINNERS 12', 60);
    add('2026-03-12', 'WINNERS 12', -60, 'refund');
    add('2026-03-15', 'PAYMENT THANK YOU', -500, 'payment');
    add('2026-03-16', 'CASHBACK/REMISE EN ARGENT', -20, 'credit');

    const s = analytics.summary(db, MARCH);
    assert.equal(s.totalCents, 4500);
    assert.equal(s.purchaseCount, 3);
    assert.equal(s.refundCents, 6000);
    assert.equal(s.days, 31);
    assert.equal(s.activeDays, 3);
    assert.equal(s.avgPerDayCents, Math.round(4500 / 31));
    assert.equal(s.medianPurchaseCents, 4000);
    assert.deepEqual({ merchant: s.largest!.merchant, amountCents: s.largest!.amountCents }, { merchant: 'Winners', amountCents: 6000 });
  });

  it('compares a calendar month with the previous calendar month', () => {
    add('2026-02-10', 'METRO 100', 80);
    add('2026-03-10', 'METRO 100', 100);
    const s = analytics.summary(db, MARCH);
    assert.deepEqual(s.previous!.range, { from: '2026-02-01', to: '2026-02-28' });
    assert.equal(s.previous!.totalCents, 8000);
    assert.equal(s.changeRatio, 0.25);
  });

  it('compares any other range with the same number of days before it', () => {
    assert.deepEqual(analytics.previousRange({ from: '2026-03-10', to: '2026-03-23' }), { from: '2026-02-24', to: '2026-03-09' });
    assert.deepEqual(analytics.previousRange({ from: '2026-03-10', to: '2026-03-10' }), { from: '2026-03-09', to: '2026-03-09' });
  });

  it('compares a statement cycle with the statement cycle before it', () => {
    // 22nd to 21st: the previous statement has 31 days, not the same 30.
    assert.deepEqual(analytics.previousRange({ from: '2026-09-22', to: '2026-10-21' }), { from: '2026-08-22', to: '2026-09-21' });
    assert.deepEqual(analytics.previousRange({ from: '2026-02-22', to: '2026-03-21' }), { from: '2026-01-22', to: '2026-02-21' });
    assert.deepEqual(analytics.previousRange({ from: '2026-03-01', to: '2026-03-31' }), { from: '2026-02-01', to: '2026-02-28' });
  });

  it('offers no comparison when the earlier period has no data on file', () => {
    add('2026-03-10', 'METRO 100', 100);
    const s = analytics.summary(db, MARCH);
    assert.equal(s.previous, null);
    assert.equal(s.changeRatio, null);
  });

  it('describes an empty ledger without dividing by zero', () => {
    const s = analytics.summary(db, MARCH);
    assert.equal(s.totalCents, 0);
    assert.equal(s.largest, null);
    assert.equal(s.dataBounds, null);
    assert.deepEqual(analytics.byCategory(db, MARCH), []);
    assert.deepEqual(ruleBasedInsights(db, MARCH), []);
    const range = analytics.resolveScope(db, {});
    assert.equal(analytics.timeseries(db, range, 'day').length, 30);
    assert.throws(() => analytics.resolveScope(db, { importId: 99 }), /Import 99 was not found/);
  });

  it('defaults the range to everything on file', () => {
    add('2026-01-05', 'METRO 100', 10);
    add('2026-04-20', 'METRO 100', 10);
    assert.deepEqual(analytics.resolveScope(db, {}), { from: '2026-01-05', to: '2026-04-20' });
    assert.deepEqual(analytics.resolveScope(db, { from: '2026-02-01' }), { from: '2026-02-01', to: '2026-04-20' });
  });
});

describe('breakdowns', () => {
  beforeEach(() => {
    add('2026-02-14', 'METRO 100', 50);
    add('2026-03-02', 'METRO 100', 30);
    add('2026-03-09', 'NOFRILLS 22', 30);
    add('2026-03-03', 'TIM HORTONS #1', 4);
    add('2026-03-04', 'TIM HORTONS #2', 6);
    add('2026-03-20', 'PRESTO MOBI/ABC123DEF4', 30);
  });

  it('ranks categories with shares that sum to one', () => {
    const rows = analytics.byCategory(db, MARCH);
    assert.deepEqual(rows.map((r) => [r.name, r.cents, r.count]), [
      ['Groceries', 6000, 2],
      ['Transportation', 3000, 1],
      ['Dining & Coffee', 1000, 2],
    ]);
    assert.ok(Math.abs(rows.reduce((sum, r) => sum + r.share, 0) - 1) < 1e-9);
    assert.equal(rows[0]!.previousCents, 5000);
  });

  it('merges every store of a merchant', () => {
    const merchants = analytics.topMerchants(db, MARCH);
    const tims = merchants.find((m) => m.merchant === 'Tim Hortons')!;
    assert.deepEqual([tims.cents, tims.count, tims.avgCents, tims.lastDate], [1000, 2, 500, '2026-03-04']);
    assert.equal(merchants[0]!.cents, 3000);
  });

  it('fills empty days and accumulates', () => {
    const days = analytics.timeseries(db, MARCH, 'day');
    assert.equal(days.length, 31);
    assert.equal(days[0]!.cents, 0);
    assert.equal(days[1]!.cents, 3000);
    assert.equal(days.at(-1)!.cumulativeCents, 10000);
  });

  it('buckets by week (Monday start) and by month', () => {
    const weeks = analytics.timeseries(db, { from: '2026-03-02', to: '2026-03-22' }, 'week');
    assert.deepEqual(weeks.map((w) => [w.date, w.cents]), [['2026-03-02', 4000], ['2026-03-09', 3000], ['2026-03-16', 3000]]);
    const months = analytics.timeseries(db, { from: '2026-02-01', to: '2026-03-31' }, 'month');
    assert.deepEqual(months.map((m) => [m.date, m.cents]), [['2026-02-01', 5000], ['2026-03-01', 10000]]);
  });

  it('averages each weekday over how often it occurs in the range', () => {
    const { days, weekdays } = analytics.calendar(db, MARCH);
    assert.equal(days.length, 31);
    const monday = weekdays[0]!; // March 2026 has five Mondays; two had spending
    assert.equal(monday.cents, 6000);
    assert.equal(monday.avgPerDayCents, 1200);
    assert.equal(weekdays.reduce((sum, w) => sum + w.cents, 0), 10000);
  });
});

describe('recurring charges', () => {
  it('finds a monthly subscription and projects it', () => {
    add('2026-01-25', 'ANTHROPIC* CLAUDE SUB', 31.64);
    add('2026-02-25', 'ANTHROPIC* CLAUDE SUB', 31.64);
    add('2026-03-25', 'ANTHROPIC* CLAUDE SUB', 31.64);
    const [sub] = analytics.recurring(db);
    assert.equal(sub!.merchant, 'Anthropic');
    assert.equal(sub!.typicalCents, 3164);
    assert.equal(sub!.occurrences, 3);
    assert.equal(sub!.nextExpected, '2026-04-25');
    assert.equal(sub!.annualCents, 3164 * 12);
  });

  it('ignores frequent merchants and one-off repeats', () => {
    for (const day of ['01', '03', '08', '15', '22', '29']) add(`2026-03-${day}`, 'TIM HORTONS #1', 3.5);
    add('2026-01-10', 'BEST BUY #1', 200);
    add('2026-03-10', 'BEST BUY #1', 40);
    assert.deepEqual(analytics.recurring(db), []);
  });

  it('tolerates a small price change and clamps the next date to a short month', () => {
    add('2025-12-31', 'FIDO MOBILE ******1234', 62.15);
    add('2026-01-31', 'FIDO MOBILE ******1234', 64.4);
    const [bill] = analytics.recurring(db);
    assert.equal(bill!.nextExpected, '2026-02-28');
  });
});

describe('anomalies', () => {
  it('flags a purchase far above what that merchant usually costs', () => {
    for (const day of ['02', '09', '16', '23']) add(`2026-02-${day}`, 'CAMPUS EATS-20411', 8);
    const big = add('2026-03-05', 'CAMPUS EATS-20411', 48);
    const [anomaly] = analytics.anomalies(db, MARCH);
    assert.equal(anomaly!.transactionId, big.id);
    assert.equal(anomaly!.reason, 'merchant-outlier');
    assert.equal(anomaly!.baselineCents, 800);
  });

  it('flags a large first purchase at a new merchant once there is history', () => {
    add('2026-01-05', 'METRO 100', 20);
    add('2026-03-05', 'BEST BUY #950', 412.85);
    const found = analytics.anomalies(db, MARCH);
    assert.deepEqual(found.map((a) => a.reason), ['new-merchant']);
  });

  it('stays quiet for ordinary spending', () => {
    for (const day of ['02', '09', '16', '23']) add(`2026-03-${day}`, 'METRO 100', 30 + Number(day));
    assert.deepEqual(analytics.anomalies(db, MARCH), []);
  });
});

describe('habits, groceries and insights', () => {
  it('measures small purchases and the most visited merchant', () => {
    for (const day of ['02', '03', '04', '05', '06']) add(`2026-03-${day}`, 'TIM HORTONS #1', 4);
    add('2026-03-07', 'METRO 100', 80);
    const h = analytics.habits(db, MARCH);
    assert.equal(h.smallPurchaseCount, 5);
    assert.equal(h.smallPurchaseCents, 2000);
    assert.equal(h.smallPurchaseShareOfSpend, 0.2);
    assert.deepEqual(h.mostVisited, { merchant: 'Tim Hortons', count: 5, cents: 2000 });
    assert.equal(h.busiestWeekday!.weekday, 5); // Saturday the 7th
  });

  it('reports nothing for groceries until a receipt is imported', () => {
    const g = analytics.groceries(db, MARCH);
    assert.deepEqual([g.receiptCount, g.itemLines, g.items.length], [0, 0, 0]);
  });

  it('writes insights only when they clear a threshold', () => {
    add('2026-02-10', 'METRO 100', 100);
    add('2026-03-10', 'METRO 100', 102);
    const quiet = ruleBasedInsights(db, MARCH).map((i) => i.id);
    assert.ok(!quiet.includes('period-change'), 'a 2% change is not news');
    assert.ok(quiet.includes('top-category'));

    add('2026-03-11', 'METRO 100', 100);
    const loud = ruleBasedInsights(db, MARCH);
    const change = loud.find((i) => i.id === 'period-change')!;
    assert.equal(change.tone, 'up');
    assert.match(change.title, /up 102%/);
    assert.match(change.detail, /\$202\.00.*\$100\.00/);
  });

  it('builds an AI rollup that contains aggregates only', () => {
    add('2026-03-10', 'METRO 100', 100);
    add('2026-03-11', 'SQ *PRIVATE CLINIC', 60);
    const rollup = buildRollup(db, MARCH);
    const json = JSON.stringify(rollup);
    assert.equal(rollup.totalCents, 16000);
    assert.doesNotMatch(json, /"id"|txnDate|description|notes|location/);
  });
});
