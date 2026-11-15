import path from 'node:path';
import type { AiGateway, AiStatement } from '../ai/gateway.ts';
import { minimizeForModel } from '../ai/redact.ts';
import type { CheckResult, ImportPreviewRow, ImportRecord, ImportResult } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { transaction } from '../db/database.ts';
import { isIsoDate } from '../lib/dates.ts';
import { notFound, serviceUnavailable, unprocessable } from '../lib/errors.ts';
import { sha256Hex } from '../lib/hash.ts';
import { merchantKey, normalizeMerchant } from '../lib/merchant.ts';
import { decimalToCents, sumCents } from '../lib/money.ts';
import { parseDocument, ParseError, rowsToText, UnknownLayoutError } from '../parsers/index.ts';
import { extractPdfRows, isPdf } from '../parsers/pdfText.ts';
import { check } from '../parsers/types.ts';
import type { ParsedDocument, ParsedReceipt, ParsedStatement, ParsedTransaction } from '../parsers/types.ts';
import { buildCategorizer } from './categorizer.ts';
import { linkReceipts } from './receipts.ts';

export interface ImportDeps {
  db: Db;
  ai: AiGateway | null;
  redactTerms: readonly string[];
}

export interface ImportRequest {
  bytes: Uint8Array;
  filename: string;
  dryRun?: boolean;
  /** 'ai' sends minimized, redacted text to the model instead of using a built-in parser. */
  parser?: 'auto' | 'ai';
}

const PREVIEW_LIMIT = 500;

/** Keeps a display name only: no directories, no control characters. */
function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(name.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'upload').slice(0, 120);
}

/**
 * Stable identity for a transaction across files. Two purchases can share a
 * date, amount and merchant (two transit fares on one day), so the nth
 * identical row gets n in its fingerprint and both are kept, while the same
 * row seen again in an overlapping export is recognized as a duplicate.
 */
function fingerprints(statement: ParsedStatement): string[] {
  const seen = new Map<string, number>();
  return statement.transactions.map((t) => {
    const base = [
      statement.institution,
      statement.accountLast4 ?? '',
      t.txnDate,
      t.amountCents,
      // A short prefix only: a PDF statement prints "PIZZA CORNER" while the
      // CSV export of the same line appends the city, and both must agree.
      merchantKey(t.description).slice(0, 5),
    ].join('|');
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return sha256Hex(`${base}|${occurrence}`);
  });
}

function receiptFingerprint(receipt: ParsedReceipt): string {
  return sha256Hex(
    ['receipt', receipt.merchant, receipt.storeRef ?? '', receipt.purchasedOn, receipt.purchasedTime ?? '', receipt.totalCents].join('|'),
  );
}

