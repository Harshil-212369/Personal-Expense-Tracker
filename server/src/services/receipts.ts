import type { Receipt, ReceiptItem } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { addDays, daysBetween } from '../lib/dates.ts';
import { notFound } from '../lib/errors.ts';
import { merchantKey } from '../lib/merchant.ts';

const SELECT = `
  SELECT r.id, r.merchant, r.store_ref AS storeRef, r.purchased_on AS purchasedOn,
         r.purchased_time AS purchasedTime, r.subtotal_cents AS subtotalCents, r.tax_cents AS taxCents,
         r.total_cents AS totalCents, r.savings_cents AS savingsCents, r.payment_method AS paymentMethod,
         r.item_count AS itemCount, r.arithmetic_ok AS arithmeticOk, r.card_last4 AS cardLast4,
         (SELECT t.id FROM transactions t WHERE t.receipt_id = r.id) AS transactionId
  FROM receipts r`;

function toReceipt(row: Record<string, unknown>): Receipt {
  return {
    id: Number(row['id']),
    merchant: String(row['merchant']),
    storeRef: (row['storeRef'] as string | null) ?? null,
    purchasedOn: String(row['purchasedOn']),
    purchasedTime: (row['purchasedTime'] as string | null) ?? null,
    subtotalCents: Number(row['subtotalCents']),
    taxCents: Number(row['taxCents']),
    totalCents: Number(row['totalCents']),
    savingsCents: Number(row['savingsCents']),
    paymentMethod: (row['paymentMethod'] as string | null) ?? null,
    itemCount: Number(row['itemCount']),
    arithmeticOk: row['arithmeticOk'] === 1,
    transactionId: row['transactionId'] === null ? null : Number(row['transactionId']),
  };
}

export function listReceipts(db: Db): Receipt[] {
  return db.prepare(`${SELECT} ORDER BY r.purchased_on DESC, r.id DESC`).all().map(toReceipt);
}

export function getReceipt(db: Db, id: number): Receipt {
  const row = db.prepare(`${SELECT} WHERE r.id = ?`).get(id);
  if (!row) throw notFound(`Receipt ${id}`);
  const items = db
    .prepare(
      `SELECT id, department, name, quantity, unit, unit_price_cents AS unitPriceCents,
              total_cents AS totalCents, saving_cents AS savingCents, taxable
       FROM receipt_items WHERE receipt_id = ? ORDER BY position`,
    )
    .all(id)
    .map((item) => ({ ...item, taxable: item['taxable'] === 1 })) as unknown as ReceiptItem[];
  return { ...toReceipt(row), items };
}

export function deleteReceipt(db: Db, id: number): void {
  const result = db.prepare('DELETE FROM receipts WHERE id = ?').run(id);
  if (result.changes === 0) throw notFound(`Receipt ${id}`);
}

/**
 * Links each unlinked receipt to the statement line it explains.
 *
 * A match needs the exact amount (to the cent), the same merchant, and a
 * transaction date from one day before to three days after the purchase
 * (card networks post late, rarely early). If the receipt names a card and the
 * account has one on file, the last four digits must agree. When several lines
 * qualify, the closest date wins. Runs after every import, in either order:
 * receipt first or statement first.
 */
export function linkReceipts(db: Db): number {
  const receipts = db
    .prepare(
      `SELECT r.id, r.merchant, r.purchased_on AS purchasedOn, r.total_cents AS totalCents, r.card_last4 AS cardLast4
       FROM receipts r WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.receipt_id = r.id)`,
    )
    .all();
  const candidates = db.prepare(
    `SELECT t.id, t.txn_date AS txnDate, t.merchant, t.description, a.last4
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.receipt_id IS NULL AND t.type = 'purchase' AND t.amount_cents = ? AND t.txn_date BETWEEN ? AND ?`,
  );
  const link = db.prepare('UPDATE transactions SET receipt_id = ? WHERE id = ? AND receipt_id IS NULL');

  let linked = 0;
  for (const receipt of receipts) {
    const purchasedOn = String(receipt['purchasedOn']);
    const key = merchantKey(String(receipt['merchant']));
    const matches = candidates
      .all(Number(receipt['totalCents']), addDays(purchasedOn, -1), addDays(purchasedOn, 3))
      .filter((t) => {
        const sameMerchant =
          merchantKey(String(t['merchant'])).includes(key) || merchantKey(String(t['description'])).includes(key);
        const cardConflict = receipt['cardLast4'] && t['last4'] && receipt['cardLast4'] !== t['last4'];
        return sameMerchant && !cardConflict;
      })
      .sort(
        (a, b) =>
          Math.abs(daysBetween(purchasedOn, String(a['txnDate']))) - Math.abs(daysBetween(purchasedOn, String(b['txnDate']))),
      );
    const best = matches[0];
    if (best && link.run(Number(receipt['id']), Number(best['id'])).changes > 0) linked++;
  }
  return linked;
}
