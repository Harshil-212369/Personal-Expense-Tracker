export type TransactionType = 'purchase' | 'refund' | 'payment' | 'credit' | 'fee' | 'interest';

export type DocumentKind = 'cibc-credit-pdf' | 'cibc-csv' | 'generic-csv' | 'metro-receipt-email' | 'ai-statement';

/**
 * A figure printed on the document compared with the same figure recomputed
 * from the parsed rows. A statement is only marked reconciled when every check
 * passes, which is how a silent parsing error gets caught.
 */
export interface ReconciliationCheck {
  label: string;
  unit: 'cents' | 'count';
  expected: number;
  actual: number;
  ok: boolean;
}

export interface ParsedTransaction {
  txnDate: string;
  postDate?: string;
  /** Raw merchant text as printed, without the city/province columns. */
  description: string;
  location?: string;
  /** Positive = charge, negative = money returned to the account. */
  amountCents: number;
  type: TransactionType;
  bankCategory?: string;
  notes?: string;
}

export interface ParsedStatement {
  docType: 'statement';
  kind: DocumentKind;
  institution: string;
  accountName: string;
  accountType: 'credit' | 'chequing' | 'savings' | 'cash';
  accountLast4?: string;
  periodStart?: string;
  periodEnd?: string;
  transactions: ParsedTransaction[];
  checks: ReconciliationCheck[];
  warnings: string[];
}

export interface ParsedReceiptItem {
  department?: string;
  name: string;
  quantity?: number;
  unit?: string;
  unitPriceCents?: number;
  totalCents: number;
  savingCents: number;
  taxable: boolean;
}

export interface ParsedReceipt {
  docType: 'receipt';
  kind: DocumentKind;
  merchant: string;
  storeRef?: string;
  purchasedOn: string;
  purchasedTime?: string;
  items: ParsedReceiptItem[];
  /** Basket-level discounts (loyalty offers), as a negative number of cents. */
  discountCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  savingsCents: number;
  paymentMethod?: string;
  cardLast4?: string;
  checks: ReconciliationCheck[];
  warnings: string[];
}

export type ParsedDocument = ParsedStatement | ParsedReceipt;

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export function check(label: string, expected: number, actual: number, unit: 'cents' | 'count' = 'cents'): ReconciliationCheck {
  return { label, unit, expected, actual, ok: expected === actual };
}
