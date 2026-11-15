import { parse } from 'csv-parse/sync';
import { isIsoDate, isValidYmd, toIsoDate } from '../lib/dates.ts';
import { parseMoneyToCents } from '../lib/money.ts';
import { ParseError } from './types.ts';
import type { ParsedStatement, ParsedTransaction, TransactionType } from './types.ts';

const MAX_ROWS = 20_000;

function classify(description: string, amountCents: number): TransactionType {
  if (/PAYMENT THANK YOU|PAIEMENT MERCI|PAYMENT RECEIVED/i.test(description)) return 'payment';
  if (/\bINTEREST\b/i.test(description)) return 'interest';
  if (amountCents < 0) return /CASH\s*BACK|REMISE|REWARD/i.test(description) ? 'credit' : 'refund';
  if (/\bFEE\b/i.test(description)) return 'fee';
  return 'purchase';
}

function readRows(text: string): string[][] {
  try {
    return parse(text, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true, to: MAX_ROWS + 1 }) as string[][];
  } catch {
    throw new ParseError('The file could not be read as CSV.');
  }
}

/** Accepts 2026-09-21, 09/21/2026 and 21-Sep-2026 style dates. */
function parseDate(value: string): string | null {
  const v = value.trim();
  if (isIsoDate(v)) return v;
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
  if (slash) {
    const [a, b, year] = [Number(slash[1]), Number(slash[2]), Number(slash[3])];
    // North American month-first unless the first number cannot be a month.
    const [month, day] = a > 12 ? [b, a] : [a, b];
    return isValidYmd(year, month, day) ? toIsoDate(year, month, day) : null;
  }
  const parsed = new Date(`${v} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * CIBC "download transactions" export: no header row, columns are
 * date, description, debit, credit and (credit cards only) a masked card number.
 */
export function looksLikeCibcCsv(text: string): boolean {
  const first = readRows(text.split(/\r?\n/).slice(0, 3).join('\n'))[0];
  return !!first && first.length >= 4 && first.length <= 5 && isIsoDate(first[0] ?? '') && !/[a-z]{3}/i.test(first[2] ?? '');
}

export function parseCibcCsv(text: string): ParsedStatement {
  const rows = readRows(text);
  if (rows.length > MAX_ROWS) throw new ParseError(`CSV has more than ${MAX_ROWS} rows.`);
  const transactions: ParsedTransaction[] = [];
  const warnings: string[] = [];
  let last4: string | undefined;

  rows.forEach((row, index) => {
    const [date, description = '', debit = '', credit = '', card = ''] = row;
    const txnDate = parseDate(date ?? '');
    const debitCents = debit ? parseMoneyToCents(debit) : 0;
    const creditCents = credit ? parseMoneyToCents(credit) : 0;
    if (!txnDate || !description || debitCents === null || creditCents === null || (!debitCents && !creditCents)) {
      warnings.push(`Skipped CSV row ${index + 1}: not a transaction.`);
      return;
    }
    // Keep only the last four digits of the masked card column.
    const digits = /(\d{4})\s*$/.exec(card);
    if (digits) last4 = digits[1];

    const amountCents = Math.abs(debitCents) - Math.abs(creditCents);
    transactions.push({ txnDate, description, amountCents, type: classify(description, amountCents) });
  });

  if (transactions.length === 0) throw new ParseError('No transactions were found in this CSV.');
  const dates = transactions.map((t) => t.txnDate).sort();
  warnings.push('CSV exports carry no printed totals, so these rows could not be verified against the bank.');
  return {
    docType: 'statement',
    kind: 'cibc-csv',
    institution: 'CIBC',
    accountName: last4 ? 'CIBC credit card' : 'CIBC account',
    accountType: last4 ? 'credit' : 'chequing',
    ...(last4 ? { accountLast4: last4 } : {}),
    periodStart: dates[0]!,
    periodEnd: dates.at(-1)!,
    transactions,
    checks: [],
    warnings,
  };
}

const HEADER_SYNONYMS = {
  date: ['date', 'transaction date', 'trans date', 'posted date', 'posting date'],
  description: ['description', 'merchant', 'payee', 'name', 'details', 'memo'],
  amount: ['amount', 'amount (cad)', 'cad$', 'value'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'debit amount', 'money out'],
  credit: ['credit', 'deposit', 'deposits', 'credit amount', 'money in'],
  category: ['category', 'spend category'],
} as const;

/** Any CSV with a header row naming a date, a description and an amount (or debit/credit pair). */
export function parseGenericCsv(text: string): ParsedStatement {
  const rows = readRows(text);
  const header = rows[0]?.map((h) => h.toLowerCase().trim()) ?? [];
  const column = (key: keyof typeof HEADER_SYNONYMS) =>
    header.findIndex((h) => (HEADER_SYNONYMS[key] as readonly string[]).includes(h));
  const cols = {
    date: column('date'),
    description: column('description'),
    amount: column('amount'),
    debit: column('debit'),
    credit: column('credit'),
    category: column('category'),
  };
  if (cols.date < 0 || cols.description < 0 || (cols.amount < 0 && cols.debit < 0)) {
    throw new ParseError('CSV needs a header row with date, description and amount (or debit/credit) columns.');
  }
  if (rows.length > MAX_ROWS) throw new ParseError(`CSV has more than ${MAX_ROWS} rows.`);

  const transactions: ParsedTransaction[] = [];
  const warnings: string[] = [];
  rows.slice(1).forEach((row, index) => {
    const txnDate = parseDate(row[cols.date] ?? '');
    const description = (row[cols.description] ?? '').trim();
    let amountCents: number | null;
    if (cols.amount >= 0) {
      amountCents = parseMoneyToCents(row[cols.amount] ?? '');
    } else {
      const debit = row[cols.debit] ? parseMoneyToCents(row[cols.debit]!) : 0;
      const credit = cols.credit >= 0 && row[cols.credit] ? parseMoneyToCents(row[cols.credit]!) : 0;
      amountCents = debit === null || credit === null ? null : Math.abs(debit) - Math.abs(credit);
    }
    if (!txnDate || !description || amountCents === null || amountCents === 0) {
      warnings.push(`Skipped CSV row ${index + 2}: not a transaction.`);
      return;
    }
    const bankCategory = cols.category >= 0 ? row[cols.category]?.trim() : undefined;
    transactions.push({
      txnDate,
      description,
      amountCents,
      type: classify(description, amountCents),
      ...(bankCategory ? { bankCategory } : {}),
    });
  });

  if (transactions.length === 0) throw new ParseError('No transactions were found in this CSV.');
  const dates = transactions.map((t) => t.txnDate).sort();
  warnings.push('CSV exports carry no printed totals, so these rows could not be verified against the bank.');
  return {
    docType: 'statement',
    kind: 'generic-csv',
    institution: 'Imported CSV',
    accountName: 'CSV import',
    accountType: 'credit',
    periodStart: dates[0]!,
    periodEnd: dates.at(-1)!,
    transactions,
    checks: [],
    warnings,
  };
}
