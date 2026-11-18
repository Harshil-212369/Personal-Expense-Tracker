import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const OUT = path.join(import.meta.dirname, '../../docs/screenshots');
const FIXTURES = path.join(import.meta.dirname, '../../server/test/fixtures/synthetic');

async function settle(page: Page) {
  await expect(page.locator('.skeleton')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

test('dashboard, light and dark', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Spending pace' })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: path.join(OUT, 'dashboard.png'), fullPage: true });

  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.screenshot({ path: path.join(OUT, 'dashboard-dark.png') });
});

test('import preview with reconciliation', async ({ page }) => {
  await page.goto('/import');
  await page.getByTestId('file-input').setInputFiles(path.join(FIXTURES, 'statement-2026-10.pdf'));
  await expect(page.getByText(/match what was read from it/)).toBeVisible();
  await settle(page);
  await page.screenshot({ path: path.join(OUT, 'import.png') });
});

test('transactions with a receipt open', async ({ page }) => {
  await page.goto('/transactions');
  await page.getByRole('searchbox').fill('metro');
  await page.getByRole('button', { name: 'Receipt' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Receipt' }).getByText('Subtotal')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: path.join(OUT, 'receipt.png') });
});
