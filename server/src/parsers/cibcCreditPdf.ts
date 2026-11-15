import { monthFromName, parseLongDate, resolveYear } from '../lib/dates.ts';
import { parseMoneyToCents, sumCents } from '../lib/money.ts';
import type { PdfRow, PdfTextItem } from './pdfText.ts';
import { check, ParseError } from './types.ts';
import type { ParsedStatement, ParsedTransaction, ReconciliationCheck, TransactionType } from './types.ts';

/**
 * Parser for CIBC credit card eStatements (PDF).
 *
 * Layout facts this relies on, all relative to the x position of the first
 * date column so they survive the different margins on odd and even pages:
 *   - a transaction row starts with two "Mon DD" runs (transaction, posting date)
 *   - the spend category is a single run that starts ~304pt right of the first date
 *   - the amount is the right-most run on the row
 *   - merchant, city and province are separate runs unless the merchant name
 *     fills its 25-character field, in which case they are fused into one run
 *
 * The first page prints account totals. They are used only to verify the
 * parsed rows (see `checks`), never as a data source.
 */

const SHORT_DATE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})$/;
const CATEGORY_COLUMN_OFFSET = 290;
const MERCHANT_FIELD_WIDTH = 25;

const SUMMARY_LABELS = {
  'Previous balance': 'previousBalance',
  Payments: 'payments',
  'Other credits': 'otherCredits',
  Purchases: 'purchases',
  'Cash advances': 'cashAdvances',
  Interest: 'interest',
  Fees: 'fees',
  'Total balance': 'totalBalance',
} as const;

type SummaryKey = (typeof SUMMARY_LABELS)[keyof typeof SUMMARY_LABELS];

export function looksLikeCibcCreditStatement(rows: PdfRow[]): boolean {
  const firstPages = rows.filter((r) => r.page <= 2).map((r) => r.text).join('\n');
  return /CIBC/i.test(firstPages) && /Transactions\s+from\s+.+\s+to\s+.+\d{4}/i.test(firstPages);
}

function firstMoneyAfterLabel(items: PdfTextItem[]): number | null {
  for (const item of items.slice(1)) {
    if (item.text.includes('%')) continue;
    const cents = parseMoneyToCents(item.text);
    if (cents !== null) return cents;
  }
  return null;
}

