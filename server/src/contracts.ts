/**
 * The API contract: every request shape the server accepts and every response
 * shape it returns. The web app imports the types from this file directly, so
 * the two sides cannot drift apart without a compile error.
 */
import { z } from 'zod';
import { isIsoDate } from './lib/dates.ts';

export const TRANSACTION_TYPES = ['purchase', 'refund', 'payment', 'credit', 'fee', 'interest'] as const;
export const CATEGORY_SOURCES = ['manual', 'rule', 'ai', 'bank', 'default'] as const;

const IsoDate = z.string().refine(isIsoDate, 'Expected a calendar date as YYYY-MM-DD');
const Id = z.coerce.number().int().positive();
const Cents = z.number().int().min(-100_000_000).max(100_000_000);
const QueryCents = z.coerce.number().int().min(-100_000_000).max(100_000_000);
const QueryBool = z.enum(['true', 'false']).transform((v) => v === 'true');

// --- Transactions -----------------------------------------------------------

export const TransactionCreateSchema = z.strictObject({
  txnDate: IsoDate,
  description: z.string().trim().min(1).max(200),
  amountCents: Cents.refine((v) => v !== 0, 'Amount cannot be zero'),
  type: z.enum(TRANSACTION_TYPES).default('purchase'),
  categoryId: z.number().int().positive().optional(),
  notes: z.string().trim().max(500).optional(),
});