/** Validates the model's extraction and converts it into the same shape the built-in parsers produce. */
function statementFromAi(ai: AiStatement): ParsedStatement {
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];
  for (const row of ai.transactions) {
    const amountCents = decimalToCents(row.amount);
    if (!isIsoDate(row.date) || !row.description.trim() || amountCents === 0 || Math.abs(amountCents) > 100_000_000) {
      warnings.push('Dropped a row the AI reader returned with an invalid date, description or amount.');
      continue;
    }
    // Trust the sign of the number over the label: a "purchase" with a
    // negative amount is a refund, whatever the model called it.
    let type = row.kind;
    if (type === 'purchase' && amountCents < 0) type = 'refund';
    if ((type === 'refund' || type === 'credit') && amountCents > 0) type = 'purchase';
    transactions.push({
      txnDate: row.date,
      description: row.description.trim().slice(0, 200),
      amountCents: type === 'payment' ? -Math.abs(amountCents) : amountCents,
      type,
    });
  }
  if (transactions.length === 0) throw new ParseError('The AI reader found no transactions in this document.');

  const charges = transactions.filter((t) => t.type !== 'payment');
  const positive = sumCents(charges.filter((t) => t.amountCents > 0).map((t) => t.amountCents));
  const negative = Math.abs(sumCents(charges.filter((t) => t.amountCents < 0).map((t) => t.amountCents)));
  const payments = Math.abs(sumCents(transactions.filter((t) => t.type === 'payment').map((t) => t.amountCents)));
  const checks = [];
  const stated = ai.statedTotals;
  if (stated.purchases !== null) checks.push(check('Purchases (printed total)', decimalToCents(Math.abs(stated.purchases)), positive));
  if (stated.credits !== null) checks.push(check('Credits (printed total)', decimalToCents(Math.abs(stated.credits)), negative));
  if (stated.payments !== null) checks.push(check('Payments (printed total)', decimalToCents(Math.abs(stated.payments)), payments));
  for (const c of checks) {
    if (!c.ok) warnings.push(`Reconciliation mismatch on "${c.label}": statement says ${c.expected}, extracted rows give ${c.actual}.`);
  }
  if (checks.length === 0) warnings.push('The document printed no totals, so the AI extraction could not be verified.');

  const last4 = ai.accountLast4 && /^\d{4}$/.test(ai.accountLast4) ? ai.accountLast4 : undefined;
  const dates = transactions.map((t) => t.txnDate).sort();
  return {
    docType: 'statement',
    kind: 'ai-statement',
    institution: ai.institution.trim().slice(0, 60) || 'Unknown',
    accountName: `${ai.institution.trim().slice(0, 60) || 'Imported'} account`,
    accountType: 'credit',
    ...(last4 ? { accountLast4: last4 } : {}),
    periodStart: ai.periodStart && isIsoDate(ai.periodStart) ? ai.periodStart : dates[0]!,
    periodEnd: ai.periodEnd && isIsoDate(ai.periodEnd) ? ai.periodEnd : dates.at(-1)!,
    transactions,
    checks,
    warnings,
  };
}

async function readWithAi(deps: ImportDeps, text: string): Promise<ParsedStatement> {
  if (!deps.ai) {
    throw serviceUnavailable('AI reading is not configured. Set ANTHROPIC_API_KEY to enable it.');
  }
  const minimized = minimizeForModel(text, deps.redactTerms);
  if (!minimized.text.trim()) throw new ParseError('No transaction-like lines were found to send to the AI reader.');
  return statementFromAi(await deps.ai.extractStatement(minimized.text));
}

async function parse(deps: ImportDeps, request: ImportRequest): Promise<{ doc: ParsedDocument; parser: 'deterministic' | 'ai' }> {
  if (request.parser === 'ai') {
    const text = isPdf(request.bytes)
      ? rowsToText(await extractPdfRows(request.bytes))
      : new TextDecoder('utf-8').decode(request.bytes);
    return { doc: await readWithAi(deps, text), parser: 'ai' };
  }
  try {
    return { doc: await parseDocument(request.bytes), parser: 'deterministic' };
  } catch (error) {
    // Unknown layout: fall back to the AI reader only if one is configured.
    if (error instanceof UnknownLayoutError && deps.ai) {
      return { doc: await readWithAi(deps, error.extractedText), parser: 'ai' };
    }
    throw error;
  }
}

function reconciledFlag(checks: CheckResult[]): boolean | null {
  return checks.length === 0 ? null : checks.every((c) => c.ok);
}

function ensureAccount(db: Db, statement: ParsedStatement): number {
  const existing = db
    .prepare("SELECT id FROM accounts WHERE institution = ? AND ifnull(last4, '') = ? AND name = ?")
    .get(statement.institution, statement.accountLast4 ?? '', statement.accountName);
  if (existing) return Number(existing['id']);
  const result = db
    .prepare('INSERT INTO accounts (institution, name, type, last4) VALUES (?, ?, ?, ?)')
    .run(statement.institution, statement.accountName, statement.accountType, statement.accountLast4 ?? null);
  return Number(result.lastInsertRowid);
}

