#!/usr/bin/env node
/**
 * Fails the build on any high or critical advisory in the dependency tree,
 * except advisories listed in audit-exceptions.json.
 *
 *   node scripts/audit-gate.mjs
 *
 * `npm audit` has no way to accept a single advisory, so the only built-in
 * options when an advisory has no fix are to lower the threshold for every
 * package or to turn the check off. This script keeps the threshold and
 * accepts named advisories instead. Each exception has to give a reason and
 * an expiry date. Once that date passes, the build fails again until someone
 * looks at the advisory, so an exception can't be forgotten.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKING = new Set(['high', 'critical']);
const today = new Date().toISOString().slice(0, 10);

const exceptions = JSON.parse(readFileSync(path.join(root, 'audit-exceptions.json'), 'utf8')).exceptions;
for (const e of exceptions) {
  if (!/^GHSA-[\w-]+$/.test(e.id) || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) {
    console.error(`audit-exceptions.json: every entry needs a GHSA id, a reason and an expires date (YYYY-MM-DD). Bad entry: ${JSON.stringify(e)}`);
    process.exit(2);
  }
}

let report;
try {
  // A fixed command string with no user input, so running it through the shell is safe (and lets Windows find npm.cmd).
  report = execSync('npm audit --json', { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
  report = error.stdout;
  if (!report) throw error;
}

/** Every distinct advisory in the report, with the packages it reaches. */
const advisories = new Map();
for (const [pkg, entry] of Object.entries(JSON.parse(report).vulnerabilities ?? {})) {
  for (const via of entry.via) {
    if (typeof via !== 'object') continue; // a string means "inherited from that package", already counted there
    const id = via.url?.split('/').pop() ?? String(via.source);
    const known = advisories.get(id) ?? { id, title: via.title, severity: via.severity, packages: new Set() };
    known.packages.add(pkg);
    advisories.set(id, known);
  }
}

let failed = false;
for (const advisory of advisories.values()) {
  if (!BLOCKING.has(advisory.severity)) continue;
  const exception = exceptions.find((e) => e.id === advisory.id);
  const where = [...advisory.packages].join(', ');
  if (!exception) {
    console.error(`BLOCKED  ${advisory.severity} ${advisory.id}: ${advisory.title} (${where})`);
    failed = true;
  } else if (exception.expires < today) {
    console.error(`EXPIRED  exception for ${advisory.id} ran out on ${exception.expires}. Check for a fix, then update or remove it.`);
    failed = true;
  } else {
    console.log(`accepted ${advisory.severity} ${advisory.id} until ${exception.expires}: ${exception.reason}`);
  }
}

// An exception for an advisory that no longer appears should be deleted, not kept around.
for (const e of exceptions) {
  if (!advisories.has(e.id)) console.warn(`stale    exception for ${e.id} no longer matches anything in the tree; remove it from audit-exceptions.json`);
}

if (failed) {
  console.error('\nDependency audit failed. Upgrade the package, or add a reviewed, dated entry to audit-exceptions.json.');
  process.exit(1);
}
console.log(`audit gate passed: ${advisories.size} advisor${advisories.size === 1 ? 'y' : 'ies'} found, none blocking`);