function parsePeriod(rows: PdfRow[]): { start: string; end: string } {
  for (const row of rows) {
    const m = /Transactions\s+from\s+([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?\s+to\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i.exec(row.text);
    if (!m) continue;
    const end = parseLongDate(m[4]!);
    const startMonth = monthFromName(m[1]!);
    if (!end || !startMonth) break;
    const start = m[3] ? parseLongDate(`${m[1]} ${m[2]}, ${m[3]}`) : resolveYear(startMonth, Number(m[2]), end);
    if (start) return { start, end };
  }
  throw new ParseError('Could not find the statement period ("Transactions from ... to ...").');
}

function classify(section: 'payments' | 'charges', description: string, amountCents: number): TransactionType {
  if (section === 'payments') return 'payment';
  if (/\bINTEREST\b/i.test(description)) return 'interest';
  if (/\b(?:ANNUAL|OVERLIMIT|LATE|SERVICE)\b.*\bFEE\b|\bFEE\b/i.test(description) && amountCents > 0) return 'fee';
  if (amountCents < 0) return /CASH\s*BACK|REMISE|REWARD|ADJUSTMENT/i.test(description) ? 'credit' : 'refund';
  return 'purchase';
}

/** Splits a fused "MERCHANT................CITY" run at the fixed merchant field width. */
function splitMerchantAndLocation(parts: string[]): { description: string; location?: string } {
  const [first = '', ...rest] = parts;
  let description = first;
  const locationParts = [...rest];
  if (first.length > MERCHANT_FIELD_WIDTH) {
    description = first.slice(0, MERCHANT_FIELD_WIDTH).trim();
    locationParts.unshift(first.slice(MERCHANT_FIELD_WIDTH).trim());
  }
  const location = locationParts.join(' ').replace(/\s+/g, ' ').trim();
  return location ? { description, location } : { description };
}

export function parseCibcCreditStatement(rows: PdfRow[]): ParsedStatement {
  if (!looksLikeCibcCreditStatement(rows)) {
    throw new ParseError('This PDF does not look like a CIBC credit card statement.');
  }
  const period = parsePeriod(rows);
  const warnings: string[] = [];

  // --- Page 1 summary figures (verification only) ---------------------------
  const summary: Partial<Record<SummaryKey, number>> = {};
  for (const row of rows) {
    if (row.page !== 1) continue;
    const label = row.items[0]?.text.replace(/\d+$/, '').trim() ?? '';
    const key = SUMMARY_LABELS[label as keyof typeof SUMMARY_LABELS];
    if (!key || key in summary) continue;
    const value = firstMoneyAfterLabel(row.items);
    if (value !== null) summary[key] = Math.abs(value);
  }

  // --- Transaction rows ------------------------------------------------------
  const transactions: ParsedTransaction[] = [];
  const paymentRows: ParsedTransaction[] = [];
  const chargeRows: ParsedTransaction[] = [];
  let section: 'payments' | 'charges' | null = null;
  let last4: string | undefined;
  let statedTotalPayments: number | null = null;
  let statedCardTotals = 0;
  let sawCardTotal = false;
  let statedCount: number | null = null;
  let previous: { txn: ParsedTransaction; page: number; descX: number } | null = null;

  for (const row of rows) {
    const text = row.text;

    if (/^Your payments/i.test(text)) { section = 'payments'; previous = null; continue; }
    if (/^Your new charges and credits/i.test(text)) { section = 'charges'; previous = null; continue; }

    const card = /^Card number\s+[\dX* ]*?(\d{4})\s*$/i.exec(text);
    if (card) { last4 = card[1]; continue; }

    if (/^Total payments/i.test(text)) {
      statedTotalPayments = firstMoneyAfterLabel(row.items);
      previous = null;
      continue;
    }
    if (/^Total for\b/i.test(text)) {
      const value = parseMoneyToCents(row.items.at(-1)?.text ?? '');
      if (value !== null) { statedCardTotals += value; sawCardTotal = true; }
      previous = null;
      continue;
    }
    // Spend-category summary table: "Total | 54 | 796.41 | ..."
    if (row.items[0]?.text === 'Total' && /^\d+$/.test(row.items[1]?.text ?? '') && statedCount === null && sawCardTotal) {
      statedCount = Number(row.items[1]!.text);
      continue;
    }

    if (!section) continue;

    // The two date runs normally lead the row, but a margin barcode can share
    // the baseline, so look for the first adjacent pair of dates instead.
    const dateIndex = row.items.findIndex(
      (item, i) => SHORT_DATE.test(item.text) && SHORT_DATE.test(row.items[i + 1]?.text ?? ''),
    );
    if (dateIndex < 0) {
      // A line under a transaction with no dates of its own, for example the
      // foreign-currency detail "12.00 USD @ 1.3712". Keep it as a note.
      const lead = row.items[0];
      if (previous && row.page === previous.page && lead && Math.abs(lead.x - previous.descX) < 12 && /\d/.test(text) && text.length < 90) {
        previous.txn.notes = previous.txn.notes ? `${previous.txn.notes}; ${text}` : text;
      }
      continue;
    }
    const cells = row.items.slice(dateIndex);
    const first = cells[0]!;
    const d1 = SHORT_DATE.exec(first.text)!;
    const d2 = SHORT_DATE.exec(cells[1]!.text)!;

    const amountItem = cells.at(-1)!;
    const amountCents = parseMoneyToCents(amountItem.text);
    if (amountCents === null || cells.length < 4) {
      warnings.push(`Skipped a row on page ${row.page} whose amount could not be read.`);
      continue;
    }

    const middle = cells.slice(2, -1).filter((item) => /[A-Za-z0-9]{2}/.test(item.text));
    let bankCategory: string | undefined;
    if (section === 'charges' && middle.length > 1 && middle.at(-1)!.x >= first.x + CATEGORY_COLUMN_OFFSET) {
      bankCategory = middle.pop()!.text;
    }
    if (middle.length === 0) {
      warnings.push(`Skipped a row on page ${row.page} with no description.`);
      continue;
    }

    // Only the charges table has city/province columns; a payment line is one free-text field.
    const { description, location }: { description: string; location?: string } =
      section === 'charges'
        ? splitMerchantAndLocation(middle.map((item) => item.text))
        : { description: middle.map((item) => item.text).join(' ') };
    const type = classify(section, description, amountCents);
    const txn: ParsedTransaction = {
      txnDate: resolveYear(monthFromName(d1[1]!)!, Number(d1[2]), period.end),
      postDate: resolveYear(monthFromName(d2[1]!)!, Number(d2[2]), period.end),
      description,
      // A payment reduces the card balance, so it is stored as money coming in.
      amountCents: type === 'payment' ? -Math.abs(amountCents) : amountCents,
      type,
      ...(location ? { location } : {}),
      ...(bankCategory ? { bankCategory } : {}),
    };
    transactions.push(txn);
    (section === 'payments' ? paymentRows : chargeRows).push(txn);
    previous = { txn, page: row.page, descX: middle[0]!.x };
  }

  if (transactions.length === 0) {
    throw new ParseError('No transactions were found in this statement.');
  }

  // --- Reconciliation --------------------------------------------------------
  const checks: ReconciliationCheck[] = [];
  const paymentsTotal = Math.abs(sumCents(paymentRows.map((t) => t.amountCents)));
  const chargesPositive = sumCents(chargeRows.filter((t) => t.amountCents > 0).map((t) => t.amountCents));
  const chargesNegative = Math.abs(sumCents(chargeRows.filter((t) => t.amountCents < 0).map((t) => t.amountCents)));

  if (summary.payments !== undefined) checks.push(check('Payments (page 1 summary)', summary.payments, paymentsTotal));
  if (statedTotalPayments !== null) checks.push(check('Total payments (transaction list)', statedTotalPayments, paymentsTotal));
  if (summary.purchases !== undefined) {
    const statedCharges = summary.purchases + (summary.cashAdvances ?? 0) + (summary.interest ?? 0) + (summary.fees ?? 0);
    checks.push(check('Purchases, advances, interest and fees', statedCharges, chargesPositive));
  }
  if (summary.otherCredits !== undefined) checks.push(check('Other credits', summary.otherCredits, chargesNegative));
  if (sawCardTotal) checks.push(check('Net new charges (card total)', statedCardTotals, chargesPositive - chargesNegative));
  if (statedCount !== null) checks.push(check('Number of charges and credits', statedCount, chargeRows.length, 'count'));

  if (checks.length === 0) warnings.push('No printed totals were found, so the parsed rows could not be verified.');
  for (const c of checks) {
    if (!c.ok) warnings.push(`Reconciliation mismatch on "${c.label}": statement says ${c.expected}, parsed rows give ${c.actual}.`);
  }

  return {
    docType: 'statement',
    kind: 'cibc-credit-pdf',
    institution: 'CIBC',
    accountName: 'CIBC credit card',
    accountType: 'credit',
    ...(last4 ? { accountLast4: last4 } : {}),
    periodStart: period.start,
    periodEnd: period.end,
    transactions,
    checks,
    warnings,
  };
}
