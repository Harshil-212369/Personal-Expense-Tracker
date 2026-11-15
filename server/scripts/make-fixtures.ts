/**
 * Regenerates the committed test fixtures from the seeded generator:
 *
 *   npm run fixtures -w server
 *
 * Output is deterministic, so a diff in these files means the generator or
 * the layout changed on purpose.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateStatements, renderCibcCsv, renderGenericCsv, renderReceiptEmail, renderStatementPdf } from './synthetic.ts';

const outDir = path.join(import.meta.dirname, '../test/fixtures/synthetic');
mkdirSync(outDir, { recursive: true });

const statements = generateStatements({ months: 2 });
const [september, october] = statements as [(typeof statements)[number], (typeof statements)[number]];

writeFileSync(path.join(outDir, 'statement-2026-09.pdf'), await renderStatementPdf(september));
writeFileSync(path.join(outDir, 'statement-2026-10.pdf'), await renderStatementPdf(october));
writeFileSync(path.join(outDir, 'cibc-export-2026-10.csv'), renderCibcCsv(october));
writeFileSync(path.join(outDir, 'generic-2026-10.csv'), renderGenericCsv(october));
writeFileSync(path.join(outDir, 'metro-receipt.eml'), renderReceiptEmail(october.receipts[0]!));

// Ground truth for the tests, so assertions do not hard-code generated numbers.
const truth = (s: (typeof statements)[number]) => ({
  periodStart: s.periodStart,
  periodEnd: s.periodEnd,
  cardLast4: s.cardLast4,
  chargeCount: s.charges.length,
  paymentCount: s.payments.length,
  purchasesCents: s.charges.filter((c) => c.amountCents > 0).reduce((sum, c) => sum + c.amountCents, 0),
  creditsCents: -s.charges.filter((c) => c.amountCents < 0).reduce((sum, c) => sum + c.amountCents, 0),
  paymentsCents: s.payments.reduce((sum, p) => sum + p.amountCents, 0),
});
const receipt = october.receipts[0]!;
writeFileSync(
  path.join(outDir, 'expected.json'),
  JSON.stringify(
    {
      september: truth(september),
      october: truth(october),
      receipt: {
        purchasedOn: receipt.purchasedOn,
        time: receipt.time,
        itemCount: receipt.lines.length,
        subtotalCents: receipt.subtotalCents,
        taxCents: receipt.taxCents,
        totalCents: receipt.totalCents,
        savingsCents: receipt.savingsCents,
        cardLast4: receipt.cardLast4,
        firstItem: receipt.lines[0]!.name,
      },
    },
    null,
    2,
  ) + '\n',
);
console.log(`Wrote synthetic fixtures to ${path.relative(process.cwd(), outDir)}`);
