import { looksLikeCibcCreditStatement, parseCibcCreditStatement } from './cibcCreditPdf.ts';
import { looksLikeCibcCsv, parseCibcCsv, parseGenericCsv } from './csv.ts';
import { looksLikeEmail, looksLikeMetroReceipt, parseMetroReceipt, readEmail } from './metroReceiptEmail.ts';
import { extractPdfRows, isPdf } from './pdfText.ts';
import type { PdfRow } from './pdfText.ts';
import { ParseError } from './types.ts';
import type { ParsedDocument } from './types.ts';

/**
 * Raised when the file type is supported but no deterministic parser knows
 * this layout. It carries the extracted text so the caller can offer the
 * opt-in AI reader without parsing the file a second time.
 */
export class UnknownLayoutError extends ParseError {
  readonly extractedText: string;
  constructor(message: string, extractedText: string) {
    super(message);
    this.name = 'UnknownLayoutError';
    this.extractedText = extractedText;
  }
}

export function rowsToText(rows: PdfRow[]): string {
  return rows.map((r) => r.text).join('\n');
}

/**
 * Identifies a document from its content (never from its file name or the
 * client's MIME type) and runs the matching parser.
 */
export async function parseDocument(bytes: Uint8Array): Promise<ParsedDocument> {
  if (bytes.length === 0) throw new ParseError('The file is empty.');

  if (isPdf(bytes)) {
    const rows = await extractPdfRows(bytes);
    if (rows.length === 0) {
      throw new ParseError('This PDF has no text layer (it may be a scan), so it cannot be read.');
    }
    if (looksLikeCibcCreditStatement(rows)) return parseCibcCreditStatement(rows);
    throw new UnknownLayoutError('This PDF is not a statement layout LedgerLens knows yet.', rowsToText(rows));
  }

  // Everything else must be text. Reject binaries early.
  const sample = bytes.subarray(0, 2048);
  if (sample.includes(0)) throw new ParseError('Unsupported file type. Upload a PDF statement, a CSV export or an .eml receipt.');

  if (looksLikeEmail(bytes)) {
    const email = await readEmail(bytes);
    if (looksLikeMetroReceipt(email)) return parseMetroReceipt(email);
    throw new UnknownLayoutError('This email is not a receipt format LedgerLens knows yet.', email.lines.join('\n'));
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  if (looksLikeCibcCsv(text)) return parseCibcCsv(text);
  return parseGenericCsv(text);
}

export { ParseError } from './types.ts';
export type * from './types.ts';
