#!/usr/bin/env node
/**
 * privacy-guard: blocks commits that would put financial documents, personal
 * identifiers or credentials into the repository.
 *
 *   node scripts/privacy-guard.mjs            scan what is staged (pre-commit hook)
 *   node scripts/privacy-guard.mjs --all      scan every tracked file (pre-push hook, CI)
 *
 * It has no dependencies, so it runs before `npm install` and cannot be
 * disabled by a broken node_modules. It reads staged content from the git
 * index, not the working tree, so what it checks is exactly what would be
 * committed. Findings never print the matched secret, only a masked preview.
 *
 * Three kinds of check:
 *   1. file type  - statements, exports, databases, key files and photos are
 *                   refused by extension unless they live in an allowlisted
 *                   synthetic-fixture or screenshot folder
 *   2. content    - API keys and tokens, private key blocks, payment card
 *                   numbers (Luhn-validated), Canadian SINs
 *   3. denylist   - your own strings (address, account digits, loyalty number)
 *                   from the git-ignored .privacy-denylist file
 *
 * A line can opt out with the comment `privacy-guard: allow`, which shows up
 * in review.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOW_PRAGMA = 'privacy-guard: allow';

/** Folders whose contents are generated or reviewed to be free of real data. */
const ALLOWED_DATA_PATHS = [/(^|\/)fixtures\/synthetic\//, /^docs\/screenshots\/[^/]+\.(png|webp)$/, /^web\/public\//];

const BLOCKED_EXTENSIONS = new Map(
  Object.entries({
    'financial document': ['pdf', 'eml', 'msg', 'mbox', 'ofx', 'qfx', 'qif'],
    'data export': ['csv', 'tsv', 'xlsx', 'xls', 'ods'],
    'database file': ['db', 'sqlite', 'sqlite3', 'db-wal', 'db-shm'],
    'archive': ['zip', '7z', 'rar', 'tar', 'gz'],
    'photo or scan': ['jpg', 'jpeg', 'png', 'heic', 'webp', 'tif', 'tiff', 'bmp'],
    'key or certificate': ['pem', 'key', 'p12', 'pfx', 'jks', 'keystore'],
  }).flatMap(([reason, extensions]) => extensions.map((ext) => [ext, reason])),
);

const BLOCKED_NAMES = [
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, 'environment file'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/, 'SSH key'],
  [/(^|\/)(credentials|client_secret|token)[^/]*\.json$/i, 'credential file'],
  [/(^|\/)\.privacy-denylist$/, 'personal denylist'],
  [/(^|\/)\.npmrc$/, 'npm config (may hold a registry token)'],
];

const SECRET_PATTERNS = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['AWS access key ID', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g],
  ['Postman API key', /\bPMAK-[A-Za-z0-9]{24}-[A-Za-z0-9]{34}\b/g],
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
  ['bearer token in a URL', /[?&](?:access_token|api_key|apikey|token)=[A-Za-z0-9._-]{20,}/gi],
];