export async function importFile(deps: ImportDeps, request: ImportRequest): Promise<ImportResult> {
  const { db } = deps;
  const filename = safeFilename(request.filename);
  const sha256 = sha256Hex(request.bytes);

  const prior = db.prepare('SELECT id FROM imports WHERE sha256 = ?').get(sha256);
  if (prior) {
    const record = getImport(db, Number(prior['id']));
    return {
      status: 'duplicate',
      importId: record.id,
      docType: record.kind.includes('receipt') ? 'receipt' : 'statement',
      kind: record.kind,
      parser: record.parser,
      filename: record.filename,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
      rowsParsed: record.rowsParsed,
      rowsInserted: 0,
      rowsDuplicate: record.rowsParsed,
      reconciled: record.reconciled,
      checks: record.checks,
      warnings: ['This exact file was already imported; nothing was changed.'],
      receiptsLinked: 0,
      preview: [],
    };
  }

  let parsed;
  try {
    parsed = await parse(deps, request);
  } catch (error) {
    if (error instanceof ParseError) throw unprocessable(error.message);
    throw error;
  }
  const { doc, parser } = parsed;
  const base = {
    docType: doc.docType,
    kind: doc.kind,
    parser,
    filename,
    checks: doc.checks,
    warnings: doc.warnings,
    reconciled: reconciledFlag(doc.checks),
  } as const;

  if (doc.docType === 'receipt') return importReceipt(db, doc, { ...base, sha256, dryRun: request.dryRun ?? false });

  // --- Statement --------------------------------------------------------------
  const categorizer = buildCategorizer(db);
  const prints = fingerprints(doc);
  const exists = db.prepare('SELECT 1 FROM transactions WHERE fingerprint = ?');
  const rows = doc.transactions.map((t, i) => {
    const decision = categorizer.decide(t.description, t.type, t.bankCategory);
    return { t, fingerprint: prints[i]!, decision, duplicate: Boolean(exists.get(prints[i]!)) };
  });
  const preview: ImportPreviewRow[] = rows.slice(0, PREVIEW_LIMIT).map(({ t, decision, duplicate }) => ({
    txnDate: t.txnDate,
    description: t.description,
    merchant: normalizeMerchant(t.description),
    amountCents: t.amountCents,
    type: t.type,
    categoryName: decision.categoryName,
    duplicate,
  }));
  const duplicates = rows.filter((r) => r.duplicate).length;
  const summary = {
    ...base,
    periodStart: doc.periodStart ?? null,
    periodEnd: doc.periodEnd ?? null,
    rowsParsed: rows.length,
    rowsDuplicate: duplicates,
    preview,
  };

  if (request.dryRun) {
    return { ...summary, status: 'preview', importId: null, rowsInserted: rows.length - duplicates, receiptsLinked: 0 };
  }

  return transaction(db, () => {
    const accountId = ensureAccount(db, doc);
    const importId = Number(
      db
        .prepare(
          `INSERT INTO imports (sha256, filename, kind, parser, account_id, period_start, period_end,
                                rows_parsed, rows_inserted, rows_duplicate, reconciled, checks_json, warnings_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sha256, filename, doc.kind, parser, accountId, doc.periodStart ?? null, doc.periodEnd ?? null,
          rows.length, rows.length - duplicates, duplicates,
          base.reconciled ? 1 : 0, JSON.stringify(doc.checks), JSON.stringify(doc.warnings),
        ).lastInsertRowid,
    );
    const insert = db.prepare(
      `INSERT INTO transactions (import_id, account_id, txn_date, post_date, description, merchant, location,
                                 amount_cents, type, category_id, category_source, bank_category, notes, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { t, fingerprint, decision, duplicate } of rows) {
      if (duplicate) continue;
      insert.run(
        importId, accountId, t.txnDate, t.postDate ?? null, t.description, normalizeMerchant(t.description),
        t.location ?? null, t.amountCents, t.type, decision.categoryId, decision.source,
        t.bankCategory ?? null, t.notes ?? null, fingerprint,
      );
    }
    const receiptsLinked = linkReceipts(db);
    return { ...summary, status: 'imported' as const, importId, rowsInserted: rows.length - duplicates, receiptsLinked };
  });
}

function importReceipt(
  db: Db,
  receipt: ParsedReceipt,
  ctx: Pick<ImportResult, 'docType' | 'kind' | 'parser' | 'filename' | 'checks' | 'warnings' | 'reconciled'> & { sha256: string; dryRun: boolean },
): ImportResult {
  const fingerprint = receiptFingerprint(receipt);
  const duplicate = Boolean(db.prepare('SELECT 1 FROM receipts WHERE fingerprint = ?').get(fingerprint));
  const { sha256, dryRun, ...shared } = ctx;
  const summary = {
    ...shared,
    periodStart: receipt.purchasedOn,
    periodEnd: receipt.purchasedOn,
    rowsParsed: receipt.items.length,
    rowsDuplicate: duplicate ? receipt.items.length : 0,
    preview: receipt.items.slice(0, PREVIEW_LIMIT).map((item) => ({
      txnDate: receipt.purchasedOn,
      description: item.name,
      merchant: receipt.merchant,
      amountCents: item.totalCents,
      type: 'purchase' as const,
      categoryName: item.department ?? 'Receipt item',
      duplicate,
    })),
  };
  const rowsInserted = duplicate ? 0 : receipt.items.length;
  if (dryRun) return { ...summary, status: 'preview', importId: null, rowsInserted, receiptsLinked: 0 };

  return transaction(db, () => {
    const importId = Number(
      db
        .prepare(
          `INSERT INTO imports (sha256, filename, kind, parser, period_start, period_end, rows_parsed,
                                rows_inserted, rows_duplicate, reconciled, checks_json, warnings_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sha256, shared.filename, receipt.kind, shared.parser, receipt.purchasedOn, receipt.purchasedOn,
          receipt.items.length, rowsInserted, summary.rowsDuplicate,
          shared.reconciled ? 1 : 0, JSON.stringify(receipt.checks), JSON.stringify(receipt.warnings),
        ).lastInsertRowid,
    );
    if (!duplicate) {
      const receiptId = Number(
        db
          .prepare(
            `INSERT INTO receipts (import_id, merchant, store_ref, purchased_on, purchased_time, subtotal_cents, tax_cents,
                                   total_cents, savings_cents, payment_method, card_last4, item_count, arithmetic_ok, fingerprint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            importId, receipt.merchant, receipt.storeRef ?? null, receipt.purchasedOn, receipt.purchasedTime ?? null,
            receipt.subtotalCents, receipt.taxCents, receipt.totalCents, receipt.savingsCents,
            receipt.paymentMethod ?? null, receipt.cardLast4 ?? null, receipt.items.length,
            receipt.checks.every((c) => c.ok) ? 1 : 0, fingerprint,
          ).lastInsertRowid,
      );
      const insertItem = db.prepare(
        `INSERT INTO receipt_items (receipt_id, position, department, name, quantity, unit, unit_price_cents, total_cents, saving_cents, taxable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      receipt.items.forEach((item, position) => {
        insertItem.run(
          receiptId, position, item.department ?? null, item.name, item.quantity ?? null, item.unit ?? null,
          item.unitPriceCents ?? null, item.totalCents, item.savingCents, item.taxable ? 1 : 0,
        );
      });
    }
    const receiptsLinked = linkReceipts(db);
    return { ...summary, status: 'imported' as const, importId, rowsInserted, receiptsLinked };
  });
}

// --- Import history -----------------------------------------------------------

function toRecord(row: Record<string, unknown>): ImportRecord {
  const checks = JSON.parse(String(row['checks_json'])) as CheckResult[];
  return {
    id: Number(row['id']),
    filename: String(row['filename']),
    kind: String(row['kind']),
    parser: row['parser'] as ImportRecord['parser'],
    periodStart: (row['period_start'] as string | null) ?? null,
    periodEnd: (row['period_end'] as string | null) ?? null,
    rowsParsed: Number(row['rows_parsed']),
    rowsInserted: Number(row['rows_inserted']),
    rowsDuplicate: Number(row['rows_duplicate']),
    reconciled: reconciledFlag(checks),
    checks,
    warnings: JSON.parse(String(row['warnings_json'])) as string[],
    importedAt: String(row['imported_at']),
  };
}

export function listImports(db: Db): ImportRecord[] {
  return db.prepare('SELECT * FROM imports ORDER BY imported_at DESC, id DESC').all().map(toRecord);
}

export function getImport(db: Db, id: number): ImportRecord {
  const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
  if (!row) throw notFound(`Import ${id}`);
  return toRecord(row);
}

/** Rolls an import back: its transactions and receipts are removed with it. */
export function deleteImport(db: Db, id: number): void {
  const result = db.prepare('DELETE FROM imports WHERE id = ?').run(id);
  if (result.changes === 0) throw notFound(`Import ${id}`);
}
