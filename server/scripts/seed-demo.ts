/**
 * Builds a demo database from synthetic statements and receipts:
 *
 *   npm run seed:demo
 *
 * Six months of invented spending go through the same import pipeline as real
 * files (PDF parsing, reconciliation, categorization, receipt linking), so the
 * demo exercises the real code path. Writes to DEMO_DATABASE_PATH or
 * <repo>/data/demo.db and replaces whatever was there. Your real database
 * (data/ledgerlens.db) is never touched.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/database.ts';
import { importFile } from '../src/services/importer.ts';
import { generateStatements, renderReceiptEmail, renderStatementPdf } from './synthetic.ts';

export const DEMO_DATABASE = path.resolve(process.env['DEMO_DATABASE_PATH'] ?? path.join(import.meta.dirname, '../../data/demo.db'));
const target = DEMO_DATABASE;
for (const suffix of ['', '-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });

const db = openDatabase(target);
const deps = { db, ai: null, redactTerms: [] };
const statements = generateStatements({ months: 6, receiptsForLast: 3 });

let transactions = 0;
let receipts = 0;
for (const statement of statements) {
  const result = await importFile(deps, {
    bytes: await renderStatementPdf(statement),
    filename: `synthetic-statement-${statement.periodEnd.slice(0, 7)}.pdf`,
  });
  if (!result.reconciled) throw new Error(`Synthetic statement ${statement.periodEnd} did not reconcile`);
  transactions += result.rowsInserted;
  for (const receipt of statement.receipts) {
    await importFile(deps, {
      bytes: new TextEncoder().encode(renderReceiptEmail(receipt)),
      filename: `synthetic-receipt-${receipt.purchasedOn}.eml`,
    });
    receipts++;
  }
}
const linked = Number(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE receipt_id IS NOT NULL').get()?.['n']);
db.close();
console.log(`Demo database ready at ${path.relative(process.cwd(), target)}`);
console.log(`  ${statements.length} statements, ${transactions} transactions, ${receipts} receipts (${linked} linked to a statement line)`);
