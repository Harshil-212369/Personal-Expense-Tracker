import type { Db } from '../db/database.ts';
import { normalizeMerchant } from '../lib/merchant.ts';
import type { TransactionType } from '../parsers/types.ts';

export type CategorySource = 'manual' | 'rule' | 'ai' | 'bank' | 'default';

export interface CategoryDecision {
  categoryId: number;
  categoryName: string;
  source: CategorySource;
}

/**
 * How the issuing bank's own spend categories map onto ours. Banks categorize
 * by where the terminal is registered, not what was bought, so this is the
 * weakest signal and only used when no rule matches. Ambiguous bank categories
 * are deliberately left out and fall through to "Uncategorized".
 */
const BANK_CATEGORY_MAP: Record<string, string> = {
  restaurants: 'Dining & Coffee',
  'retail and grocery': 'Groceries',
  transportation: 'Transportation',
  'home and office improvement': 'Shopping',
  'hotel, entertainment and recreation': 'Entertainment',
  'professional and financial services': 'Other',
};

const TYPE_CATEGORY: Partial<Record<TransactionType, string>> = {
  payment: 'Card Payments',
  credit: 'Rewards & Credits',
  fee: 'Fees & Interest',
  interest: 'Fees & Interest',
};

interface CompiledRule {
  needle: string;
  categoryId: number;
  source: 'user' | 'ai' | 'seed';
}

export interface Categorizer {
  decide(description: string, type: TransactionType, bankCategory?: string | null): CategoryDecision;
  categoryId(name: string): number;
}

/**
 * Precedence, strongest first:
 *   1. the transaction type (a card payment is never "Groceries")
 *   2. rules: user > AI-suggested > built-in, longest pattern winning ties
 *   3. the bank's own category
 *   4. Uncategorized
 * A category a person set by hand is never passed through here again.
 */
export function buildCategorizer(db: Db): Categorizer {
  const byName = new Map<string, number>();
  const nameById = new Map<number, string>();
  for (const row of db.prepare('SELECT id, name FROM categories').all()) {
    byName.set(String(row['name']).toLowerCase(), Number(row['id']));
    nameById.set(Number(row['id']), String(row['name']));
  }
  const categoryId = (name: string): number => {
    const id = byName.get(name.toLowerCase());
    if (id === undefined) throw new Error(`Missing system category "${name}"`);
    return id;
  };

  const rules: CompiledRule[] = db
    .prepare('SELECT pattern, category_id, source FROM rules ORDER BY priority DESC, length(pattern) DESC, id ASC')
    .all()
    .map((row) => ({
      needle: String(row['pattern']).toUpperCase(),
      categoryId: Number(row['category_id']),
      source: row['source'] as CompiledRule['source'],
    }));

  const decision = (id: number, source: CategorySource): CategoryDecision => ({
    categoryId: id,
    categoryName: nameById.get(id) ?? 'Uncategorized',
    source,
  });

  return {
    categoryId,
    decide(description, type, bankCategory) {
      const typeCategory = TYPE_CATEGORY[type];
      if (typeCategory) return decision(categoryId(typeCategory), 'default');

      // Match against the raw text and the cleaned merchant name, so a rule
      // written either way ("TIM HORTONS" or "Tim Hortons") finds its target.
      const haystack = `${description} | ${normalizeMerchant(description)}`.toUpperCase();
      const rule = rules.find((r) => haystack.includes(r.needle));
      if (rule) return decision(rule.categoryId, rule.source === 'ai' ? 'ai' : 'rule');

      const mapped = bankCategory ? BANK_CATEGORY_MAP[bankCategory.trim().toLowerCase()] : undefined;
      if (mapped) return decision(categoryId(mapped), 'bank');

      return decision(categoryId('Uncategorized'), 'default');
    },
  };
}

/**
 * Re-applies the current rules to every transaction a person has not
 * categorized by hand. Returns how many rows changed.
 */
export function recategorizeAll(db: Db): number {
  const categorizer = buildCategorizer(db);
  const rows = db
    .prepare(
      `SELECT id, description, type, bank_category, category_id, category_source
       FROM transactions WHERE category_source <> 'manual'`,
    )
    .all();
  const update = db.prepare(
    `UPDATE transactions SET category_id = ?, category_source = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  let changed = 0;
  for (const row of rows) {
    const next = categorizer.decide(
      String(row['description']),
      row['type'] as TransactionType,
      row['bank_category'] as string | null,
    );
    if (next.categoryId !== Number(row['category_id']) || next.source !== row['category_source']) {
      update.run(next.categoryId, next.source, Number(row['id']));
      changed++;
    }
  }
  return changed;
}
