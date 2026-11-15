/**
 * Bank descriptions are noisy: "SQ *CORNER CAFE 8005550100", "PRESTO MOBI/SQFH8DMVBP",
 * "TIM HORTONS #8397". Analytics need one stable name per merchant, so this
 * strips processor prefixes, store numbers and reference codes, then applies a
 * small alias table for brands that print several ways.
 */

const PROCESSOR_PREFIX = /^(?:SQ|TST|SP|PP|PAYPAL|PY|IN|DD|CKE)\s*\*\s*/i;

const BRAND_ALIASES: Array<[RegExp, string]> = [
  [/^PRESTO\b/i, 'PRESTO'],
  [/\bWAL-?MART\b/i, 'Walmart'],
  [/\bNO ?FRILLS\b/i, 'No Frills'],
  [/\bTIM HORTONS?\b/i, 'Tim Hortons'],
  [/\bMCDONALD'?S?\b/i, "McDonald's"],
  [/\bSTARBUCKS\b/i, 'Starbucks'],
  [/\bUBER\s*\*?\s*EATS\b/i, 'Uber Eats'],
  [/^UBER\b/i, 'Uber'],
  [/^LYFT\b/i, 'Lyft'],
  [/\bAMAZON|AMZN\b/i, 'Amazon'],
  [/\bSHOPPERS DRUG\b/i, 'Shoppers Drug Mart'],
  [/^ANTHROPIC\b/i, 'Anthropic'],
  [/^SPOTIFY\b/i, 'Spotify'],
  [/^NETFLIX\b/i, 'Netflix'],
  [/^GOOGLE\b.*\bONE\b/i, 'Google One'],
  [/^APPLE\.COM/i, 'Apple'],
  [/^IKEA\b/i, 'IKEA'],
  [/^(?:CPC|CANADA POST)\b/i, 'Canada Post'],
];

const KEEP_UPPER = new Set(['TTC', 'UPS', 'KFC', 'IKEA', 'LCBO', 'BMO', 'RBC', 'TD', 'A&W', 'H&M', 'T&T', 'PRESTO', 'GO']);

/** A token that is an identifier rather than part of the name: 60030, C02329, P47D45BEA5. */
function isReferenceCode(token: string): boolean {
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits === 0) return false;
  if (/^\d+$/.test(token)) return true;
  if (/^\*+\d+$/.test(token)) return true;
  return token.length >= 5 && digits >= 2 && /^[A-Z0-9-]+$/i.test(token);
}

function titleCase(word: string): string {
  // Known acronyms and short all-caps codes ("HF", "TMU") stay as printed.
  if (KEEP_UPPER.has(word.toUpperCase()) || /^[A-Z]{2,3}$/.test(word)) return word.toUpperCase();
  return word
    .toLowerCase()
    .replace(/(^|[-'’/&.])([a-z])/g, (_m, sep: string, ch: string) =>
      // "Nick's" keeps its lowercase s; other separators start a new capital.
      sep === "'" || sep === '’' ? sep + ch : sep + ch.toUpperCase(),
    );
}

export function normalizeMerchant(rawDescription: string): string {
  let text = rawDescription.replace(/\s+/g, ' ').trim();
  if (!text) return 'Unknown';
  text = text.replace(PROCESSOR_PREFIX, '');

  for (const [pattern, name] of BRAND_ALIASES) {
    if (pattern.test(text)) return name;
  }

  // "MERCHANT*DETAIL": keep the detail only when it reads like a product name.
  const star = text.indexOf('*');
  if (star > 0) {
    const left = text.slice(0, star).trim();
    const right = text.slice(star + 1).trim();
    const rightIsNoise =
      !right || right.split(' ').every(isReferenceCode) || /\b(?:AUTH|HOLD|PENDING|PAYMENT)\b/i.test(right);
    if (rightIsNoise) text = left;
    else if (right.toUpperCase().startsWith(left.toUpperCase())) text = right;
    else text = `${left} ${right}`;
  }

  text = text
    .replace(/\.(?:com|ca|net|org)\b/gi, ' ') // "SHOP.COM" -> "SHOP"
    .replace(/\*{2,}\d*/g, ' ') // masked account numbers
    .replace(/#\s*\d+/g, ' ') // store numbers
    .replace(/\/\S*\d\S*/g, ' ') // "/SQFH8DMVBP" reference suffixes
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' '); // phone numbers

  const tokens = text
    .split(/[\s-]+/) // "CAMPUS-FOOD-27061" -> "CAMPUS", "FOOD", "27061"
    .map((t) => t.replace(/^[–.,]+|[–.,]+$/g, ''))
    .filter((t) => t && !isReferenceCode(t));
  // A 25-character statement field often cuts the name mid-word, leaving a stray letter.
  if (tokens.length >= 3 && tokens.at(-1)!.length === 1) tokens.pop();

  const name = tokens.map(titleCase).join(' ').replace(/\s+/g, ' ').trim();
  return name || titleCase(rawDescription.trim().split(/\s+/)[0] ?? 'Unknown');
}

/** Lowercase alphanumerics only: the comparison key for fingerprints and matching. */
export function merchantKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}
