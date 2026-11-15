/**
 * Data minimization for anything sent to an LLM.
 *
 * Two independent steps, applied in order:
 *   1. `keepTransactionLines` drops every line that is not shaped like a
 *      transaction or a total. Name and address blocks have no amount on them,
 *      so they never leave the machine in the first place.
 *   2. `redact` masks identifiers that can still sit on a kept line: card and
 *      account numbers, emails, phone numbers, postal codes, and any personal
 *      terms configured in REDACT_TERMS.
 */

const MONEY = /-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\b/;
const DATE_TOKEN =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i;
const TOTAL_WORDS = /\b(?:total|balance|payments?|purchases?|credits?|interest|fees?|statement|period|from\b.+\bto)\b/i;

export function keepTransactionLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || line.length > 220) return false;
      const hasMoney = MONEY.test(line);
      const hasDate = DATE_TOKEN.test(line);
      return (hasMoney && hasDate) || ((hasMoney || hasDate) && TOTAL_WORDS.test(line));
    })
    .join('\n');
}

export interface RedactionResult {
  text: string;
  /** How many replacements each rule made, for the audit log. Never the values themselves. */
  counts: Record<string, number>;
}

const RULES: Array<[name: string, pattern: RegExp, replacement: string]> = [
  ['card', /\b\d{4}[ -]?(?:[\dXx*]{4}[ -]?){2}\d{1,4}\b/g, '[CARD]'],
  ['card', /\b(?:\d[ -]?){13,19}\b/g, '[CARD]'],
  ['masked-account', /[*Xx]{4,}\s?\d{2,4}\b/g, '[ACCOUNT]'],
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL]'],
  ['phone', /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, '[PHONE]'],
  ['postal-code', /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi, '[POSTAL]'],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(text: string, personalTerms: readonly string[] = []): RedactionResult {
  const counts: Record<string, number> = {};
  let out = text;
  const apply = (name: string, pattern: RegExp, replacement: string) => {
    out = out.replace(pattern, () => {
      counts[name] = (counts[name] ?? 0) + 1;
      return replacement;
    });
  };
  for (const term of personalTerms) {
    if (term.trim().length >= 3) apply('personal-term', new RegExp(escapeRegExp(term.trim()), 'gi'), '[REDACTED]');
  }
  for (const [name, pattern, replacement] of RULES) apply(name, pattern, replacement);
  return { text: out, counts };
}

/** The full pipeline applied to statement text before it is sent to the model. */
export function minimizeForModel(text: string, personalTerms: readonly string[] = []): RedactionResult {
  return redact(keepTransactionLines(text), personalTerms);
}
