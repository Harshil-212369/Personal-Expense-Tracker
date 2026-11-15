import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import type { Db } from '../src/db/database.ts';
import { migrate, transaction } from '../src/db/database.ts';
import { HttpError } from '../src/lib/errors.ts';
import { recategorizeAll } from '../src/services/categorizer.ts';
import { upsertRule } from '../src/services/categories.ts';
import { deleteImport, importFile, listImports } from '../src/services/importer.ts';
import type { ImportDeps } from '../src/services/importer.ts';
import { listReceipts } from '../src/services/receipts.ts';
import { expected, fixture } from './helpers.ts';

let db: Db;
let deps: ImportDeps;
const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!['n']);
const load = (name: string, options: { dryRun?: boolean } = {}) => importFile(deps, { bytes: fixture(name), filename: name, ...options });

beforeEach(() => {
  db = openDatabase(':memory:');
  deps = { db, ai: null, redactTerms: [] };
});

describe('database', () => {
  it('applies migrations once and seeds the reference data', () => {
    assert.deepEqual(migrate(db), [], 'a second migrate run should have nothing to do');
    assert.ok(count('categories') >= 15);
    assert.ok(count('rules') > 50);
  });

  it('rolls back a failed transaction, including nested ones', () => {
    assert.throws(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO categories (name) VALUES ('Temp A')").run();
        transaction(db, () => db.prepare("INSERT INTO categories (name) VALUES ('Temp B')").run());
        throw new Error('boom');
      }),
    );
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM categories WHERE name LIKE 'Temp%'").get()!['n']), 0);

    transaction(db, () => {
      assert.throws(() => transaction(db, () => { db.prepare("INSERT INTO categories (name) VALUES ('Inner')").run(); throw new Error('inner'); }));
      db.prepare("INSERT INTO categories (name) VALUES ('Outer')").run();
    });
    assert.deepEqual(
      db.prepare("SELECT name FROM categories WHERE name IN ('Inner', 'Outer')").all().map((r) => r['name']),
      ['Outer'],
    );
  });

  it('enforces integrity in the schema, not just in code', () => {
    assert.throws(() => db.prepare("INSERT INTO accounts (institution, name, last4) VALUES ('X', 'Y', '4500123412341234')").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO transactions (txn_date, description, merchant, amount_cents, category_id, fingerprint) VALUES ('21/09/2026', 'a', 'a', 1, 1, 'f')").run(), /CHECK/);
  });
});

describe('statement import', () => {
  it('stores every row, categorized, and marks the import reconciled', async () => {
    const result = await load('statement-2026-10.pdf');
    const truth = expected.october;
    assert.equal(result.status, 'imported');
    assert.equal(result.parser, 'deterministic');
    assert.equal(result.reconciled, true);
    assert.equal(result.rowsInserted, truth.chargeCount + truth.paymentCount);
    assert.equal(count('transactions'), truth.chargeCount + truth.paymentCount);

    const spend = db
      .prepare(
        `SELECT SUM(t.amount_cents) AS cents FROM transactions t JOIN categories c ON c.id = t.category_id
         WHERE c.kind = 'expense' AND t.type IN ('purchase', 'refund', 'fee', 'interest')`,
      )
      .get()!;
    assert.equal(Number(spend['cents']), truth.purchasesCents, 'payments and reward credits must not count as spending');

    const uncategorized = Number(
      db.prepare("SELECT COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.name = 'Uncategorized'").get()!['n'],
    );
    assert.ok(uncategorized / count('transactions') < 0.1, `too many uncategorized rows: ${uncategorized}`);
    assert.equal(db.prepare('SELECT last4 FROM accounts').get()!['last4'], truth.cardLast4);
  });

  it('is idempotent: the same file twice changes nothing', async () => {
    await load('statement-2026-10.pdf');
    const before = count('transactions');
    const again = await load('statement-2026-10.pdf');
    assert.equal(again.status, 'duplicate');
    assert.equal(again.rowsInserted, 0);
    assert.equal(count('transactions'), before);
    assert.equal(count('imports'), 1);
  });

  it('recognizes the same transactions arriving in a different file format', async () => {
    await load('statement-2026-10.pdf');
    const before = count('transactions');
    const csv = await load('cibc-export-2026-10.csv');
    assert.equal(csv.status, 'imported');
    assert.equal(csv.rowsInserted, 0, 'every CSV row is already on file from the PDF');
    assert.equal(csv.rowsDuplicate, before);
    assert.equal(count('transactions'), before);
  });

  it('keeps two identical purchases made on the same day', async () => {
    const csv = '2026-03-02,PRESTO FARE TORONTO,3.30,,4500********4242\n2026-03-02,PRESTO FARE TORONTO,3.30,,4500********4242\n';
    const result = await importFile(deps, { bytes: new TextEncoder().encode(csv), filename: 'two-fares.csv' });
    assert.equal(result.rowsInserted, 2);
    assert.equal(result.reconciled, null, 'a CSV prints no totals, so there is nothing to reconcile');
  });

  it('previews without writing anything', async () => {
    const preview = await load('statement-2026-10.pdf', { dryRun: true });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.importId, null);
    assert.equal(preview.preview.length, expected.october.chargeCount + expected.october.paymentCount);
    assert.ok(preview.preview.every((row) => row.categoryName && row.merchant && !row.duplicate));
    assert.equal(count('transactions'), 0);
    assert.equal(count('imports'), 0);
    assert.equal(count('accounts'), 0);
  });

  it('rolls an import back completely', async () => {
    await load('statement-2026-09.pdf');
    const kept = count('transactions');
    const second = await load('statement-2026-10.pdf');
    deleteImport(db, second.importId!);
    assert.equal(count('transactions'), kept);
    assert.deepEqual(listImports(db).map((i) => i.periodEnd), [expected.september.periodEnd]);
    assert.throws(() => deleteImport(db, 9999), HttpError);
  });

  it('stores a safe display name, never a path', async () => {
    const result = await importFile(deps, { bytes: fixture('statement-2026-09.pdf'), filename: 'C:\\Users\\alex\\Documents\\..\\secret\u0000.pdf' });
    assert.equal(result.filename, 'secret.pdf');
  });

  it('turns parser failures into a 422 with a readable reason', async () => {
    await assert.rejects(importFile(deps, { bytes: new TextEncoder().encode('just,some\nwords,here\n'), filename: 'x.csv' }), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 422);
      return true;
    });
    assert.equal(count('imports'), 0);
  });
});

