import PostalMime from 'postal-mime';
import { isValidYmd, toIsoDate } from '../lib/dates.ts';
import { parseMoneyToCents, sumCents } from '../lib/money.ts';
import { check, ParseError } from './types.ts';
import type { ParsedReceipt, ParsedReceiptItem, ReconciliationCheck } from './types.ts';

/**
 * Parser for Metro (Canada) digital receipt emails.
 *
 * The email body is the till receipt rendered as fixed-width text, so it is
 * parsed the way a person reads it: department headings, item lines ending in
 * a price, an optional detail line for weighed or multi-buy items, then the
 * discount block, SUBTOTAL, tax and TOTAL.
 *
 * Deliberately ignored: the loyalty card number, the customer number and the
 * survey code. None of them are needed and none are stored.
 */

const PRICE_LINE = /^(.+?)(?:\s{2,}([A-Z]{1,3}))?\s{2,}(-?\d{1,5}\.\d{2})-?\s*$/;
// "0.835 kg @ $1.96/kg   1.64"  |  "2 @ $2.49   4.98"  |  "3 @ 3/$5.00   5.00"
const QUANTITY_LINE = /^(\d+(?:\.\d+)?)\s*(kg|lb|g)?\s*@\s*(?:(\d+)\s*\/\s*)?\$?\s*(\d+\.\d{2})(?:\s*\/\s*(?:kg|lb|g|ea))?\s+(-?\d{1,5}\.\d{2})\s*$/i;
const TAX_LINE = /^(?:\d+\.\d{2}\s+)?(HST|GST|PST|QST|TPS|TVQ)\b.*?(\d+\.\d{2})\s*$/i;
const TENDER = /^(CREDIT|DEBIT|CASH|VISA|MASTERCARD|MC|AMEX|INTERAC|GIFT CARD|COMPTANT)\b/i;

export interface EmailEnvelope {
  fromAddress: string;
  subject: string;
  date: string | undefined;
  lines: string[];
  authenticationResults: string | undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

/** Converts an HTML email body to text lines, preserving the receipt's column spacing. */
export function htmlToLines(html: string): string[] {
  const text = decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(?:tr|p|div|td|th|li|h[1-6]|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
  return text
    .split(/\r?\n/)
    // Non-breaking spaces, soft hyphens and the zero-width padding marketing emails are stuffed with.
    .map((line) => line.replace(/[\u00a0\u00ad\u2000-\u200f]|\u034f/gu, ' ').replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/^\s+/, ''));
}

export async function readEmail(bytes: Uint8Array): Promise<EmailEnvelope> {
  let email;
  try {
    email = await PostalMime.parse(bytes);
  } catch {
    throw new ParseError('The file is not a readable email message.');
  }
  const body = email.html ? htmlToLines(email.html) : (email.text ?? '').split(/\r?\n/).filter((l) => l.trim());
  const header = (name: string) => email.headers.find((h) => h.key === name)?.value;
  return {
    fromAddress: (email.from?.address ?? '').toLowerCase(),
    subject: email.subject ?? '',
    date: email.date,
    lines: body,
    authenticationResults: header('authentication-results'),
  };
}

export function looksLikeEmail(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  const headerLines = head.match(/^(?:From|To|Subject|Date|Received|MIME-Version|Delivered-To|Return-Path|Message-ID):/gim);
  return (headerLines?.length ?? 0) >= 3;
}

export function looksLikeMetroReceipt(email: EmailEnvelope): boolean {
  const domain = email.fromAddress.split('@')[1] ?? '';
  const fromMetro = /(^|[.-])metro\.ca$/.test(domain);
  const hasTotals = email.lines.some((l) => /^SUBTOTAL\b/.test(l)) && email.lines.some((l) => /^TOTAL\b/.test(l));
  return fromMetro && hasTotals;
}

function parsePurchaseDate(lines: string[], fallback: string | undefined): { date: string; time?: string } {
  for (const line of lines) {
    // Card slip: "DateTime: 26/11/12 20:34:20" (YY/MM/DD)
    const slip = /DateTime:\s*(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2})/i.exec(line);
    if (slip) {
      const [year, month, day] = [2000 + Number(slip[1]), Number(slip[2]), Number(slip[3])];
      if (isValidYmd(year, month, day)) return { date: toIsoDate(year, month, day), time: slip[4]! };
    }
  }
  for (const line of lines) {
    // Footer: "11/12/2026   08:34 PM" (MM/DD/YYYY)
    const footer = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(line);
    if (footer) {
      const [month, day, year] = [Number(footer[1]), Number(footer[2]), Number(footer[3])];
      if (!isValidYmd(year, month, day)) continue;
      let hour = Number(footer[4]);
      const meridiem = footer[6]?.toUpperCase();
      if (meridiem === 'PM' && hour < 12) hour += 12;
      if (meridiem === 'AM' && hour === 12) hour = 0;
      return { date: toIsoDate(year, month, day), time: `${String(hour).padStart(2, '0')}:${footer[5]}` };
    }
  }
  if (fallback) {
    const sent = new Date(fallback);
    if (!Number.isNaN(sent.getTime())) return { date: sent.toISOString().slice(0, 10) };
  }
  throw new ParseError('Could not find the purchase date on this receipt.');
}

