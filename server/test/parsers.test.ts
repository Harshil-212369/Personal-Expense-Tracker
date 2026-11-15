import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDocument, ParseError, UnknownLayoutError } from '../src/parsers/index.ts';
import { htmlToLines, parseMetroReceipt } from '../src/parsers/metroReceiptEmail.ts';
import type { ParsedReceipt, ParsedStatement } from '../src/parsers/types.ts';
import { expected, fixture, unknownLayoutPdf } from './helpers.ts';

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

async function statement(name: string): Promise<ParsedStatement> {
  const doc = await parseDocument(fixture(name));
  assert.equal(doc.docType, 'statement');
  return doc as ParsedStatement;
}

describe('CIBC credit card statement (PDF)', () => {
  it('reads every row and reconciles against every printed total', async () => {
    const doc = await statement('statement-2026-10.pdf');
    const truth = expected.october;

    assert.equal(doc.kind, 'cibc-credit-pdf');
    assert.equal(doc.periodStart, truth.periodStart);
    assert.equal(doc.periodEnd, truth.periodEnd);
    assert.equal(doc.accountLast4, truth.cardLast4);

    const charges = doc.transactions.filter((t) => t.type !== 'payment');
    assert.equal(charges.length, truth.chargeCount);
    assert.equal(sum(charges.filter((t) => t.amountCents > 0).map((t) => t.amountCents)), truth.purchasesCents);
    assert.equal(-sum(charges.filter((t) => t.amountCents < 0).map((t) => t.amountCents)), truth.creditsCents);

    assert.ok(doc.checks.length >= 5, 'expected the printed totals to be checked');
    assert.deepEqual(doc.checks.filter((c) => !c.ok), []);
    assert.deepEqual(doc.warnings, []);
  });

  it('records a card payment as money coming in, not as spending', async () => {
    const doc = await statement('statement-2026-10.pdf');
    const payments = doc.transactions.filter((t) => t.type === 'payment');
    assert.equal(payments.length, expected.october.paymentCount);
    assert.equal(payments[0]!.amountCents, -expected.october.paymentsCents);
    assert.equal(payments[0]!.description, 'PAYMENT THANK YOU/PAIEMENT MERCI');
    assert.equal(payments[0]!.bankCategory, undefined);
  });

  it('separates merchant, location and bank category', async () => {
    const doc = await statement('statement-2026-10.pdf');
    const tims = doc.transactions.find((t) => t.description.startsWith('TIM HORTONS'))!;
    assert.equal(tims.description, 'TIM HORTONS #1021');
    assert.equal(tims.location, 'TORONTO ON');
    assert.equal(tims.bankCategory, 'Restaurants');
    assert.equal(tims.type, 'purchase');
    assert.match(tims.txnDate, /^2026-(09|10)-\d\d$/);
    assert.ok(tims.postDate! >= tims.txnDate);
  });

  it('splits a merchant name that runs into the city column', async () => {
    const oct = await statement('statement-2026-10.pdf');
    const ikea = oct.transactions.filter((t) => t.description.startsWith('IKEA'));
    assert.ok(ikea.some((t) => t.amountCents === 2789));
    for (const t of ikea) {
      assert.equal(t.description, 'IKEA TORONTO DOWNTOWN 100');
      assert.equal(t.location, 'TORONTO ON');
    }
    const subscription = oct.transactions.find((t) => t.description === 'ANTHROPIC* CLAUDE SUB')!;
    assert.equal(subscription.bankCategory, 'Home and Office Improvement');
  });

  it('classifies a reward credit separately from a refund', async () => {
    const doc = await statement('statement-2026-10.pdf');
    const cashback = doc.transactions.find((t) => /CASHBACK/.test(t.description))!;
    assert.equal(cashback.type, 'credit');
    assert.ok(cashback.amountCents < 0);
  });

  it('keeps a row whose baseline is shared with a margin barcode', async () => {
    // Regression: the eighth charge sits beside "*0000000000*" in the margin.
    // Dropping it is exactly the kind of error the count check exists to catch.
    const doc = await statement('statement-2026-09.pdf');
    const count = doc.checks.find((c) => c.unit === 'count')!;
    assert.equal(count.ok, true);
    assert.equal(count.actual, expected.september.chargeCount);
  });

  it('handles a statement with no payments section', async () => {
    const doc = await statement('statement-2026-09.pdf');
    assert.equal(doc.transactions.filter((t) => t.type === 'payment').length, 0);
    assert.deepEqual(doc.checks.filter((c) => !c.ok), []);
  });
});