describe('receipt import and linking', () => {
  it('links a receipt to its statement line when the statement arrives first', async () => {
    await load('statement-2026-10.pdf');
    const result = await load('metro-receipt.eml');
    assert.equal(result.docType, 'receipt');
    assert.equal(result.reconciled, true);
    assert.equal(result.receiptsLinked, 1);

    const [receipt] = listReceipts(db);
    assert.ok(receipt!.transactionId);
    const txn = db.prepare('SELECT merchant, amount_cents, txn_date FROM transactions WHERE id = ?').get(receipt!.transactionId!)!;
    assert.equal(txn['merchant'], 'Metro');
    assert.equal(txn['amount_cents'], expected.receipt.totalCents);
    assert.equal(count('receipt_items'), expected.receipt.itemCount);
  });

  it('links when the receipt arrives before the statement', async () => {
    const first = await load('metro-receipt.eml');
    assert.equal(first.receiptsLinked, 0);
    assert.equal(listReceipts(db)[0]!.transactionId, null);
    const second = await load('statement-2026-10.pdf');
    assert.equal(second.receiptsLinked, 1);
    assert.ok(listReceipts(db)[0]!.transactionId);
  });

  it('does not link on amount alone', async () => {
    await load('metro-receipt.eml');
    // Same amount and date, different merchant: must stay unlinked.
    const csv = `${expected.receipt.purchasedOn},CORNER HARDWARE TORONTO,${(expected.receipt.totalCents / 100).toFixed(2)},,4500********4242\n`;
    const result = await importFile(deps, { bytes: new TextEncoder().encode(csv), filename: 'other.csv' });
    assert.equal(result.receiptsLinked, 0);
  });

  it('does not link across different cards', async () => {
    await load('metro-receipt.eml');
    const csv = `${expected.receipt.purchasedOn},METRO 9001 TORONTO,${(expected.receipt.totalCents / 100).toFixed(2)},,4500********9999\n`;
    const result = await importFile(deps, { bytes: new TextEncoder().encode(csv), filename: 'other-card.csv' });
    assert.equal(result.receiptsLinked, 0);
  });

  it('never stores the same receipt twice', async () => {
    await load('metro-receipt.eml');
    const again = await load('metro-receipt.eml');
    assert.equal(again.status, 'duplicate');
    assert.equal(count('receipts'), 1);
  });
});

describe('categorization rules', () => {
  it('lets a user rule beat the built-in rules and the bank category', async () => {
    await load('statement-2026-10.pdf');
    const categoryOf = (like: string) =>
      db.prepare('SELECT c.name, t.category_source AS source FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.description LIKE ? LIMIT 1').get(like)!;

    assert.equal(categoryOf('DOLLARAMA%')['name'], 'Shopping');
    assert.equal(categoryOf('CINEPLEX%')['name'], 'Entertainment');
    assert.equal(categoryOf('PAYMENT THANK YOU%')['name'], 'Card Payments');
    assert.equal(categoryOf('CASHBACK%')['name'], 'Rewards & Credits');
    assert.equal(categoryOf('UBER CANADA/UBEREATS%')['name'], 'Dining & Coffee', 'the longer "UBEREATS" rule must win over "UBER"');

    const giftsId = Number(db.prepare("SELECT id FROM categories WHERE name = 'Gifts & Donations'").get()!['id']);
    const { recategorized } = upsertRule(db, { pattern: 'dollarama', categoryId: giftsId });
    assert.ok(recategorized > 0);
    assert.deepEqual({ ...categoryOf('DOLLARAMA%') }, { name: 'Gifts & Donations', source: 'rule' });
  });

  it('never overrides a category a person set by hand', async () => {
    await load('statement-2026-10.pdf');
    const otherId = Number(db.prepare("SELECT id FROM categories WHERE name = 'Other'").get()!['id']);
    const row = db.prepare("SELECT id FROM transactions WHERE description LIKE 'TIM HORTONS%' LIMIT 1").get()!;
    db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(otherId, Number(row['id']));
    recategorizeAll(db);
    assert.equal(db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(Number(row['id']))!['category_id'], otherId);
  });
});
