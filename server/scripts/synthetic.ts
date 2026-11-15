/**
 * Synthetic data generator.
 *
 * Everything the repository ships as a fixture, demo or screenshot comes from
 * here: a fictional cardholder ("Alex Sample"), a fictional card and invented
 * purchases produced by a seeded random number generator. Same seed, same
 * bytes, so fixtures are reproducible and reviewable. No real statement,
 * receipt or person was used to produce any of it.
 *
 * The PDF and email writers imitate the layout of the supported document
 * formats closely enough that the real parsers are exercised end to end.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { addDays, toIsoDate } from '../src/lib/dates.ts';
import { formatCents } from '../src/lib/money.ts';

// --- Seeded randomness ------------------------------------------------------

export function createRng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    code: (length: number) =>
      Array.from({ length }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(next() * 32)]).join(''),
  };
}
type Rng = ReturnType<typeof createRng>;

// --- Model ------------------------------------------------------------------

export interface SynthTxn {
  txnDate: string;
  postDate: string;
  description: string;
  city: string;
  province: string;
  bankCategory: string;
  amountCents: number;
  multiplier: boolean;
}

export interface SynthStatement {
  periodStart: string;
  periodEnd: string;
  cardLast4: string;
  previousBalanceCents: number;
  payments: Array<{ txnDate: string; postDate: string; amountCents: number }>;
  charges: SynthTxn[];
  receipts: SynthReceipt[];
}

export interface SynthReceiptLine {
  department: string;
  name: string;
  totalCents: number;
  taxable: boolean;
  savingCents: number;
  weightKg?: number;
  pricePerKgCents?: number;
}

export interface SynthReceipt {
  storeNumber: string;
  purchasedOn: string;
  time: string;
  lines: SynthReceiptLine[];
  discounts: Array<{ label: string; baseCents: number; cents: number }>;
  subtotalCents: number;
  taxableCents: number;
  taxCents: number;
  totalCents: number;
  savingsCents: number;
  cardLast4: string;
}

const CARD_LAST4 = '4242';

interface MerchantSpec {
  description: string | ((rng: Rng) => string);
  city: string;
  province: string;
  bankCategory: string;
  perMonth: number;
  amount: (rng: Rng) => number;
  multiplier?: boolean;
}

const range = (min: number, max: number) => (rng: Rng) => rng.int(min, max);
const oneOf = (...values: number[]) => (rng: Rng) => rng.pick(values);

const MERCHANTS: MerchantSpec[] = [
  { description: 'TIM HORTONS #1021', city: 'TORONTO', province: 'ON', bankCategory: 'Restaurants', perMonth: 6, amount: range(189, 899), multiplier: true },
  { description: 'STARBUCKS 00412', city: 'TORONTO', province: 'ON', bankCategory: 'Restaurants', perMonth: 4, amount: range(289, 795), multiplier: true },
  { description: 'CAMPUS EATS-20411', city: 'TORONTO', province: 'ON', bankCategory: 'Restaurants', perMonth: 8, amount: range(515, 1290), multiplier: true },
  { description: 'BURRITO PLANET # 7', city: 'TORONTO', province: 'ON', bankCategory: 'Restaurants', perMonth: 2, amount: range(1099, 1649), multiplier: true },
  { description: 'PIZZA CORNER', city: 'TORONTO', province: 'ON', bankCategory: 'Restaurants', perMonth: 2, amount: range(368, 925), multiplier: true },
  { description: 'SQ *NOODLE HOUSE', city: 'TORONTO', province: 'ON', bankCategory: 'Restaurants', perMonth: 1.5, amount: range(1425, 2450) },
  { description: 'UBER CANADA/UBEREATS', city: 'TORONTO', province: 'ON', bankCategory: 'Restaurants', perMonth: 1.5, amount: range(1840, 3410) },
  { description: "NOFRILLS SAM'S #3101", city: 'SCARBOROUGH', province: 'ON', bankCategory: 'Retail and Grocery', perMonth: 3, amount: range(1820, 7050), multiplier: true },
  { description: 'WAL-MART STORE#1099', city: 'SCARBOROUGH', province: 'ON', bankCategory: 'Retail and Grocery', perMonth: 1, amount: range(3010, 9560) },
  { description: 'DOLLARAMA #0456', city: 'TORONTO', province: 'ON', bankCategory: 'Retail and Grocery', perMonth: 3, amount: range(310, 2240) },
  { description: (rng) => `PRESTO MOBI/${rng.code(10)}`, city: 'TORONTO', province: 'ON', bankCategory: 'Transportation', perMonth: 9, amount: oneOf(500, 1000, 1000, 1500, 2000), multiplier: true },
  { description: 'PRESTO UNION STN', city: 'TORONTO', province: 'ON', bankCategory: 'Transportation', perMonth: 2, amount: oneOf(1000, 2000), multiplier: true },
  { description: 'SHELL C01234', city: 'AGINCOURT', province: 'ON', bankCategory: 'Transportation', perMonth: 0.7, amount: range(2500, 5100), multiplier: true },
  { description: 'Lyft *Temp Auth Hold', city: 'Vancouver', province: 'BC', bankCategory: 'Transportation', perMonth: 1, amount: range(698, 2805), multiplier: true },
  { description: (rng) => `AMZN Mktp CA*${rng.code(9)}`, city: 'WWW.AMAZON.CA', province: 'ON', bankCategory: 'Retail and Grocery', perMonth: 1.5, amount: range(1299, 8250) },
  { description: 'IKEA TORONTO DOWNTOWN 100', city: 'TORONTO', province: 'ON', bankCategory: 'Home and Office Improvement', perMonth: 0.3, amount: range(1500, 14200) },
  { description: 'SHOPPERS DRUG MART #08', city: 'TORONTO', province: 'ON', bankCategory: 'Personal and Household Expenses', perMonth: 1, amount: range(820, 3540) },
  { description: 'CINEPLEX #7120', city: 'TORONTO', province: 'ON', bankCategory: 'Hotel, Entertainment and Recreation', perMonth: 0.7, amount: range(1425, 3290) },
  { description: 'CAMPUS BOOKSTORE', city: 'TORONTO', province: 'ON', bankCategory: 'Health and Education', perMonth: 0.3, amount: range(2500, 16400) },
];

const SUBSCRIPTIONS = [
  { day: 25, description: 'ANTHROPIC* CLAUDE SUB', city: 'ANTHROPIC.COM', province: 'CA', bankCategory: 'Home and Office Improvement', amountCents: 3164 },
  { day: 9, description: (rng: Rng) => `Spotify P${rng.code(9)}`, city: 'Stockholm', province: '', bankCategory: 'Retail and Grocery', amountCents: 1242 },
  { day: 12, description: 'FIDO MOBILE ******1234', city: '888-555-0100', province: 'ON', bankCategory: 'Personal and Household Expenses', amountCents: 6215 },
  { day: 16, description: 'GOOGLE*GOOGLE ONE', city: 'HALIFAX', province: 'NS', bankCategory: 'Retail and Grocery', amountCents: 315 },
  { day: 3, description: 'NETFLIX.COM', city: '866-555-0199', province: 'ON', bankCategory: 'Hotel, Entertainment and Recreation', amountCents: 1863 },
];

const GROCERY_CATALOG: Array<Omit<SynthReceiptLine, 'totalCents' | 'savingCents'> & { priceCents?: number; perKg?: number }> = [
  { department: 'GROCERY', name: 'PASTA SAUCE 650ML', priceCents: 349, taxable: false },
  { department: 'GROCERY', name: 'SPAGHETTI 900G', priceCents: 279, taxable: false },
  { department: 'GROCERY', name: 'BASMATI RICE 2KG', priceCents: 899, taxable: false },
  { department: 'GROCERY', name: 'ROLLED OATS 1KG', priceCents: 449, taxable: false },
  { department: 'GROCERY', name: 'SPARKLING WATER 12PK', priceCents: 599, taxable: true },
  { department: 'GROCERY', name: 'POTATO CHIPS 200G', priceCents: 399, taxable: true },
  { department: 'PRODUCE', name: 'PREMIUM BANANA', perKg: 174, taxable: false },
  { department: 'PRODUCE', name: 'GALA APPLE', perKg: 439, taxable: false },
  { department: 'PRODUCE', name: 'TOMATO ON THE VINE', perKg: 659, taxable: false },
  { department: 'PRODUCE', name: 'YELLOW ONION', perKg: 328, taxable: false },
  { department: 'PRODUCE', name: 'BABY SPINACH 312G', priceCents: 499, taxable: false },
  { department: 'DAIRY', name: 'MILK 2% 2L', priceCents: 549, taxable: false },
  { department: 'DAIRY', name: 'LARGE EGGS 12', priceCents: 479, taxable: false },
  { department: 'DAIRY', name: 'GREEK YOGURT 750G', priceCents: 649, taxable: false },
  { department: 'SERV. BAKERY', name: 'EVERYTHING BAGEL', priceCents: 249, taxable: false },
  { department: 'SERV. BAKERY', name: 'SOURDOUGH LOAF', priceCents: 429, taxable: false },
  { department: 'MEAT', name: 'CHICKEN BREAST', perKg: 1499, taxable: false },
];

// --- Generators -------------------------------------------------------------

function makeReceipt(rng: Rng, purchasedOn: string): SynthReceipt {
  const count = rng.int(4, 9);
  const chosen = new Set<number>();
  while (chosen.size < count) chosen.add(rng.int(0, GROCERY_CATALOG.length - 1));
  const lines: SynthReceiptLine[] = [...chosen]
    .sort((a, b) => a - b)
    .map((index) => {
      const item = GROCERY_CATALOG[index]!;
      const saving = rng.next() < 0.3 ? rng.pick([50, 80, 100, 150, 250]) : 0;
      if (item.perKg) {
        const grams = rng.int(180, 1250);
        return {
          department: item.department, name: item.name, taxable: item.taxable, savingCents: 0,
          weightKg: grams / 1000, pricePerKgCents: item.perKg, totalCents: Math.round((grams / 1000) * item.perKg),
        };
      }
      return { department: item.department, name: item.name, taxable: item.taxable, savingCents: saving, totalCents: item.priceCents! };
    });

  // A 10% loyalty offer on one or two departments, like a real till prints.
  const departments = [...new Set(lines.map((l) => l.department))];
  const discounted = departments.filter(() => rng.next() < 0.4).slice(0, 2);
  const discounts = discounted.map((department) => {
    const baseCents = lines.filter((l) => l.department === department).reduce((sum, l) => sum + l.totalCents, 0);
    return { label: `${department} Discount 10%`, baseCents, cents: -Math.round(baseCents * 0.1) };
  });

  const itemsTotal = lines.reduce((sum, l) => sum + l.totalCents, 0);
  const discountTotal = discounts.reduce((sum, d) => sum + d.cents, 0);
  const subtotalCents = itemsTotal + discountTotal;
  const taxableCents = lines.filter((l) => l.taxable).reduce((sum, l) => sum + l.totalCents, 0);
  const taxCents = Math.round(taxableCents * 0.13);
  return {
    storeNumber: '109001',
    purchasedOn,
    time: `${String(rng.int(9, 21)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`,
    lines,
    discounts,
    subtotalCents,
    taxableCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    savingsCents: -discountTotal + lines.reduce((sum, l) => sum + l.savingCents, 0),
    cardLast4: CARD_LAST4,
  };
}

/**
 * Generates `months` consecutive statements, the last one closing on
 * `lastPeriodEnd`. Statement periods run from the 22nd to the 21st.
 */
