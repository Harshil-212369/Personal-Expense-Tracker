import type { z } from 'zod';
import type { Page, Transaction, TransactionCreateSchema, TransactionQuerySchema, TransactionUpdateSchema } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { notFound, unprocessable } from '../lib/errors.ts';
import { sha256Hex } from '../lib/hash.ts';
import { normalizeMerchant } from '../lib/merchant.ts';
import { buildCategorizer } from './categorizer.ts';

type Query = z.infer<typeof TransactionQuerySchema>;
type CreateInput = z.infer<typeof TransactionCreateSchema>;
type UpdateInput = z.infer<typeof TransactionUpdateSchema>;
type SqlValue = string | number | null;

const SELECT = `
  SELECT t.id, t.txn_date AS txnDate, t.post_date AS postDate, t.description, t.merchant,
         t.location, t.amount_cents AS amountCents, t.type, t.category_id AS categoryId,
         c.name AS categoryName, t.category_source AS categorySource,
         t.bank_category AS bankCategory, t.notes, t.receipt_id AS receiptId,
         t.import_id AS importId, t.account_id AS accountId
  FROM transactions t JOIN categories c ON c.id = t.category_id`;

// Sort keys are a fixed whitelist: user input never reaches the SQL text.
const SORT_COLUMNS = {
  date: 't.txn_date',
  amount: 't.amount_cents',
  merchant: 't.merchant COLLATE NOCASE',
} as const;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function listTransactions(db: Db, query: Query): Page<Transaction> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (clause: string, ...values: SqlValue[]) => {
    where.push(clause);
    params.push(...values);
  };

  if (query.from) add('t.txn_date >= ?', query.from);
  if (query.to) add('t.txn_date <= ?', query.to);
  if (query.categoryId) add('t.category_id = ?', query.categoryId);
  if (query.type) add('t.type = ?', query.type);
  if (query.importId) add('t.import_id = ?', query.importId);
  if (query.minCents !== undefined) add('t.amount_cents >= ?', query.minCents);
  if (query.maxCents !== undefined) add('t.amount_cents <= ?', query.maxCents);
  if (query.hasReceipt !== undefined) add(query.hasReceipt ? 't.receipt_id IS NOT NULL' : 't.receipt_id IS NULL');
  if (query.q) {
    const like = `%${escapeLike(query.q)}%`;
    add(`(t.description LIKE ? ESCAPE '\\' OR t.merchant LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')`, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${whereSql}`).get(...params)?.['n'] ?? 0,
  );
  const items = db
    .prepare(`${SELECT} ${whereSql} ORDER BY ${SORT_COLUMNS[query.sort]} ${direction}, t.id ${direction} LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset) as unknown as Transaction[];

  return { items, total, limit: query.limit, offset: query.offset };
}

export function getTransaction(db: Db, id: number): Transaction {
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as unknown as Transaction | undefined;
  if (!row) throw notFound(`Transaction ${id}`);
  return row;
}

function assertCategoryExists(db: Db, categoryId: number): void {
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) {
    throw unprocessable(`Category ${categoryId} does not exist.`);
  }
}

export function createTransaction(db: Db, input: CreateInput): Transaction {
  const categorizer = buildCategorizer(db);
  let categoryId: number;
  let source: string;
  if (input.categoryId !== undefined) {
    assertCategoryExists(db, input.categoryId);
    categoryId = input.categoryId;
    source = 'manual';
  } else {
    const decided = categorizer.decide(input.description, input.type, null);
    categoryId = decided.categoryId;
    source = decided.source;
  }

  // Manual entries are unique by construction: the fingerprint includes a
  // timestamp, so entering the same coffee twice records two coffees.
  const fingerprint = sha256Hex(`manual|${input.txnDate}|${input.amountCents}|${input.description}|${Date.now()}|${Math.random()}`);
  const result = db
    .prepare(
      `INSERT INTO transactions (txn_date, description, merchant, amount_cents, type, category_id, category_source, notes, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.txnDate,
      input.description,
      normalizeMerchant(input.description),
      input.amountCents,
      input.type,
      categoryId,
      source,
      input.notes ?? null,
      fingerprint,
    );
  return getTransaction(db, Number(result.lastInsertRowid));
}

export function updateTransaction(db: Db, id: number, input: UpdateInput): Transaction {
  getTransaction(db, id);
  const sets: string[] = [];
  const params: SqlValue[] = [];

  if (input.categoryId !== undefined) {
    assertCategoryExists(db, input.categoryId);
    // A category set through the API is a human decision and is never
    // overwritten by a later rules pass.
    sets.push('category_id = ?', "category_source = 'manual'");
    params.push(input.categoryId);
  }
  if (input.description !== undefined) {
    sets.push('description = ?', 'merchant = ?');
    params.push(input.description, normalizeMerchant(input.description));
  }
  if (input.txnDate !== undefined) { sets.push('txn_date = ?'); params.push(input.txnDate); }
  if (input.amountCents !== undefined) { sets.push('amount_cents = ?'); params.push(input.amountCents); }
  if (input.notes !== undefined) { sets.push('notes = ?'); params.push(input.notes); }

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return getTransaction(db, id);
}

export function deleteTransaction(db: Db, id: number): void {
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  if (result.changes === 0) throw notFound(`Transaction ${id}`);
}
