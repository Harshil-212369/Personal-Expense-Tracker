import type { AiGateway } from '../ai/gateway.ts';
import type { Db } from '../db/database.ts';
import { transaction } from '../db/database.ts';
import { serviceUnavailable } from '../lib/errors.ts';
import { recategorizeAll } from './categorizer.ts';

const BATCH_LIMIT = 60;

export interface AiCategorizeResult {
  merchantsSent: number;
  rulesCreated: number;
  recategorized: number;
  skippedLowConfidence: number;
}

/**
 * Asks the model to categorize merchants the rules could not, then saves each
 * confident answer as a rule. Two consequences worth the design:
 *   - only merchant names are sent, never amounts or dates
 *   - each merchant costs one model call ever; afterwards the saved rule
 *     answers instantly and offline
 * Low-confidence answers are dropped rather than stored.
 */
export async function categorizeUncategorized(db: Db, ai: AiGateway | null): Promise<AiCategorizeResult> {
  if (!ai) throw serviceUnavailable('AI categorization is not configured. Set ANTHROPIC_API_KEY to enable it.');

  const merchants = db
    .prepare(
      `SELECT t.merchant, COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE c.name = 'Uncategorized' AND t.category_source <> 'manual'
       GROUP BY t.merchant COLLATE NOCASE ORDER BY n DESC LIMIT ?`,
    )
    .all(BATCH_LIMIT)
    .map((row) => String(row['merchant']));
  if (merchants.length === 0) return { merchantsSent: 0, rulesCreated: 0, recategorized: 0, skippedLowConfidence: 0 };

  const categories = db
    .prepare("SELECT id, name FROM categories WHERE kind = 'expense' AND name <> 'Uncategorized' ORDER BY name")
    .all()
    .map((row) => ({ id: Number(row['id']), name: String(row['name']) }));

  const assignments = await ai.categorizeMerchants({ merchants, categories: categories.map((c) => c.name) });

  // The response is untrusted: accept only merchants that were actually sent
  // and categories that actually exist.
  const sent = new Set(merchants.map((m) => m.toLowerCase()));
  const categoryIds = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  let rulesCreated = 0;
  let skippedLowConfidence = 0;

  return transaction(db, () => {
    const insert = db.prepare(
      `INSERT INTO rules (pattern, category_id, source, priority) VALUES (?, ?, 'ai', 200)
       ON CONFLICT (pattern, source) DO UPDATE SET category_id = excluded.category_id`,
    );
    for (const assignment of assignments) {
      const categoryId = categoryIds.get(assignment.category.toLowerCase());
      if (!sent.has(assignment.merchant.toLowerCase()) || categoryId === undefined) continue;
      if (assignment.confidence === 'low' || assignment.merchant.trim().length < 2) {
        skippedLowConfidence++;
        continue;
      }
      insert.run(assignment.merchant.trim(), categoryId);
      rulesCreated++;
    }
    return { merchantsSent: merchants.length, rulesCreated, recategorized: recategorizeAll(db), skippedLowConfidence };
  });
}
