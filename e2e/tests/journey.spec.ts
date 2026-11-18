import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * One user journey against the real server and the production UI build,
 * starting from an empty database: import two statements and a receipt, then
 * use every page. Only synthetic fixtures are used.
 */
const FIXTURES = path.join(import.meta.dirname, '../../server/test/fixtures/synthetic');
const fixture = (name: string) => path.join(FIXTURES, name);
const truth = JSON.parse(readFileSync(fixture('expected.json'), 'utf8')) as {
  september: { chargeCount: number; paymentCount: number; purchasesCents: number };
  october: { chargeCount: number; paymentCount: number; purchasesCents: number; periodStart: string; periodEnd: string };
  receipt: { itemCount: number; totalCents: number; firstItem: string };
};
const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test.describe.configure({ mode: 'serial' });

/**
 * Waits until a page has finished rendering its data: the heading is up and no
 * loading placeholder is left. More reliable than waiting for an idle network,
 * which Playwright discourages and which can stall on a busy CI runner.
 */
async function pageReady(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.skeleton')).toHaveCount(0);
}

async function importFile(page: Page, file: string) {
  await page.goto('/import');
  await page.getByTestId('file-input').setInputFiles(fixture(file));
}

test('a new user is guided to import instead of seeing empty charts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No transactions yet' })).toBeVisible();
  await page.getByRole('link', { name: 'Import a statement' }).click();
  await expect(page).toHaveURL(/\/import$/);
  await expect(page.getByText('Nothing imported yet.')).toBeVisible();
});

test('importing a statement previews it, verifies the totals, then stores it', async ({ page }) => {
  const rows = truth.september.chargeCount + truth.september.paymentCount;
  await importFile(page, 'statement-2026-09.pdf');

  const preview = page.getByRole('region', { name: 'Import preview' });
  await expect(preview.getByRole('heading', { name: 'CIBC credit card statement (PDF)' })).toBeVisible();
  await expect(preview.getByText(/figures printed on the statement match what was read from it, to the cent/)).toBeVisible();
  await expect(preview.getByRole('list', { name: 'Reconciliation checks' }).getByRole('listitem')).not.toHaveCount(0);
  // Nothing is stored until the person confirms.
  expect((await (await page.request.get('/api/health')).json()).counts.transactions).toBe(0);

  await preview.getByRole('button', { name: `Import ${rows} transactions` }).click();
  await expect(page.getByText(`Imported ${rows} transactions.`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Import history' }).getByText('Verified')).toBeVisible();
});

test('importing the same file again is recognized', async ({ page }) => {
  await importFile(page, 'statement-2026-09.pdf');
  await expect(page.getByText('This exact file was imported before. Nothing to do.')).toBeVisible();
});

test('a second statement and a receipt link up automatically', async ({ page }) => {
  const rows = truth.october.chargeCount + truth.october.paymentCount;
  await importFile(page, 'statement-2026-10.pdf');
  await page.getByRole('button', { name: `Import ${rows} transactions` }).click();
  await expect(page.getByText(`Imported ${rows} transactions.`)).toBeVisible();

  await importFile(page, 'metro-receipt.eml');
  const preview = page.getByRole('region', { name: 'Import preview' });
  await expect(preview.getByRole('heading', { name: 'Metro receipt email' })).toBeVisible();
  await expect(preview.getByText(truth.receipt.firstItem)).toBeVisible();
  await preview.getByRole('button', { name: `Import ${truth.receipt.itemCount} items` }).click();
  await expect(page.getByText('1 receipt matched to a statement line.')).toBeVisible();
});

test('the dashboard reports what the latest statement cost', async ({ page }) => {
  await page.goto('/');
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary.getByText(dollars(truth.october.purchasesCents))).toBeVisible();
  // September is on file, so October is compared with it.
  await expect(summary.getByText(new RegExp(`vs \\${dollars(truth.september.purchasesCents)}`))).toBeVisible();
  await expect(page.getByRole('button', { name: /Latest statement/ })).toBeVisible();

  for (const title of ['What stands out', 'Spending pace', 'Where it went', 'Day by day', 'Top merchants', 'Calendar', 'By weekday', 'Recurring charges']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  // Two statements a month apart are enough to detect a subscription.
  await expect(page.getByRole('region', { name: 'Recurring charges' }).getByText('Anthropic')).toBeVisible();
});

test('changing the period updates every figure and the URL', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Latest statement/ }).click();
  await page.getByRole('button', { name: /All time/ }).click();
  await expect(page.getByRole('region', { name: 'Summary' }).getByText(dollars(truth.september.purchasesCents + truth.october.purchasesCents))).toBeVisible();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);

  // The period survives a reload because it lives in the address.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Summary' }).getByText(dollars(truth.september.purchasesCents + truth.october.purchasesCents))).toBeVisible();
});

test('every chart can be read as a table and by keyboard', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Where it went' });
  await card.getByRole('button', { name: 'Show as table' }).click();
  await expect(card.getByRole('table')).toBeVisible();
  await expect(card.getByRole('columnheader', { name: 'Share' })).toBeVisible();

  const pace = page.getByRole('img', { name: /Cumulative spending by day/ });
  await pace.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('status').filter({ hasText: 'Day 1' })).toBeVisible();
});

