import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Regenerates docs/screenshots from the synthetic demo database:
 *
 *   npm run screenshots -w e2e
 *
 * Screenshots are only ever taken here, against invented data, so an image in
 * the repository can never show a real transaction.
 */
const PORT = 4021;

export default defineConfig({
  testDir: './screenshots',
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
  },
  webServer: {
    command: 'node ../server/scripts/demo.ts',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT), HOST: '127.0.0.1', DEMO_DATABASE_PATH: path.join(tmpdir(), `ledgerlens-screenshots-${process.pid}.db`), LOG_LEVEL: 'warn', ANTHROPIC_API_KEY: '', API_TOKEN: '' },
  },
});
