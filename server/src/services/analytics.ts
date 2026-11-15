import type {
  Anomaly, CalendarData, CategoryBreakdown, DateRange, GroceryStats, Habits, MerchantBreakdown,
  RecurringCharge, Scope, Summary, TimeseriesPoint,
} from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { addDays, daysBetween, eachDay, todayIso, weekdayIndex } from '../lib/dates.ts';
import { notFound } from '../lib/errors.ts';
import { formatCents } from '../lib/money.ts';

/**
 * Every figure here is computed from the same definition of "spending":
 * purchases, refunds, fees and interest in expense categories. Card payments
 * and reward credits are excluded, and refunds net against purchases, so the
 * dashboard total is what the period actually cost.
 */
const SPEND = `
  FROM transactions t JOIN categories c ON c.id = t.category_id
  WHERE c.kind = 'expense' AND t.type IN ('purchase', 'refund', 'fee', 'interest')`;

/**
 * The row filter for a scope. A statement scope selects by import, because a
 * statement holds what was *posted* in its period: a purchase made the evening
 * before the period opens belongs to it, and a date filter would lose it.
 */
function within(scope: Scope): { sql: string; params: Array<string | number> } {
  return scope.importId
    ? { sql: 'AND t.import_id = ?', params: [scope.importId] }
    : { sql: 'AND t.txn_date BETWEEN ? AND ?', params: [scope.from, scope.to] };
}