export function generateStatements(options: { seed?: number; months?: number; lastPeriodEnd?: string; receiptsForLast?: number } = {}): SynthStatement[] {
  const { seed = 20260101, months = 6, lastPeriodEnd = '2026-10-21', receiptsForLast = 2 } = options;
  const rng = createRng(seed);
  const [endYear, endMonth] = lastPeriodEnd.split('-').map(Number) as [number, number];
  const monthFactor = [0.9, 1.0, 1.18, 0.94, 1.27, 1.06, 1.0, 1.1, 0.97, 1.2, 0.92, 1.05];
  const statements: SynthStatement[] = [];
  let previousBalanceCents = 0;

  for (let m = months - 1; m >= 0; m--) {
    const end = new Date(Date.UTC(endYear, endMonth - 1 - m, 21));
    const periodEnd = end.toISOString().slice(0, 10);
    const prev = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 22));
    const periodStart = prev.toISOString().slice(0, 10);
    const index = months - 1 - m;
    const factor = monthFactor[index % monthFactor.length]!;
    const length = Math.round((end.getTime() - prev.getTime()) / 86_400_000) + 1;
    // Card networks date a purchase the day before the period opens fairly often.
    const dayAt = (offset: number) => addDays(periodStart, offset);
    const charges: SynthTxn[] = [];
    const post = (txnDate: string) => {
      const posted = addDays(txnDate, rng.int(1, 3));
      return posted > periodEnd ? periodEnd : posted;
    };
    const add = (spec: Pick<SynthTxn, 'description' | 'city' | 'province' | 'bankCategory' | 'amountCents'> & { txnDate: string; multiplier?: boolean }) => {
      charges.push({ ...spec, postDate: post(spec.txnDate), multiplier: spec.multiplier ?? false });
    };

    for (const merchant of MERCHANTS) {
      const expected = merchant.perMonth * factor;
      const visits = Math.floor(expected) + (rng.next() < expected % 1 ? 1 : 0);
      for (let v = 0; v < visits; v++) {
        add({
          txnDate: dayAt(rng.int(-1, length - 2)),
          description: typeof merchant.description === 'function' ? merchant.description(rng) : merchant.description,
          city: merchant.city,
          province: merchant.province,
          bankCategory: merchant.bankCategory,
          amountCents: merchant.amount(rng),
          multiplier: merchant.multiplier ?? false,
        });
      }
    }

    for (const sub of SUBSCRIPTIONS) {
      // The billing day falls in whichever calendar month of the period contains it.
      const inEndMonth = sub.day <= 21;
      const base = inEndMonth ? end : prev;
      add({
        txnDate: toIsoDate(base.getUTCFullYear(), base.getUTCMonth() + 1, sub.day),
        description: typeof sub.description === 'function' ? sub.description(rng) : sub.description,
        city: sub.city,
        province: sub.province,
        bankCategory: sub.bankCategory,
        amountCents: sub.amountCents,
        multiplier: true,
      });
    }

    // Grocery trips at the supermarket. In the most recent periods each one
    // has a matching itemized receipt whose total is the charged amount.
    const receipts: SynthReceipt[] = [];
    const trips = Math.round(4 * factor);
    for (let t = 0; t < trips; t++) {
      const txnDate = dayAt(rng.int(0, length - 3));
      const receipt = makeReceipt(rng, txnDate);
      if (m < receiptsForLast) receipts.push(receipt);
      add({ txnDate, description: 'METRO 9001', city: 'TORONTO', province: 'ON', bankCategory: 'Retail and Grocery', amountCents: receipt.totalCents, multiplier: true });
    }

    // Story beats that give the analytics something to find.
    if (index === 2) {
      const bought = dayAt(6);
      add({ txnDate: bought, description: 'WINNERS 4321', city: 'TORONTO', province: 'ON', bankCategory: 'Retail and Grocery', amountCents: 6439 });
      add({ txnDate: addDays(bought, 5), description: 'WINNERS 4321', city: 'TORONTO', province: 'ON', bankCategory: 'Retail and Grocery', amountCents: -6439 });
    }
    if (index === months - 2) {
      add({ txnDate: dayAt(11), description: 'BEST BUY #950', city: 'TORONTO', province: 'ON', bankCategory: 'Retail and Grocery', amountCents: 41285 });
    }
    if (index === months - 1) {
      add({ txnDate: dayAt(14), description: 'CAMPUS EATS-20411', city: 'TORONTO', province: 'ON', bankCategory: 'Restaurants', amountCents: 4860, multiplier: true });
      // A merchant name that fills its 25-character field and runs into the city.
      add({ txnDate: dayAt(9), description: 'IKEA TORONTO DOWNTOWN 100', city: 'TORONTO', province: 'ON', bankCategory: 'Home and Office Improvement', amountCents: 2789 });
      add({ txnDate: dayAt(17), description: 'CASHBACK/REMISE EN ARGENT', city: '', province: '', bankCategory: 'Other Transactions', amountCents: -3712 });
    }

    charges.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.postDate.localeCompare(b.postDate));
    const payments = previousBalanceCents > 0
      ? [{ txnDate: dayAt(15), postDate: dayAt(16), amountCents: previousBalanceCents }]
      : [];
    statements.push({ periodStart, periodEnd, cardLast4: CARD_LAST4, previousBalanceCents, payments, charges, receipts });
    previousBalanceCents = charges.reduce((sum, c) => sum + c.amountCents, 0);
  }
  return statements;
}