export const TransactionUpdateSchema = z
  .strictObject({
    txnDate: IsoDate,
    description: z.string().trim().min(1).max(200),
    amountCents: Cents.refine((v) => v !== 0, 'Amount cannot be zero'),
    categoryId: z.number().int().positive(),
    notes: z.string().trim().max(500).nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update');

export const TransactionQuerySchema = z.strictObject({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  categoryId: Id.optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  minCents: QueryCents.optional(),
  maxCents: QueryCents.optional(),
  hasReceipt: QueryBool.optional(),
  importId: Id.optional(),
  sort: z.enum(['date', 'amount', 'merchant']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface Transaction {
  id: number;
  txnDate: string;
  postDate: string | null;
  description: string;
  merchant: string;
  location: string | null;
  amountCents: number;
  type: (typeof TRANSACTION_TYPES)[number];
  categoryId: number;
  categoryName: string;
  categorySource: (typeof CATEGORY_SOURCES)[number];
  bankCategory: string | null;
  notes: string | null;
  receiptId: number | null;
  importId: number | null;
  accountId: number | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// --- Categories and rules ---------------------------------------------------

export const CategoryCreateSchema = z.strictObject({
  name: z.string().trim().min(2).max(40),
});

export const CategoryUpdateSchema = CategoryCreateSchema;

export interface Category {
  id: number;
  name: string;
  kind: 'expense' | 'excluded';
  isSystem: boolean;
  transactionCount: number;
}

export const RuleCreateSchema = z.strictObject({
  pattern: z.string().trim().min(2).max(60),
  categoryId: z.number().int().positive(),
});

export interface Rule {
  id: number;
  pattern: string;
  categoryId: number;
  categoryName: string;
  source: 'user' | 'ai' | 'seed';
  priority: number;
}

// --- Imports ------------------------------------------------------------------

export const ImportOptionsSchema = z.strictObject({
  dryRun: QueryBool.default(false),
  parser: z.enum(['auto', 'ai']).default('auto'),
});

export interface CheckResult {
  label: string;
  unit: 'cents' | 'count';
  expected: number;
  actual: number;
  ok: boolean;
}

export interface ImportPreviewRow {
  txnDate: string;
  description: string;
  merchant: string;
  amountCents: number;
  type: (typeof TRANSACTION_TYPES)[number];
  categoryName: string;
  duplicate: boolean;
}

export interface ImportResult {
  status: 'imported' | 'preview' | 'duplicate';
  importId: number | null;
  docType: 'statement' | 'receipt';
  kind: string;
  parser: 'deterministic' | 'ai';
  filename: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowsParsed: number;
  rowsInserted: number;
  rowsDuplicate: number;
  /** True when every figure printed on the document matched the parsed rows; null when it printed none. */
  reconciled: boolean | null;
  checks: CheckResult[];
  warnings: string[];
  receiptsLinked: number;
  preview: ImportPreviewRow[];
}

export interface ImportRecord {
  id: number;
  filename: string;
  kind: string;
  parser: 'deterministic' | 'ai';
  periodStart: string | null;
  periodEnd: string | null;
  rowsParsed: number;
  rowsInserted: number;
  rowsDuplicate: number;
  reconciled: boolean | null;
  checks: CheckResult[];
  warnings: string[];
  importedAt: string;
}

// --- Receipts -----------------------------------------------------------------

export interface ReceiptItem {
  id: number;
  department: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  unitPriceCents: number | null;
  totalCents: number;
  savingCents: number;
  taxable: boolean;
}

export interface Receipt {
  id: number;
  merchant: string;
  storeRef: string | null;
  purchasedOn: string;
  purchasedTime: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  savingsCents: number;
  paymentMethod: string | null;
  itemCount: number;
  arithmeticOk: boolean;
  /** The statement line this receipt explains, once that statement is imported. */
  transactionId: number | null;
  items?: ReceiptItem[];
}

// --- Analytics ----------------------------------------------------------------

/**
 * What a report covers: either a date range (by purchase date) or one imported
 * statement (`importId`). A statement is cut by posting date, so only the
 * statement scope reproduces the totals printed on it.
 */
const scopeShape = { from: IsoDate.optional(), to: IsoDate.optional(), importId: Id.optional() };

export const RangeQuerySchema = z
  .strictObject(scopeShape)
  .refine((r) => !r.from || !r.to || r.from <= r.to, '"from" must not be after "to"');

export const TimeseriesQuerySchema = z
  .strictObject({ ...scopeShape, granularity: z.enum(['day', 'week', 'month']).default('day') })
  .refine((r) => !r.from || !r.to || r.from <= r.to, '"from" must not be after "to"');

export interface DateRange {
  from: string;
  to: string;
}

/** A date range, optionally narrowed to the transactions of one imported statement. */
export interface Scope extends DateRange {
  importId?: number | undefined;
}

export interface Summary {
  range: DateRange;
  /** Set when the report covers one imported statement rather than a date range. */
  importId: number | null;
  /** Earliest and latest transaction dates in the whole database. */
  dataBounds: DateRange | null;
  totalCents: number;
  purchaseCount: number;
  refundCents: number;
  days: number;
  activeDays: number;
  avgPerDayCents: number;
  medianPurchaseCents: number;
  largest: { id: number; merchant: string; amountCents: number; txnDate: string } | null;
  previous: { range: DateRange; importId: number | null; totalCents: number; purchaseCount: number } | null;
  /** Fractional change vs the previous period (0.12 = +12%); null when there is no baseline. */
  changeRatio: number | null;
}

export interface CategoryBreakdown {
  categoryId: number;
  name: string;
  cents: number;
  count: number;
  share: number;
  previousCents: number;
}

export interface TimeseriesPoint {
  /** First day of the bucket. */
  date: string;
  cents: number;
  count: number;
  cumulativeCents: number;
}

export interface MerchantBreakdown {
  merchant: string;
  categoryName: string;
  cents: number;
  count: number;
  avgCents: number;
  lastDate: string;
}

export interface DailyCell {
  date: string;
  cents: number;
  count: number;
}

export interface WeekdayStat {
  /** 0 = Monday ... 6 = Sunday */
  weekday: number;
  cents: number;
  count: number;
  avgPerDayCents: number;
}

export interface CalendarData {
  days: DailyCell[];
  weekdays: WeekdayStat[];
}

export interface RecurringCharge {
  merchant: string;
  categoryName: string;
  typicalCents: number;
  occurrences: number;
  intervalDays: number;
  lastDate: string;
  nextExpected: string;
  annualCents: number;
}

export interface Anomaly {
  transactionId: number;
  txnDate: string;
  merchant: string;
  amountCents: number;
  reason: 'merchant-outlier' | 'category-outlier' | 'new-merchant';
  /** What this was compared against, in cents. */
  baselineCents: number;
  detail: string;
}

export interface Habits {
  smallPurchaseLimitCents: number;
  smallPurchaseCount: number;
  smallPurchaseCents: number;
  smallPurchaseShareOfCount: number;
  smallPurchaseShareOfSpend: number;
  mostVisited: { merchant: string; count: number; cents: number } | null;
  busiestWeekday: { weekday: number; avgPerDayCents: number } | null;
}

export interface GroceryItemStat {
  name: string;
  department: string | null;
  timesBought: number;
  totalCents: number;
  totalSavingCents: number;
  unit: string | null;
  lastUnitPriceCents: number | null;
  minUnitPriceCents: number | null;
  maxUnitPriceCents: number | null;
  lastBought: string;
}

export interface GroceryStats {
  receiptCount: number;
  itemLines: number;
  spendCents: number;
  savingsCents: number;
  taxCents: number;
  unlinkedReceipts: number;
  items: GroceryItemStat[];
  departments: Array<{ department: string; cents: number; count: number }>;
}

export interface Insight {
  id: string;
  tone: 'neutral' | 'up' | 'down' | 'alert';
  title: string;
  detail: string;
}

export interface InsightsResponse {
  source: 'rules' | 'ai';
  model: string | null;
  insights: Insight[];
}

export interface HealthResponse {
  status: 'ok';
  version: string;
  ai: { enabled: boolean; model: string | null };
  auth: 'token' | 'none';
  counts: { transactions: number; receipts: number; imports: number };
}