test('a category bar opens its transactions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('region', { name: 'Where it went' }).getByRole('listitem', { name: /^Groceries:/ }).click();
  await expect(page).toHaveURL(/\/transactions\?.*categoryId=\d+/);
  await expect(page.getByRole('combobox', { name: 'Category', exact: true })).toHaveValue(/\d+/);
  const categories = page.locator('tbody select');
  await expect(categories.first()).toBeVisible();
  for (const select of await categories.all()) {
    await expect(select.locator('option:checked')).toHaveText('Groceries');
  }
});

test('a statement line opens the itemized receipt behind it', async ({ page }) => {
  await page.goto('/transactions');
  await page.getByRole('searchbox').fill('metro');
  await page.getByRole('button', { name: 'Receipt' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Receipt' });
  await expect(drawer.getByText('Verified: the items, discounts and tax add up to the printed total.')).toBeVisible();
  await expect(drawer.getByText(truth.receipt.firstItem)).toBeVisible();
  await expect(drawer.getByText(dollars(truth.receipt.totalCents)).last()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('correcting one category becomes a rule for every transaction from that merchant', async ({ page }) => {
  await page.goto('/transactions');
  await page.getByRole('searchbox').fill('tim hortons');
  const first = page.locator('tbody tr').first();
  await expect(first).toContainText('Tim Hortons');
  await first.getByRole('combobox').selectOption({ label: 'Gifts & Donations' });
  await expect(page.getByText('Tim Hortons moved to Gifts & Donations.')).toBeVisible();

  await page.getByRole('button', { name: 'Always do this for Tim Hortons' }).click();
  await expect(page.getByText(/Rule saved\. \d+ transactions? updated\./)).toBeVisible();
  for (const select of await page.locator('tbody select').all()) {
    await expect(select.locator('option:checked')).toHaveText('Gifts & Donations');
  }

  await page.goto('/rules');
  const row = page.getByRole('row', { name: /Tim Hortons/ });
  await expect(row.getByText('Yours')).toBeVisible();
  await row.getByRole('button', { name: 'Remove rule Tim Hortons' }).click();
  await expect(page.getByText(/Rule removed\./)).toBeVisible();
});

test('a manual transaction is validated before it is saved', async ({ page }) => {
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Add transaction' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add transaction' });
  await dialog.getByRole('button', { name: 'Add transaction' }).click();
  await expect(dialog.getByText('Enter an amount such as 12.50.')).toBeVisible();

  await dialog.getByLabel('Where').fill('Farmers market');
  await dialog.getByLabel('Amount').fill('18.25');
  await dialog.getByRole('button', { name: 'Add transaction' }).click();
  await expect(page.getByText('Transaction added.')).toBeVisible();
  await page.getByRole('searchbox').fill('farmers');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr').first()).toContainText('$18.25');
});

test('the receipts page itemizes what was bought', async ({ page }) => {
  await page.goto('/receipts');
  await expect(page.getByRole('region', { name: 'Receipt totals' }).getByText('All matched to a statement line')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What you buy most' })).toBeVisible();
  await page.getByRole('button', { name: 'View items' }).click();
  await expect(page.getByRole('dialog', { name: 'Receipt' }).getByText('Subtotal')).toBeVisible();
});

// One test per page, so each gets its own time budget and a failure names the page.
for (const route of ['/', '/transactions', '/receipts', '/import', '/rules']) {
  test(`${route} has no serious accessibility violations, in light and dark themes`, async ({ page }) => {
    await page.goto(route);
    await pageReady(page);
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => { document.documentElement.dataset['theme'] = t; }, theme);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${route} [${theme}] ${v.id}: ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
    }
  });
}

test('the layout holds on a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['/', '/transactions', '/import']) {
    await page.goto(route);
    await pageReady(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test('undoing an import removes exactly what it added', async ({ page }) => {
  const before = (await (await page.request.get('/api/health')).json()).counts;
  await page.goto('/import');
  page.once('dialog', (dialog) => dialog.accept());
  const history = page.getByRole('region', { name: 'Import history' });
  await history.getByRole('row', { name: /Metro receipt email/ }).getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByText('Import removed, along with everything it added.')).toBeVisible();
  await expect(history.getByRole('row', { name: /Metro receipt email/ })).toHaveCount(0);

  const after = (await (await page.request.get('/api/health')).json()).counts;
  expect(after.receipts).toBe(before.receipts - 1);
  expect(after.transactions).toBe(before.transactions); // the statement line stays; only the receipt goes
});

test('the server refuses what a browser on another site could send', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(health.headers()['x-powered-by']).toBeUndefined();

  const forged = await request.post('/api/transactions', {
    headers: { Origin: 'https://attacker.example' },
    data: { txnDate: '2026-10-05', description: 'forged', amountCents: 100 },
  });
  expect(forged.status()).toBe(403);
});