// --- Writers ----------------------------------------------------------------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string, withYear: boolean) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${MONTH_NAMES[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
};
const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${MONTH_NAMES[m - 1]!.slice(0, 3)} ${String(d).padStart(2, '0')}`;
};
const plain = (cents: number) => formatCents(cents).replace('$', '');

/** Renders a statement as a PDF in the column layout the CIBC credit card parser reads. */
export async function renderStatementPdf(statement: SynthStatement): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Synthetic sample statement');
  pdf.setProducer('LedgerLens synthetic data generator');
  pdf.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
  pdf.setModificationDate(new Date(Date.UTC(2026, 0, 1)));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const size = 7;

  const purchases = statement.charges.filter((c) => c.amountCents > 0).reduce((s, c) => s + c.amountCents, 0);
  const credits = -statement.charges.filter((c) => c.amountCents < 0).reduce((s, c) => s + c.amountCents, 0);
  const paid = statement.payments.reduce((s, p) => s + p.amountCents, 0);
  const net = purchases - credits;
  const masked = `XXXX XXXX XXXX ${statement.cardLast4}`;

  // Page 1: account summary.
  const p1 = pdf.addPage([612, 792]);
  const text1 = (value: string, x: number, y: number) => p1.drawText(value, { x, y, size, font });
  text1('CIBC-format synthetic sample statement - not a real document', 73, 720);
  text1('ALEX SAMPLE', 418, 700);
  text1('Your account at a glance', 73, 631);
  const summaryRows: Array<[string, string, number]> = [
    ['Previous balance', formatCents(statement.previousBalanceCents), 73],
    ['Payments', formatCents(paid), 91],
    ['Other credits', plain(credits), 91],
    ['Purchases', plain(purchases), 91],
    ['Cash advances', '0.00', 91],
    ['Interest', '0.00', 91],
    ['Fees', '0.00', 91],
    ['Total balance', formatCents(statement.previousBalanceCents - paid + net), 73],
  ];
  summaryRows.forEach(([label, value, x], i) => {
    const y = 613 - i * 14;
    text1(label, x, y);
    text1(value, 260, y);
  });

  // Transaction pages.
  let page = pdf.addPage([612, 792]);
  let left = 37; // odd/even pages use different margins, as on the real layout
  let y = 746;
  const text = (value: string, dx: number) => {
    if (value) page.drawText(value, { x: left + dx, y, size, font });
  };
  const amountAt = (cents: number) => text(plain(cents), 487 - (plain(cents).length - 4) * 4);
  const nextLine = (gap = 13) => { y -= gap; };

  text('Transactions', 0);
  text(`from ${longDate(statement.periodStart, false)} to ${longDate(statement.periodEnd, true)}`, 111);
  nextLine(31);

  if (statement.payments.length) {
    text('Your payments', 0);
    nextLine(18);
    for (const payment of statement.payments) {
      text(shortDate(payment.txnDate), 0);
      text(shortDate(payment.postDate), 42);
      text('PAYMENT THANK YOU/PAIEMENT MERCI', 82);
      amountAt(payment.amountCents);
      nextLine();
    }
    text('Total payments', 0);
    text(formatCents(paid), 474);
    nextLine(16);
  }

  const chargesHeader = (continued: boolean) => {
    text('Your new charges and credits', 0);
    if (continued) text('(continued)', 171);
    nextLine(21);
    text('Trans', 0); text('Post', 42); text('Description', 85); text('Spend Categories', 288); text('Amount($)', 467);
    nextLine();
    text(`Card number ${masked}`, 0);
    nextLine(15);
  };
  chargesHeader(false);

  statement.charges.forEach((charge, index) => {
    if (y < 90) {
      page = pdf.addPage([612, 792]);
      left = left === 37 ? 73 : 37;
      y = 683;
      chargesHeader(true);
    }
    // One row shares its baseline with a margin barcode, as real statements do.
    if (index === 7) page.drawText('*0000000000*', { x: 18, y, size: 6, font });
    text(shortDate(charge.txnDate), 0);
    text(shortDate(charge.postDate), 42);
    if (charge.multiplier) text('Ý', 72);
    const place = `${charge.city}${charge.city && charge.province ? ' ' : ''}${charge.province}`;
    if (charge.description.length >= 25) {
      // A full 25-character merchant field runs straight into the city.
      text(`${charge.description}${charge.city}`, 86);
      text(charge.province, 86 + font.widthOfTextAtSize(`${charge.description}${charge.city}`, size) + 4);
    } else {
      text(charge.description, 86);
      text(place, 86 + Math.max(60, font.widthOfTextAtSize(charge.description, size) + 12));
    }
    text(charge.bankCategory, 304);
    amountAt(charge.amountCents);
    nextLine();
  });
  text(`Total for ${masked}`, 0);
  text(formatCents(net), 474);

  // Spend category summary page: the parser reads the transaction count from it.
  const last = pdf.addPage([612, 792]);
  const textLast = (value: string, x: number, yy: number) => last.drawText(value, { x, y: yy, size, font });
  textLast('Spend Categories', 37, 732); textLast('Transactions', 183, 732); textLast('Amount($)', 248, 732);
  textLast('Total', 60, 560);
  textLast(String(statement.charges.length), 214, 560);
  textLast(plain(net), 260, 560);

  return pdf.save({ useObjectStreams: false });
}

/** Renders the statement as a CIBC "download transactions" CSV (no header row). */
export function renderCibcCsv(statement: SynthStatement): string {
  const rows = [
    ...statement.payments.map((p) => [p.txnDate, 'PAYMENT THANK YOU/PAIEMENT MERCI', '', plain(p.amountCents).replaceAll(',', '')]),
    ...statement.charges.map((c) => [
      c.txnDate,
      `${c.description} ${c.city}${c.province ? `, ${c.province}` : ''}`.trim(),
      c.amountCents > 0 ? plain(c.amountCents).replaceAll(',', '') : '',
      c.amountCents < 0 ? plain(-c.amountCents).replaceAll(',', '') : '',
    ]),
  ];
  return rows
    .sort((a, b) => a[0]!.localeCompare(b[0]!))
    .map((r) => [...r.map((cell) => (cell.includes(',') ? `"${cell}"` : cell)), `4500********${statement.cardLast4}`].join(','))
    .join('\n') + '\n';
}

/** Renders the statement as a generic CSV with a header row. */
export function renderGenericCsv(statement: SynthStatement): string {
  const lines = ['Date,Description,Amount,Category'];
  for (const c of statement.charges) {
    lines.push(`${c.txnDate},"${c.description}",${(c.amountCents / 100).toFixed(2)},"${c.bankCategory}"`);
  }
  return lines.join('\n') + '\n';
}

/** Renders a receipt as the HTML email a supermarket sends, wrapped in a MIME message. */
export function renderReceiptEmail(receipt: SynthReceipt): string {
  const row = (left: string, right = '', flag = '') => {
    const middle = flag ? `${' '.repeat(Math.max(2, 29 - left.length))}${flag}` : '';
    const body = `${left}${middle}`;
    return right ? `${body}${' '.repeat(Math.max(2, 40 - body.length - right.length))}${right}` : body;
  };
  const out: string[] = [];
  out.push('Thank you for your recent purchase at Metro', `Store #${receipt.storeNumber} (416) 555-0142`, 'E&OE        HST# R000000000');
  out.push('Moi Rewards program', 'Moi Rewards card number:000000000', 'Customer Number:9001');
  let department = '';
  for (const line of receipt.lines) {
    if (line.department !== department) {
      department = line.department;
      out.push(department);
    }
    if (line.weightKg) {
      out.push(line.name, row(`${line.weightKg.toFixed(3)} kg @ $${plain(line.pricePerKgCents!)}/kg`, plain(line.totalCents)));
    } else {
      out.push(row(line.name, plain(line.totalCents), line.taxable ? 'H' : ''));
    }
    if (line.savingCents) out.push(`Saving ${plain(line.savingCents)}`);
  }
  if (receipt.discounts.length) out.push('Special Bonus Offer');
  for (const discount of receipt.discounts) {
    out.push(discount.label, row(`(${plain(discount.baseCents)}@10.00%)`, plain(discount.cents)));
  }
  out.push(row('SUBTOTAL', plain(receipt.subtotalCents)));
  if (receipt.taxCents) out.push(row(`${plain(receipt.taxableCents)}  HST (13.000)%`, plain(receipt.taxCents)));
  out.push(row('TOTAL', plain(receipt.totalCents)), row('CREDIT CR', plain(receipt.totalCents)));
  out.push(`Total number of items sold =     ${receipt.lines.length}`, '****** Your savings today ******');
  out.push(row('Total of your savings', plain(receipt.savingsCents)));
  const [y, m, d] = receipt.purchasedOn.split('-');
  out.push('Trans. Type:  PURCHASE', `Account:  VISA                 CAD$ ${plain(receipt.totalCents)}`, 'Card Type:  CREDIT');
  out.push(`Card Number:     ************${receipt.cardLast4} P`, `DateTime:        ${y!.slice(2)}/${m}/${d} ${receipt.time}:00`);
  out.push('00 APPROVED  - THANK YOU', '*** CUSTOMER COPY ***');

  const html =
    '<html><body><table>' +
    out.map((line) => `<tr><td style="font-family:monospace">${line.replaceAll('&', '&amp;').replaceAll(' ', '&nbsp;')}</td></tr>`).join('\r\n') +
    '</table></body></html>';
  const sent = new Date(`${receipt.purchasedOn}T${receipt.time}:30Z`).toUTCString().replace('GMT', '+0000');
  return [
    'Return-Path: <transaction@transaction-metro.ca>',
    'Authentication-Results: mx.example.test; dkim=pass header.i=@transaction-metro.ca',
    'MIME-Version: 1.0',
    `Date: ${sent}`,
    'From: Metro Receipts <transaction@transaction-metro.ca>',
    'To: alex.sample@example.test',
    `Message-ID: <${receipt.purchasedOn}.${receipt.totalCents}@synthetic.example.test>`,
    'Subject: Alex, your digital receipt has arrived.',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
  ].join('\r\n');
}
