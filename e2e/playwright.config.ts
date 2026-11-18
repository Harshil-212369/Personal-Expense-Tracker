import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The journey runs once per browser engine: Chromium (Chrome, Edge), Firefox
 * and WebKit (Safari). The journey imports files in order and starts from an
 * empty ledger, so each browser gets its own server on its own port with its
 * own temporary database. That keeps the runs independent, which lets them run
 * in parallel.
 */
const BROWSERS = [
  { name: 'chromium', device: devices['Desktop Chrome'], port: 4020 },
  { name: 'firefox', device: devices['Desktop Firefox'], port: 4021 },
  { name: 'webkit', device: devices['Desktop Safari'], port: 4022 },
] as const;

function freshDatabase(name: string): string {
  const file = path.join(tmpdir(), `ledgerlens-e2e-${name}-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  return file;
}

export default defineConfig({
  testDir: './tests',
  // Within one browser the journey is a story told in order (import, then explore).
  fullyParallel: false,
  // One worker per browser: the three journeys run side by side.
  workers: BROWSERS.length,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
  },
  projects: BROWSERS.map(({ name, device, port }) => ({
    name,
    use: { ...device, viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${port}` },
  })),
  webServer: BROWSERS.map(({ name, port }) => ({
    // The real server, serving the production build of the UI.
    command: 'node ../server/src/index.ts',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_PATH: freshDatabase(name),
      LOG_LEVEL: 'warn',
      ANTHROPIC_API_KEY: '',
      API_TOKEN: '',
    },
  })),
});
