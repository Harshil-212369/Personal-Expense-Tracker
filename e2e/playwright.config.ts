import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4020;
// A fresh, empty database for every run, outside the repository.
const DATABASE = path.join(tmpdir(), `ledgerlens-e2e-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DATABASE}${suffix}`, { force: true });

export default defineConfig({
  testDir: './tests',
  // The journey is one story told in order (import, then explore), so it runs serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // The real server, serving the production build of the UI.
    command: 'node ../server/src/index.ts',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: String(PORT), HOST: '127.0.0.1', DATABASE_PATH: DATABASE, LOG_LEVEL: 'warn', ANTHROPIC_API_KEY: '', API_TOKEN: '' },
  },
});
