import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ParseError } from './types.ts';

export interface PdfTextItem {
  x: number;
  text: string;
}

/** One visual line of a page: every text run sharing a baseline, left to right. */
export interface PdfRow {
  page: number;
  y: number;
  items: PdfTextItem[];
  text: string;
}

const MAX_PAGES = 60;
const BASELINE_TOLERANCE = 2.5;

/**
 * Extracts the text layer as positioned rows. Statements are tables without
 * ruling lines, so the x coordinate of each run is what identifies its column;
 * plain text extraction loses exactly that.
 *
 * The PDF is untrusted input: only the text layer is read (no rendering, no
 * font loading, no XFA forms)
 * and the page count is capped.
 */
export async function extractPdfRows(bytes: Uint8Array): Promise<PdfRow[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes), // pdf.js takes ownership of the buffer it is given
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error';
    throw new ParseError(`The file is not a readable PDF (${reason}).`);
  }

  try {
    if (doc.numPages > MAX_PAGES) {
      throw new ParseError(`PDF has ${doc.numPages} pages; the limit is ${MAX_PAGES}.`);
    }
    const rows: PdfRow[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const byBaseline: Array<{ y: number; items: PdfTextItem[] }> = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const text = item.str.trim();
        if (!text) continue;
        const x = item.transform[4] as number;
        const y = item.transform[5] as number;
        let row = byBaseline.find((r) => Math.abs(r.y - y) <= BASELINE_TOLERANCE);
        if (!row) {
          row = { y, items: [] };
          byBaseline.push(row);
        }
        row.items.push({ x, text });
      }
      byBaseline.sort((a, b) => b.y - a.y); // PDF y grows upward
      for (const row of byBaseline) {
        row.items.sort((a, b) => a.x - b.x);
        rows.push({ page: pageNumber, y: row.y, items: row.items, text: row.items.map((i) => i.text).join(' ') });
      }
    }
    return rows;
  } finally {
    await loadingTask.destroy();
  }
}

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-" magic number, allowing for a short preamble some generators emit.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}
