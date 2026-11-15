import type { Category, Rule } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { transaction } from '../db/database.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { recategorizeAll } from './categorizer.ts';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

// --- Categories -------------------------------------------------------------

export function listCategories(db: Db): Category[] {
  return db
    .prepare(
      `SELECT c.id, c.name, c.kind, c.is_system AS isSystem, COUNT(t.id) AS transactionCount
       FROM categories c LEFT JOIN transactions t ON t.category_id = c.id
       GROUP BY c.id ORDER BY c.kind, c.name COLLATE NOCASE`,
    )
    .all()
    .map((row) => ({
      id: Number(row['id']),
      name: String(row['name']),
      kind: row['kind'] as Category['kind'],
      isSystem: row['isSystem'] === 1,
      transactionCount: Number(row['transactionCount']),
    }));
}

function getCategory(db: Db, id: number): Category {
  const found = listCategories(db).find((c) => c.id === id);
  if (!found) throw notFound(`Category ${id}`);
  return found;
}

export function createCategory(db: Db, name: string): Category {
  try {
    const result = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    return getCategory(db, Number(result.lastInsertRowid));
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`A category named "${name}" already exists.`);
    throw error;
  }
}

export function renameCategory(db: Db, id: number, name: string): Category {
  const existing = getCategory(db, id);
  if (existing.isSystem) throw unprocessable('Built-in categories cannot be renamed.');
  try {
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`A category named "${name}" already exists.`);
    throw error;
  }
  return getCategory(db, id);
}

/** Deletes a custom category; its transactions fall back to whatever the rules now say. */
export function deleteCategory(db: Db, id: number): void {
  const existing = getCategory(db, id);
  if (existing.isSystem) throw unprocessable('Built-in categories cannot be deleted.');
  transaction(db, () => {
    const uncategorized = db.prepare("SELECT id FROM categories WHERE name = 'Uncategorized'").get();
    db.prepare("UPDATE transactions SET category_id = ?, category_source = 'default' WHERE category_id = ?").run(
      Number(uncategorized!['id']),
      id,
    );
    db.prepare('DELETE FROM categories WHERE id = ?').run(id); // rules cascade
    recategorizeAll(db);
  });
}

// --- Rules ------------------------------------------------------------------

const RULE_PRIORITY = { user: 300, ai: 200, seed: 100 } as const;

export function listRules(db: Db): Rule[] {
  return db
    .prepare(
      `SELECT r.id, r.pattern, r.category_id AS categoryId, c.name AS categoryName, r.source, r.priority
       FROM rules r JOIN categories c ON c.id = r.category_id
       ORDER BY r.priority DESC, r.pattern COLLATE NOCASE`,
    )
    .all() as unknown as Rule[];
}

/**
 * Adds (or re-points) a rule and immediately re-applies the rule set, so one
 * correction fixes every past and future transaction from that merchant.
 */
export function upsertRule(
  db: Db,
  input: { pattern: string; categoryId: number; source?: keyof typeof RULE_PRIORITY },
): { rule: Rule; recategorized: number } {
  const source = input.source ?? 'user';
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(input.categoryId)) {
    throw unprocessable(`Category ${input.categoryId} does not exist.`);
  }
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO rules (pattern, category_id, source, priority) VALUES (?, ?, ?, ?)
       ON CONFLICT (pattern, source) DO UPDATE SET category_id = excluded.category_id`,
    ).run(input.pattern, input.categoryId, source, RULE_PRIORITY[source]);
    const recategorized = recategorizeAll(db);
    const rule = listRules(db).find((r) => r.pattern.toLowerCase() === input.pattern.toLowerCase() && r.source === source)!;
    return { rule, recategorized };
  });
}

export function deleteRule(db: Db, id: number): { recategorized: number } {
  return transaction(db, () => {
    const result = db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    if (result.changes === 0) throw notFound(`Rule ${id}`);
    return { recategorized: recategorizeAll(db) };
  });
}
