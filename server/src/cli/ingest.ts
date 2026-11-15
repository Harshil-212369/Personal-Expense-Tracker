/**
 * Bulk import from the command line:
 *
 *   npm run ingest -- <file-or-folder> [more...] [--dry-run] [--ai]
 *
 * With no path it reads ./data/inbox, a git-ignored drop folder. Files are
 * read where they are and never copied into the repository.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createAnthropicGateway } from '../ai/gateway.ts';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/database.ts';
import { HttpError } from '../lib/errors.ts';
import { formatCents } from '../lib/money.ts';
import { importFile } from '../services/importer.ts';

for (const file of ['.env', '../.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const SUPPORTED = new Set(['.pdf', '.csv', '.eml']);
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const useAi = args.includes('--ai');
const inputs = args.filter((a) => !a.startsWith('--'));
if (inputs.length === 0) inputs.push(path.resolve('data/inbox'));

function collect(target: string): string[] {
  if (!existsSync(target)) {
    console.error(`  ! not found: ${target}`);
    return [];
  }
  if (statSync(target).isDirectory()) {
    return readdirSync(target)
      .sort()
      .map((name) => path.join(target, name))
      .filter((file) => statSync(file).isFile() && SUPPORTED.has(path.extname(file).toLowerCase()));
  }
  return [target];
}

const config = loadConfig();
const db = openDatabase(config.databasePath);
const ai = createAnthropicGateway(config);
const files = inputs.flatMap(collect);

if (files.length === 0) {
  console.log('Nothing to import. Pass a file or folder, or drop statements into data/inbox/.');
  process.exit(0);
}

let failures = 0;
for (const file of files) {
  try {
    const result = await importFile(
      { db, ai, redactTerms: config.redactTerms },
      { bytes: new Uint8Array(readFileSync(file)), filename: path.basename(file), dryRun, parser: useAi ? 'ai' : 'auto' },
    );
    const verified = result.reconciled === null ? 'no totals to verify' : result.reconciled ? 'reconciled' : 'NOT RECONCILED';
    console.log(
      `${result.status.padEnd(9)} ${result.kind.padEnd(20)} ${String(result.rowsInserted).padStart(4)} new, ` +
        `${String(result.rowsDuplicate).padStart(3)} duplicate  [${verified}]` +
        (result.receiptsLinked ? `  ${result.receiptsLinked} receipt(s) linked` : ''),
    );
    for (const c of result.checks.filter((c) => !c.ok)) {
      const show = (n: number) => (c.unit === 'cents' ? formatCents(n) : String(n));
      console.log(`            ! ${c.label}: printed ${show(c.expected)}, parsed ${show(c.actual)}`);
    }
  } catch (error) {
    failures++;
    const reason = error instanceof HttpError ? error.message : error instanceof Error ? error.message : String(error);
    console.error(`failed    ${path.extname(file)} file: ${reason}`);
  }
}
db.close();
process.exit(failures ? 1 : 0);