// name = "value" assignments where the value looks random rather than descriptive.
const ASSIGNMENT = /\b(?:api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["'`]([^"'`\s]{20,})["'`]/gi;
const PLACEHOLDER = /example|placeholder|changeme|your[-_]|redacted|dummy|sample|xxxx|\$\{|<[^>]+>|^[a-z-]+$/i;

export function shannonEntropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

export function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** True for a number that has a real card network prefix, a valid length and a valid check digit. */
export function looksLikeCardNumber(candidate) {
  const digits = candidate.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  const network = /^(?:4\d{12}(?:\d{3})?(?:\d{3})?|5[1-5]\d{14}|2(?:2[2-9]|[3-6]\d|7[01])\d{13}|3[47]\d{13}|6(?:011|5\d\d)\d{12})$/;
  return network.test(digits) && luhnValid(digits);
}

function mask(value) {
  const text = String(value);
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(12, text.length - 6))}${text.slice(-2)}`;
}

/** File-level reasons to refuse a path regardless of its content. */
export function checkPath(file) {
  const normalized = file.replaceAll('\\', '/');
  for (const [pattern, reason] of BLOCKED_NAMES) {
    if (pattern.test(normalized)) return `${reason} must not be committed`;
  }
  if (ALLOWED_DATA_PATHS.some((pattern) => pattern.test(normalized))) return null;
  const name = path.posix.basename(normalized).toLowerCase();
  const extension = name.includes('.') ? name.slice(name.indexOf('.') + 1) : '';
  const reason = BLOCKED_EXTENSIONS.get(extension) ?? BLOCKED_EXTENSIONS.get(extension.split('.').pop() ?? '');
  return reason ? `${reason} (.${extension.split('.').pop()}) outside an allowlisted synthetic folder` : null;
}

/** Scans text and returns findings as { line, rule, preview }. */
export function scanText(text, denylist = []) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const lowerDeny = denylist.map((term) => term.toLowerCase()).filter((term) => term.length >= 3);

  lines.forEach((line, index) => {
    if (line.includes(ALLOW_PRAGMA)) return;
    const add = (rule, value) => findings.push({ line: index + 1, rule, preview: mask(value) });

    for (const [rule, pattern] of SECRET_PATTERNS) {
      for (const match of line.matchAll(pattern)) add(rule, match[0]);
    }
    for (const match of line.matchAll(ASSIGNMENT)) {
      const value = match[1];
      if (!PLACEHOLDER.test(value) && shannonEntropy(value) >= 3.6) add('hard-coded credential', value);
    }
    for (const match of line.matchAll(/(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d.])/g)) {
      if (looksLikeCardNumber(match[0])) add('payment card number', match[0]);
    }
    for (const match of line.matchAll(/(?<![\d-])\d{3}[ -]\d{3}[ -]\d{3}(?![\d-])/g)) {
      const digits = match[0].replace(/[ -]/g, '');
      if (luhnValid(digits) && !/^(\d)\1+$/.test(digits)) add('Canadian SIN', match[0]);
    }
    if (lowerDeny.length) {
      const lower = line.toLowerCase();
      for (const term of lowerDeny) {
        if (lower.includes(term)) add('personal denylist term', term);
      }
    }
  });
  return findings;
}

export function loadDenylist(root) {
  const file = path.join(root, '.privacy-denylist');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// --- CLI ----------------------------------------------------------------------

function git(args, options = {}) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, ...options });
}

function listFiles(mode) {
  const out = mode === 'all'
    ? git(['ls-files', '-z'])
    : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return out.toString('utf8').split('\0').filter(Boolean);
}

function readBlob(mode, file) {
  // ":path" is the staged version; for --all the committed-or-staged index entry is also what matters.
  try {
    return git(['show', `:${file}`]);
  } catch {
    return mode === 'all' && existsSync(file) ? readFileSync(file) : null;
  }
}

function main(argv) {
  const mode = argv.includes('--all') ? 'all' : 'staged';
  const root = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
  process.chdir(root);
  const denylist = loadDenylist(root);
  const files = listFiles(mode);
  const problems = [];

  for (const file of files) {
    const pathProblem = checkPath(file);
    if (pathProblem) {
      problems.push(`${file}\n    ${pathProblem}`);
      continue;
    }
    for (const term of denylist) {
      if (term.length >= 3 && file.toLowerCase().includes(term.toLowerCase())) {
        problems.push(`${file}\n    file name contains a personal denylist term (${mask(term)})`);
      }
    }
    const blob = readBlob(mode, file);
    if (!blob) continue;
    if (blob.length > MAX_FILE_BYTES) {
      problems.push(`${file}\n    ${(blob.length / 1024 / 1024).toFixed(1)} MB is larger than any source file should be`);
      continue;
    }
    const isBinary = blob.subarray(0, 8000).includes(0);
    if (isBinary || blob.length > MAX_TEXT_BYTES) continue;
    for (const finding of scanText(blob.toString('utf8'), denylist)) {
      problems.push(`${file}:${finding.line}\n    ${finding.rule}: ${finding.preview}`);
    }
  }

  if (problems.length) {
    console.error(`\nprivacy-guard blocked this ${mode === 'all' ? 'push' : 'commit'}: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      '\nNothing was committed. Remove the file or value (real data belongs in data/, which is git-ignored).\n' +
        `If a line is a deliberate false positive, add the comment "${ALLOW_PRAGMA}" to it.\n`,
    );
    return 1;
  }
  const scope = mode === 'all' ? 'tracked' : 'staged';
  console.log(`privacy-guard: ${files.length} ${scope} file${files.length === 1 ? '' : 's'} clean${denylist.length ? `, ${denylist.length} personal terms checked` : ''}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    // Fail closed: if the guard cannot run, the commit does not go through.
    console.error(`privacy-guard could not run: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