function inScope(scope: Scope, row: { txnDate: string; importId: number | null }): boolean {
  return scope.importId ? row.importId === scope.importId : row.txnDate >= scope.from && row.txnDate <= scope.to;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

export function dataBounds(db: Db): DateRange | null {
  const row = db.prepare(`SELECT MIN(t.txn_date) AS first, MAX(t.txn_date) AS last ${SPEND}`).get();
  return row?.['first'] ? { from: String(row['first']), to: String(row['last']) } : null;
}

/**
 * Turns request parameters into a scope. With `importId` the scope is that
 * statement, and its dates stretch to cover every transaction on it. Otherwise
 * a missing range means everything on file, or the last 30 days when the
 * database is empty.
 */
export function resolveScope(db: Db, input: { from?: string | undefined; to?: string | undefined; importId?: number | undefined }): Scope {
  if (input.importId) {
    const row = db
      .prepare(
        `SELECT i.period_start AS periodStart, i.period_end AS periodEnd, MIN(t.txn_date) AS first, MAX(t.txn_date) AS last
         FROM imports i LEFT JOIN transactions t ON t.import_id = i.id WHERE i.id = ? GROUP BY i.id`,
      )
      .get(input.importId);
    if (!row) throw notFound(`Import ${input.importId}`);
    const starts = [row['periodStart'], row['first']].filter((v): v is string => typeof v === 'string').sort();
    const ends = [row['periodEnd'], row['last']].filter((v): v is string => typeof v === 'string').sort();
    const today = todayIso();
    return { from: starts[0] ?? today, to: ends.at(-1) ?? today, importId: input.importId };
  }
  const bounds = dataBounds(db);
  const to = input.to ?? bounds?.to ?? todayIso();
  const from = input.from ?? bounds?.from ?? addDays(to, -29);
  return from <= to ? { from, to } : { from: to, to };
}

function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/**
 * The comparison period. A monthly cycle (a calendar month, or a statement
 * period such as the 22nd to the 21st) compares with the cycle before it.
 * Anything else compares with the same number of days immediately before.
 */
export function previousRange(range: DateRange): DateRange {
  const isCalendarMonth = range.from.endsWith('-01') && addDays(addMonths(range.from, 1), -1) === range.to;
  if (isCalendarMonth) {
    const prevEnd = addDays(range.from, -1);
    return { from: `${prevEnd.slice(0, 8)}01`, to: prevEnd };
  }
  const isMonthlyCycle = Number(range.from.slice(8)) <= 28 && addDays(addMonths(range.from, 1), -1) === range.to;
  if (isMonthlyCycle) return { from: addMonths(range.from, -1), to: addDays(range.from, -1) };
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

/**
 * What a scope is compared with: the statement before it on the same account,
 * or the preceding date range. Null when nothing earlier is on file, so the
 * dashboard never reports "up 100%" just because history starts here.
 */
export function previousScope(db: Db, scope: Scope): Scope | null {
  if (scope.importId) {
    const row = db
      .prepare(
        `SELECT p.id FROM imports cur
         JOIN imports p ON p.account_id IS cur.account_id AND p.period_end < cur.period_start AND p.rows_inserted > 0
         WHERE cur.id = ? ORDER BY p.period_end DESC LIMIT 1`,
      )
      .get(scope.importId);
    return row ? resolveScope(db, { importId: Number(row['id']) }) : null;
  }
  const bounds = dataBounds(db);
  const previous = previousRange(scope);
  return bounds && previous.to >= bounds.from ? previous : null;
}

function totals(db: Db, range: Scope): { cents: number; purchases: number; refunds: number; activeDays: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_cents), 0) AS cents,
              COALESCE(SUM(t.type = 'purchase'), 0) AS purchases,
              COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0) AS refunds,
              COUNT(DISTINCT CASE WHEN t.amount_cents > 0 THEN t.txn_date END) AS activeDays
       ${SPEND} ${within(range).sql}`,
    )
    .get(...within(range).params)!;
  return {
    cents: Number(row['cents']),
    purchases: Number(row['purchases']),
    refunds: Number(row['refunds']),
    activeDays: Number(row['activeDays']),
  };
}

export function summary(db: Db, range: Scope): Summary {
  const current = totals(db, range);
  const days = daysBetween(range.from, range.to) + 1;
  const scope = within(range);
  const amounts = db
    .prepare(`SELECT t.amount_cents AS cents ${SPEND} ${scope.sql} AND t.type = 'purchase'`)
    .all(...scope.params)
    .map((r) => Number(r['cents']));
  const largest = db
    .prepare(
      `SELECT t.id, t.merchant, t.amount_cents AS amountCents, t.txn_date AS txnDate
       ${SPEND} ${scope.sql} AND t.type = 'purchase' ORDER BY t.amount_cents DESC, t.id LIMIT 1`,
    )
    .get(...scope.params) as unknown as Summary['largest'] | undefined;

  const prior = previousScope(db, range);
  const previous = prior ? totals(db, prior) : null;

  return {
    range: { from: range.from, to: range.to },
    importId: range.importId ?? null,
    dataBounds: dataBounds(db),
    totalCents: current.cents,
    purchaseCount: current.purchases,
    refundCents: current.refunds,
    days,
    activeDays: current.activeDays,
    avgPerDayCents: Math.round(current.cents / days),
    medianPurchaseCents: median(amounts),
    largest: largest ?? null,
    previous:
      prior && previous
        ? { range: { from: prior.from, to: prior.to }, importId: prior.importId ?? null, totalCents: previous.cents, purchaseCount: previous.purchases }
        : null,
    changeRatio: previous && previous.cents > 0 ? (current.cents - previous.cents) / previous.cents : null,
  };
}

export function byCategory(db: Db, range: Scope): CategoryBreakdown[] {
  const grouped = (scope: Scope) =>
    db
      .prepare(
        `SELECT c.id AS categoryId, c.name, SUM(t.amount_cents) AS cents, SUM(t.type = 'purchase') AS count
         ${SPEND} ${within(scope).sql} GROUP BY c.id`,
      )
      .all(...within(scope).params);
  const prior = previousScope(db, range);
  const previous = new Map((prior ? grouped(prior) : []).map((r) => [Number(r['categoryId']), Number(r['cents'])]));
  const rows = grouped(range);
  const total = rows.reduce((sum, r) => sum + Math.max(0, Number(r['cents'])), 0);
  return rows
    .map((r) => ({
      categoryId: Number(r['categoryId']),
      name: String(r['name']),
      cents: Number(r['cents']),
      count: Number(r['count']),
      share: total > 0 ? Math.max(0, Number(r['cents'])) / total : 0,
      previousCents: previous.get(Number(r['categoryId'])) ?? 0,
    }))
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}

function bucketStart(date: string, granularity: 'day' | 'week' | 'month'): string {
  if (granularity === 'month') return `${date.slice(0, 8)}01`;
  if (granularity === 'week') return addDays(date, -weekdayIndex(date));
  return date;
}

export function timeseries(db: Db, range: Scope, granularity: 'day' | 'week' | 'month'): TimeseriesPoint[] {
  const daily = new Map(
    db
      .prepare(`SELECT t.txn_date AS date, SUM(t.amount_cents) AS cents, SUM(t.type = 'purchase') AS count ${SPEND} ${within(range).sql} GROUP BY t.txn_date`)
      .all(...within(range).params)
      .map((r) => [String(r['date']), { cents: Number(r['cents']), count: Number(r['count']) }]),
  );
  const buckets = new Map<string, { cents: number; count: number }>();
  for (const day of eachDay(range.from, range.to)) {
    const key = bucketStart(day, granularity);
    const bucket = buckets.get(key) ?? { cents: 0, count: 0 };
    const value = daily.get(day);
    if (value) { bucket.cents += value.cents; bucket.count += value.count; }
    buckets.set(key, bucket);
  }
  let cumulativeCents = 0;
  return [...buckets.entries()].map(([date, b]) => {
    cumulativeCents += b.cents;
    return { date, cents: b.cents, count: b.count, cumulativeCents };
  });
}

export function topMerchants(db: Db, range: Scope, limit = 10): MerchantBreakdown[] {
  return db
    .prepare(
      `SELECT t.merchant, MAX(c.name) AS categoryName, SUM(t.amount_cents) AS cents, SUM(t.type = 'purchase') AS count,
              MAX(t.txn_date) AS lastDate
       ${SPEND} ${within(range).sql} GROUP BY t.merchant COLLATE NOCASE
       HAVING cents > 0 ORDER BY cents DESC, t.merchant LIMIT ?`,
    )
    .all(...within(range).params, limit)
    .map((r) => ({
      merchant: String(r['merchant']),
      categoryName: String(r['categoryName']),
      cents: Number(r['cents']),
      count: Number(r['count']),
      avgCents: Math.round(Number(r['cents']) / Math.max(1, Number(r['count']))),
      lastDate: String(r['lastDate']),
    }));
}

export function calendar(db: Db, range: Scope): CalendarData {
  const days = timeseries(db, range, 'day').map(({ date, cents, count }) => ({ date, cents, count }));
  const weekdays = Array.from({ length: 7 }, (_unused, weekday) => ({ weekday, cents: 0, count: 0, occurrences: 0 }));
  for (const day of days) {
    const slot = weekdays[weekdayIndex(day.date)]!;
    slot.cents += day.cents;
    slot.count += day.count;
    slot.occurrences += 1;
  }
  return {
    days,
    weekdays: weekdays.map(({ occurrences, ...w }) => ({
      ...w,
      avgPerDayCents: occurrences ? Math.round(w.cents / occurrences) : 0,
    })),
  };
}

interface PurchaseRow {
  id: number;
  txnDate: string;
  merchant: string;
  amountCents: number;
  categoryName: string;
  importId: number | null;
}

function allPurchases(db: Db): PurchaseRow[] {
  return db
    .prepare(
      `SELECT t.id, t.txn_date AS txnDate, t.merchant, t.amount_cents AS amountCents, c.name AS categoryName, t.import_id AS importId
       ${SPEND} AND t.type = 'purchase' ORDER BY t.txn_date, t.id`,
    )
    .all() as unknown as PurchaseRow[];
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/**
 * Finds subscriptions and bills: a merchant charged at a steady monthly
 * interval for a steady amount. Frequent merchants (coffee, transit) fail the
 * interval test, so they are not mistaken for subscriptions.
 */
export function recurring(db: Db): RecurringCharge[] {
  const out: RecurringCharge[] = [];
  for (const [, rows] of groupBy(allPurchases(db), (r) => r.merchant.toLowerCase())) {
    if (rows.length < 2) continue;
    const intervals = rows.slice(1).map((row, i) => daysBetween(rows[i]!.txnDate, row.txnDate));
    const typicalInterval = median(intervals);
    const typicalCents = median(rows.map((r) => r.amountCents));
    const steadyInterval = typicalInterval >= 26 && typicalInterval <= 35 && intervals.every((d) => d >= 20 && d <= 45);
    const steadyAmount = rows.every((r) => Math.abs(r.amountCents - typicalCents) <= Math.max(100, typicalCents * 0.15));
    if (!steadyInterval || !steadyAmount) continue;
    const last = rows.at(-1)!;
    out.push({
      merchant: last.merchant,
      categoryName: last.categoryName,
      typicalCents,
      occurrences: rows.length,
      intervalDays: typicalInterval,
      lastDate: last.txnDate,
      // A monthly bill lands on the same day next month, clamped for short months (Jan 31 -> Feb 28).
      nextExpected: addMonths(last.txnDate, 1),
      annualCents: typicalCents * 12,
    });
  }
  return out.sort((a, b) => b.typicalCents - a.typicalCents);
}

/**
 * Flags purchases that stand out from history. Uses medians and the
 * interquartile range rather than mean and standard deviation, because a
 * handful of large purchases would otherwise hide each other.
 */
export function anomalies(db: Db, range: Scope, limit = 5): Anomaly[] {
  const purchases = allPurchases(db);
  const byMerchant = groupBy(purchases, (r) => r.merchant.toLowerCase());
  const byCat = groupBy(purchases, (r) => r.categoryName);
  const found: Array<Anomaly & { score: number }> = [];

  for (const row of purchases) {
    if (!inScope(range, row)) continue;

    const peers = byMerchant.get(row.merchant.toLowerCase())!.filter((r) => r.id !== row.id);
    if (peers.length >= 3) {
      const typical = median(peers.map((r) => r.amountCents));
      if (row.amountCents >= typical * 2.5 && row.amountCents - typical >= 1000) {
        found.push({
          transactionId: row.id, txnDate: row.txnDate, merchant: row.merchant, amountCents: row.amountCents,
          reason: 'merchant-outlier', baselineCents: typical, score: row.amountCents / Math.max(1, typical),
          detail: `${formatCents(row.amountCents)} at ${row.merchant}, where you usually spend about ${formatCents(typical)}.`,
        });
        continue;
      }
    }

    // Only judge against the whole category when this merchant has too little
    // history of its own: a large grocery shop is normal at a supermarket even
    // if it dwarfs every coffee in the same category.
    const categoryPeers = byCat.get(row.categoryName)!.filter((r) => r.id !== row.id).map((r) => r.amountCents).sort((a, b) => a - b);
    if (peers.length < 3 && categoryPeers.length >= 8) {
      const q1 = quantile(categoryPeers, 0.25);
      const q3 = quantile(categoryPeers, 0.75);
      const fence = Math.round(q3 + 3 * (q3 - q1));
      if (row.amountCents > fence && row.amountCents >= 4000) {
        found.push({
          transactionId: row.id, txnDate: row.txnDate, merchant: row.merchant, amountCents: row.amountCents,
          reason: 'category-outlier', baselineCents: fence, score: row.amountCents / Math.max(1, fence),
          detail: `${formatCents(row.amountCents)} at ${row.merchant} is well above your usual ${row.categoryName} purchase (most are under ${formatCents(fence)}).`,
        });
        continue;
      }
    }

    const firstVisit = byMerchant.get(row.merchant.toLowerCase())![0]!.id === row.id;
    const hasHistory = purchases[0]!.txnDate < addDays(row.txnDate, -14);
    if (firstVisit && peers.length === 0 && hasHistory && row.amountCents >= 4000) {
      found.push({
        transactionId: row.id, txnDate: row.txnDate, merchant: row.merchant, amountCents: row.amountCents,
        reason: 'new-merchant', baselineCents: 0, score: row.amountCents / 4000,
        detail: `First purchase at ${row.merchant}: ${formatCents(row.amountCents)}.`,
      });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _score, ...anomaly }) => anomaly);
}

const SMALL_PURCHASE_CENTS = 1000;

export function habits(db: Db, range: Scope): Habits {
  const rows = allPurchases(db).filter((r) => inScope(range, r));
  const totalCents = rows.reduce((sum, r) => sum + r.amountCents, 0);
  const small = rows.filter((r) => r.amountCents < SMALL_PURCHASE_CENTS);
  const smallCents = small.reduce((sum, r) => sum + r.amountCents, 0);

  let mostVisited: Habits['mostVisited'] = null;
  for (const [, visits] of groupBy(rows, (r) => r.merchant.toLowerCase())) {
    const cents = visits.reduce((sum, r) => sum + r.amountCents, 0);
    if (!mostVisited || visits.length > mostVisited.count || (visits.length === mostVisited.count && cents > mostVisited.cents)) {
      mostVisited = { merchant: visits[0]!.merchant, count: visits.length, cents };
    }
  }

  const busiest = calendar(db, range).weekdays.reduce<Habits['busiestWeekday']>(
    (best, w) => (w.avgPerDayCents > (best?.avgPerDayCents ?? 0) ? { weekday: w.weekday, avgPerDayCents: w.avgPerDayCents } : best),
    null,
  );

  return {
    smallPurchaseLimitCents: SMALL_PURCHASE_CENTS,
    smallPurchaseCount: small.length,
    smallPurchaseCents: smallCents,
    smallPurchaseShareOfCount: rows.length ? small.length / rows.length : 0,
    smallPurchaseShareOfSpend: totalCents > 0 ? smallCents / totalCents : 0,
    mostVisited: mostVisited && mostVisited.count >= 2 ? mostVisited : null,
    busiestWeekday: busiest,
  };
}

/** Item-level statistics from imported receipts: what was bought, how often, and at what unit price. */
export function groceries(db: Db, range: DateRange): GroceryStats {
  const receiptTotals = db
    .prepare(
      `SELECT COUNT(*) AS receiptCount, COALESCE(SUM(total_cents), 0) AS spendCents,
              COALESCE(SUM(savings_cents), 0) AS savingsCents, COALESCE(SUM(tax_cents), 0) AS taxCents,
              COALESCE(SUM(NOT EXISTS (SELECT 1 FROM transactions t WHERE t.receipt_id = receipts.id)), 0) AS unlinked
       FROM receipts WHERE purchased_on BETWEEN ? AND ?`,
    )
    .get(range.from, range.to)!;

  const lines = db
    .prepare(
      `SELECT i.name, i.department, i.unit, i.unit_price_cents AS unitPriceCents, i.total_cents AS totalCents,
              i.saving_cents AS savingCents, r.purchased_on AS purchasedOn
       FROM receipt_items i JOIN receipts r ON r.id = i.receipt_id
       WHERE r.purchased_on BETWEEN ? AND ? ORDER BY r.purchased_on, i.position`,
    )
    .all(range.from, range.to);

  const items = [...groupBy(lines, (l) => String(l['name']).toLowerCase()).values()].map((group) => {
    const last = group.at(-1)!;
    const unitPrices = group.map((l) => l['unitPriceCents']).filter((p): p is number => typeof p === 'number');
    return {
      name: String(last['name']),
      department: (last['department'] as string | null) ?? null,
      timesBought: group.length,
      totalCents: group.reduce((sum, l) => sum + Number(l['totalCents']), 0),
      totalSavingCents: group.reduce((sum, l) => sum + Number(l['savingCents']), 0),
      unit: (last['unit'] as string | null) ?? null,
      lastUnitPriceCents: unitPrices.at(-1) ?? null,
      minUnitPriceCents: unitPrices.length ? Math.min(...unitPrices) : null,
      maxUnitPriceCents: unitPrices.length ? Math.max(...unitPrices) : null,
      lastBought: String(last['purchasedOn']),
    };
  });

  const departments = [...groupBy(lines, (l) => String(l['department'] ?? 'Other')).entries()]
    .map(([department, group]) => ({
      department,
      cents: group.reduce((sum, l) => sum + Number(l['totalCents']), 0),
      count: group.length,
    }))
    .sort((a, b) => b.cents - a.cents);

  return {
    receiptCount: Number(receiptTotals['receiptCount']),
    itemLines: lines.length,
    spendCents: Number(receiptTotals['spendCents']),
    savingsCents: Number(receiptTotals['savingsCents']),
    taxCents: Number(receiptTotals['taxCents']),
    unlinkedReceipts: Number(receiptTotals['unlinked']),
    items: items.sort((a, b) => b.totalCents - a.totalCents).slice(0, 50),
    departments,
  };
}