export function parseMetroReceipt(email: EmailEnvelope): ParsedReceipt {
  const { lines } = email;
  const warnings: string[] = [];

  if (email.authenticationResults && /dkim=(?:fail|permerror)/i.test(email.authenticationResults)) {
    warnings.push('The email failed DKIM verification; treat this receipt as unverified.');
  }

  const subtotalIndex = lines.findIndex((l) => /^SUBTOTAL\b/.test(l));
  if (subtotalIndex < 0) throw new ParseError('No SUBTOTAL line was found on this receipt.');

  // Items start after the store/loyalty header block.
  let start = 0;
  for (let i = 0; i < subtotalIndex; i++) {
    if (/^(?:Store\s*#|E&OE|HST#|Customer Number|.*card number)/i.test(lines[i]!) || /Rewards program/i.test(lines[i]!)) {
      start = i + 1;
    }
  }

  const storeMatch = lines.map((l) => /Store\s*#\s*(\d+)/i.exec(l)).find(Boolean);
  const items: ParsedReceiptItem[] = [];
  let discountCents = 0;
  let department: string | undefined;
  let pendingName: string | undefined;

  for (let i = start; i < subtotalIndex; i++) {
    const line = lines[i]!;

    const saving = /^Saving\s+(\d+\.\d{2})$/i.exec(line);
    if (saving) {
      const last = items.at(-1);
      if (last) last.savingCents += parseMoneyToCents(saving[1]!) ?? 0;
      continue;
    }

    const quantity = QUANTITY_LINE.exec(line);
    if (quantity && pendingName) {
      const count = Number(quantity[1]);
      const unit = quantity[2]?.toLowerCase();
      const bundle = quantity[3] ? Number(quantity[3]) : 1;
      const unitPrice = parseMoneyToCents(quantity[4]!) ?? 0;
      items.push({
        ...(department ? { department } : {}),
        name: pendingName,
        quantity: count,
        ...(unit ? { unit } : { unit: 'ea' }),
        unitPriceCents: Math.round(unitPrice / bundle),
        totalCents: parseMoneyToCents(quantity[5]!) ?? 0,
        savingCents: 0,
        taxable: false,
      });
      pendingName = undefined;
      continue;
    }

    const priced = PRICE_LINE.exec(line);
    if (priced) {
      const cents = parseMoneyToCents(priced[3]!);
      if (cents === null) continue;
      if (cents < 0) {
        // "(3.49@10.00%)   -0.35": a basket-level discount, not a product.
        discountCents += cents;
      } else {
        items.push({
          ...(department ? { department } : {}),
          name: priced[1]!.trim(),
          quantity: 1,
          unit: 'ea',
          totalCents: cents,
          savingCents: 0,
          taxable: Boolean(priced[2]),
        });
      }
      pendingName = undefined;
      continue;
    }

    // An unpriced line is either a department heading or the name of an item
    // whose price is on the next (quantity) line.
    const next = lines[i + 1] ?? '';
    if (QUANTITY_LINE.test(next)) {
      pendingName = line.trim();
    } else if (/^[A-Z][A-Z .&/'-]{1,28}$/.test(line) && !/Discount|Offer/i.test(line)) {
      department = line.trim();
    }
  }

  const money = (pattern: RegExp): number | null => {
    for (const line of lines) {
      const m = pattern.exec(line);
      if (m) return parseMoneyToCents(m[1]!);
    }
    return null;
  };

  const subtotalCents = money(/^SUBTOTAL\s+(-?\d+\.\d{2})/);
  const totalCents = money(/^TOTAL\s+(-?\d+\.\d{2})/);
  if (subtotalCents === null || totalCents === null) {
    throw new ParseError('The receipt is missing a readable SUBTOTAL or TOTAL.');
  }

  const totalIndex = lines.findIndex((l) => /^TOTAL\s/.test(l));
  let taxCents = 0;
  for (const line of lines.slice(subtotalIndex + 1, totalIndex < 0 ? undefined : totalIndex)) {
    const tax = TAX_LINE.exec(line);
    if (tax) taxCents += parseMoneyToCents(tax[2]!) ?? 0;
  }

  const tenderLine = lines.slice(totalIndex + 1, totalIndex + 4).find((l) => TENDER.test(l));
  const cardMatch = lines.map((l) => /Card Number:\s*[*Xx\s]*(\d{4})\b/i.exec(l)).find(Boolean);
  const cardType = lines.map((l) => /^Account:\s*([A-Za-z ]+?)\s{2,}/i.exec(l)).find(Boolean);
  const statedItems = lines.map((l) => /Total number of items sold\s*=\s*(\d+)/i.exec(l)).find(Boolean);
  const savingsCents = money(/Total of your savings\s+(\d+\.\d{2})/i) ?? 0;
  const purchased = parsePurchaseDate(lines, email.date);

  const itemsTotal = sumCents(items.map((item) => item.totalCents));
  const checks: ReconciliationCheck[] = [
    check('Items and discounts add up to SUBTOTAL', subtotalCents, itemsTotal + discountCents),
    check('SUBTOTAL plus tax equals TOTAL', totalCents, subtotalCents + taxCents),
  ];
  if (statedItems) {
    const soldCount = sumCents(items.map((item) => (item.unit === 'ea' ? Math.round(item.quantity ?? 1) : 1)));
    checks.push(check('Number of items sold', Number(statedItems[1]), soldCount, 'count'));
  }
  for (const c of checks) {
    if (!c.ok) warnings.push(`Receipt check failed on "${c.label}": printed ${c.expected}, parsed ${c.actual}.`);
  }
  if (items.length === 0) throw new ParseError('No items were found on this receipt.');

  const paymentMethod = [cardType?.[1]?.trim(), tenderLine ? TENDER.exec(tenderLine)![1]!.toUpperCase() : undefined]
    .filter(Boolean)
    .join(' ') || undefined;

  return {
    docType: 'receipt',
    kind: 'metro-receipt-email',
    merchant: 'Metro',
    ...(storeMatch ? { storeRef: storeMatch[1]! } : {}),
    purchasedOn: purchased.date,
    ...(purchased.time ? { purchasedTime: purchased.time } : {}),
    items,
    discountCents,
    subtotalCents,
    taxCents,
    totalCents,
    savingsCents,
    ...(paymentMethod ? { paymentMethod } : {}),
    ...(cardMatch ? { cardLast4: cardMatch[1]! } : {}),
    checks,
    warnings,
  };
}
