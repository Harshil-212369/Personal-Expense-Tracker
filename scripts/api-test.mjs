#!/usr/bin/env node
/**
 * Runs the Postman collection against a throwaway server:
 *
 *   npm run test:api
 *
 * It starts the API on a spare port with an empty database in the OS temp
 * directory, runs every request in postman/, then stops the server and deletes
 * the database. Your real data is never opened, so this is safe to run at any
 * time and gives the same result locally and in CI.
 *
 * Needs the Postman CLI on PATH (https://learning.postman.com/docs/postman-cli/postman-cli-installation/).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.API_TEST_PORT ?? 4010);
const baseUrl = `http://127.0.0.1:${port}`;
const workDir = mkdtempSync(path.join(tmpdir(), 'ledgerlens-api-test-'));

// A minimal environment: nothing from the developer's shell (API keys, a real
// DATABASE_PATH) can leak into the server under test.
const server = spawn(process.execPath, [path.join(root, 'server/src/index.ts')], {
  cwd: workDir, // no .env here either
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot, // Windows needs this to start a process
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    DATABASE_PATH: path.join(workDir, 'api-test.db'),
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
let serverExit = null;
server.once('exit', (code, signal) => {
  serverExit = { code, signal };
});

function waitFor(child) {
  return new Promise((resolve) => {
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code));
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (serverExit) throw new Error(`The server exited before it became healthy (code ${serverExit.code}).`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The server did not become healthy on ${baseUrl}.`);
}

async function cleanUp() {
  if (!serverExit) {
    const exited = waitFor(server);
    server.kill();
    await exited; // the database file is released once the process is gone
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

let exitCode = 1;
try {
  await waitForHealth();

  // The collection has no default baseUrl on purpose: it can only ever reach
  // the server named here, never one that happens to be running on the usual port.
  const environmentFile = path.join(workDir, 'environment.json');
  writeFileSync(environmentFile, JSON.stringify({ name: 'api-test', values: [{ key: 'baseUrl', value: baseUrl, enabled: true }] }));

  const postman = spawn(
    'postman',
    ['collection', 'run', 'postman/LedgerLens.postman_collection.json', '--environment', environmentFile, '--working-dir', root],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  const code = await waitFor(postman);
  if (code === null) console.error('\nCould not start the Postman CLI. Install it and make sure `postman` is on PATH.');
  if (serverExit) console.error(`\nThe server under test stopped during the run (code ${serverExit.code}, signal ${serverExit.signal}).`);
  exitCode = code === 0 && !serverExit ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  await cleanUp();
}
process.exit(exitCode);