describe('Metro receipt email', () => {
  async function receipt(): Promise<ParsedReceipt> {
    const doc = await parseDocument(fixture('metro-receipt.eml'));
    assert.equal(doc.docType, 'receipt');
    return doc as ParsedReceipt;
  }

  it('reads totals, date, payment and store', async () => {
    const doc = await receipt();
    const truth = expected.receipt;
    assert.equal(doc.merchant, 'Metro');
    assert.equal(doc.purchasedOn, truth.purchasedOn);
    assert.equal(doc.purchasedTime, truth.time);
    assert.equal(doc.subtotalCents, truth.subtotalCents);
    assert.equal(doc.taxCents, truth.taxCents);
    assert.equal(doc.totalCents, truth.totalCents);
    assert.equal(doc.savingsCents, truth.savingsCents);
    assert.equal(doc.cardLast4, truth.cardLast4);
    assert.equal(doc.paymentMethod, 'VISA CREDIT');
    assert.equal(doc.storeRef, '109001');
  });

  it('itemizes lines and proves the arithmetic', async () => {
    const doc = await receipt();
    assert.equal(doc.items.length, expected.receipt.itemCount);
    assert.equal(doc.items[0]!.name, expected.receipt.firstItem);
    assert.equal(sum(doc.items.map((i) => i.totalCents)) + doc.discountCents, doc.subtotalCents);
    assert.equal(doc.checks.length, 3);
    assert.deepEqual(doc.checks.filter((c) => !c.ok), []);
    assert.ok(doc.items.every((i) => i.department), 'every item should carry its department');
  });

  it('captures weight and unit price for weighed produce', async () => {
    const weighed = (await receipt()).items.filter((i) => i.unit === 'kg');
    assert.ok(weighed.length > 0, 'fixture should include weighed items');
    for (const item of weighed) {
      assert.ok(item.quantity! > 0 && item.unitPriceCents! > 0);
      assert.ok(Math.abs(Math.round(item.quantity! * item.unitPriceCents!) - item.totalCents) <= 1);
    }
  });

  it('never extracts the loyalty card or customer number', async () => {
    assert.doesNotMatch(JSON.stringify(await receipt()), /000000000|Customer Number|Rewards/);
  });

  it('flags a receipt whose arithmetic does not hold', () => {
    const lines = ['Store #1', 'GROCERY', 'TEA    4.00', 'SUBTOTAL    5.00', 'TOTAL    5.00', '01/02/2026   09:15 AM'];
    const doc = parseMetroReceipt({ fromAddress: 'a@metro.ca', subject: '', date: undefined, lines, authenticationResults: undefined });
    assert.equal(doc.checks[0]!.ok, false);
    assert.equal(doc.purchasedOn, '2026-01-02');
    assert.equal(doc.purchasedTime, '09:15');
    assert.match(doc.warnings.join(' '), /Receipt check failed/);
  });

  it('warns when the email failed DKIM', () => {
    const lines = ['GROCERY', 'TEA    4.00', 'SUBTOTAL    4.00', 'TOTAL    4.00', '01/02/2026   12:05 PM'];
    const doc = parseMetroReceipt({ fromAddress: 'a@metro.ca', subject: '', date: undefined, lines, authenticationResults: 'mx; dkim=fail' });
    assert.match(doc.warnings.join(' '), /DKIM/);
  });

  it('handles multi-buy lines', () => {
    const lines = ['GROCERY', 'YOGURT CUP', '3 @ $1.25   3.75', 'SUBTOTAL    3.75', 'TOTAL    3.75', 'Total number of items sold =  3', '01/02/2026   12:05 PM'];
    const doc = parseMetroReceipt({ fromAddress: 'a@metro.ca', subject: '', date: undefined, lines, authenticationResults: undefined });
    assert.deepEqual(doc.items.map((i) => [i.name, i.quantity, i.unitPriceCents, i.totalCents]), [['YOGURT CUP', 3, 125, 375]]);
    assert.deepEqual(doc.checks.filter((c) => !c.ok), []);
  });

  it('converts HTML to lines without collapsing column spacing', () => {
    const lines = htmlToLines('<style>x{}</style><table><tr><td>A&nbsp;&nbsp;&nbsp;1.00</td></tr><tr><td>&amp; B<br>C &#36;</td></tr></table>');
    assert.deepEqual(lines, ['A   1.00', '& B', 'C $']);
  });
});

describe('CSV', () => {
  it('reads a CIBC export and keeps only the last four card digits', async () => {
    const doc = await statement('cibc-export-2026-10.csv');
    const truth = expected.october;
    assert.equal(doc.kind, 'cibc-csv');
    assert.equal(doc.accountLast4, truth.cardLast4);
    assert.equal(doc.transactions.length, truth.chargeCount + truth.paymentCount);
    const charges = doc.transactions.filter((t) => t.type !== 'payment');
    assert.equal(sum(charges.filter((t) => t.amountCents > 0).map((t) => t.amountCents)), truth.purchasesCents);
    assert.equal(doc.transactions.find((t) => t.type === 'payment')!.amountCents, -truth.paymentsCents);
    assert.doesNotMatch(JSON.stringify(doc), /4500\*/);
  });

  it('reads a generic CSV by its header names', async () => {
    const doc = await statement('generic-2026-10.csv');
    assert.equal(doc.kind, 'generic-csv');
    assert.equal(doc.transactions.length, expected.october.chargeCount);
    assert.ok(doc.transactions.every((t) => t.bankCategory));
    assert.deepEqual(doc.checks, []);
  });

  it('supports debit/credit columns and day-first dates', async () => {
    const csv = 'Posted Date,Payee,Withdrawal,Deposit\n25/03/2026,Corner Shop,12.50,\n03/04/2026,Refund Corner Shop,,5.00\n';
    const doc = (await parseDocument(new TextEncoder().encode(csv))) as ParsedStatement;
    assert.deepEqual(doc.transactions.map((t) => [t.txnDate, t.amountCents, t.type]), [
      ['2026-03-25', 1250, 'purchase'],
      ['2026-03-04', -500, 'refund'],
    ]);
  });

  it('rejects a CSV without usable columns', async () => {
    await assert.rejects(parseDocument(new TextEncoder().encode('a,b,c\n1,2,3\n')), ParseError);
  });
});

describe('document detection', () => {
  it('rejects empty and binary files', async () => {
    await assert.rejects(parseDocument(new Uint8Array()), /empty/);
    await assert.rejects(parseDocument(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1])), /Unsupported file type/);
  });

  it('rejects a corrupt PDF without crashing', async () => {
    await assert.rejects(parseDocument(new TextEncoder().encode('%PDF-1.7\nthis is not a pdf')), ParseError);
  });

  it('reports an unknown PDF layout and hands back its text for the AI reader', async () => {
    const pdf = await unknownLayoutPdf(['ACME BANK', '2026-03-01 COFFEE 4.50']);
    await assert.rejects(parseDocument(pdf), (error: unknown) => {
      assert.ok(error instanceof UnknownLayoutError);
      assert.match(error.extractedText, /COFFEE 4\.50/);
      return true;
    });
  });

  it('reports an email that is not a known receipt', async () => {
    const eml = 'From: someone@example.test\r\nTo: me@example.test\r\nSubject: hi\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\n\r\nhello\r\n';
    await assert.rejects(parseDocument(new TextEncoder().encode(eml)), UnknownLayoutError);
  });
});
