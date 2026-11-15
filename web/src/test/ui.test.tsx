import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import { RankedBars } from '../charts/RankedBars.tsx';
import { ChartCard } from '../components/ChartCard.tsx';
import { Delta, ToastProvider } from '../components/common.tsx';
import { PeriodPicker } from '../components/PeriodPicker.tsx';
import type { ImportResult, Transaction } from '../lib/api.ts';
import { buildPeriodOptions } from '../lib/periods.ts';

// --- A fake API ---------------------------------------------------------------

type Handler = (url: URL, init: RequestInit | undefined) => unknown;
const routes = new Map<string, Handler>();
const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];

function mockApi(method: string, path: string, handler: Handler | unknown) {
  routes.set(`${method} ${path}`, typeof handler === 'function' ? (handler as Handler) : () => handler);
}

beforeEach(() => {
  routes.clear();
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api/, '');
      calls.push({ method, path, search: url.search, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const handler = routes.get(`${method} ${path}`);
      if (!handler) {
        return new Response(JSON.stringify({ status: 404, detail: `No mock for ${method} ${path}` }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
      }
      const body = handler(url, init);
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderApp(path: string, ui: ReactNode = <App />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const CATEGORIES = [
  { id: 1, name: 'Groceries', kind: 'expense', isSystem: true, transactionCount: 2 },
  { id: 2, name: 'Dining & Coffee', kind: 'expense', isSystem: true, transactionCount: 1 },
  { id: 15, name: 'Uncategorized', kind: 'expense', isSystem: true, transactionCount: 0 },
];
const txn = (over: Partial<Transaction>): Transaction => ({
  id: 1, txnDate: '2026-10-05', postDate: null, description: 'TIM HORTONS #1021', merchant: 'Tim Hortons', location: 'TORONTO ON',
  amountCents: 475, type: 'purchase', categoryId: 2, categoryName: 'Dining & Coffee', categorySource: 'rule', bankCategory: 'Restaurants',
  notes: null, receiptId: null, importId: 1, accountId: 1, ...over,
});
const HEALTH = { status: 'ok', version: '1.0.0', ai: { enabled: false, model: null }, auth: 'none', counts: { transactions: 0, receipts: 0, imports: 0 } };

// --- Components ---------------------------------------------------------------

describe('Delta', () => {
  it('says the direction in words as well as color', () => {
    const { rerender } = render(<Delta ratio={0.22} />);
    expect(screen.getByText('+22%')).toBeInTheDocument();
    expect(screen.getByText('more than the previous period')).toBeInTheDocument();
    rerender(<Delta ratio={-0.22} />);
    expect(screen.getByText('less than the previous period')).toBeInTheDocument();
    rerender(<Delta ratio={null} />);
    expect(screen.queryByText(/previous period/)).not.toBeInTheDocument();
  });
});

describe('RankedBars', () => {
  it('prints every value and links each row to its transactions', () => {
    render(
      <MemoryRouter>
        <RankedBars
          showPrevious
          rows={[
            { key: 'a', name: 'Groceries', cents: 30000, note: '60%', previousCents: 20000, to: '/transactions?categoryId=1' },
            { key: 'b', name: 'Dining', cents: 20000, note: '40%' },
          ]}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole('listitem', { name: /Groceries: \$300\.00, 60%, previously \$200\.00/ });
    expect(link).toHaveAttribute('href', '/transactions?categoryId=1');
    expect(screen.getByText('$200.00')).toBeInTheDocument();
    expect(screen.getByText('Previous period')).toBeInTheDocument();
  });
});

describe('ChartCard', () => {
  it('offers the same data as a table', async () => {
    const user = userEvent.setup();
    render(
      <ChartCard title="Where it went" table={{ columns: ['Category', 'Spent'], rows: [['Groceries', '$300.00']], numeric: [1] }}>
        <p>chart goes here</p>
      </ChartCard>,
    );
    expect(screen.getByText('chart goes here')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show as table' }));
    expect(screen.queryByText('chart goes here')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByRole('cell', { name: '$300.00' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show chart' }));
    expect(screen.getByText('chart goes here')).toBeInTheDocument();
  });
});

describe('PeriodPicker', () => {
  const options = buildPeriodOptions(
    [{ id: 1, kind: 'cibc-credit-pdf', periodStart: '2026-09-22', periodEnd: '2026-10-21', rowsInserted: 55 }],
    { from: '2026-08-21', to: '2026-10-21' },
    '2026-11-15',
  );

  it('chooses a preset and closes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PeriodPicker range={options[0]!.range} options={options} selected={options[0]} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /Latest statement/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: /Last month/ }));
    expect(onChange).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-31' });
    expect(screen.queryByRole('group', { name: 'Choose a period' })).not.toBeInTheDocument();
  });

  it('applies a custom range and closes on Escape', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PeriodPicker range={{ from: '2026-10-01', to: '2026-10-31' }} options={options} selected={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Oct 1/ }));
    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-10-10');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({ from: '2026-10-10', to: '2026-10-31' });

    await user.click(screen.getByRole('button', { name: /Oct 1/ }));
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  });
});

// --- Pages --------------------------------------------------------------------

describe('Dashboard', () => {
  it('guides a first-time user to import instead of showing empty charts', async () => {
    mockApi('GET', '/health', HEALTH);
    mockApi('GET', '/imports', []);
    mockApi('GET', '/analytics/summary', { range: { from: '2026-10-17', to: '2026-11-15' }, dataBounds: null, totalCents: 0 });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'No transactions yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Import a statement/ })).toHaveAttribute('href', '/import');
    expect(calls.some((c) => c.path === '/analytics/categories')).toBe(false);
  });

  it('shows the headline figures for the latest statement', async () => {
    const range = { from: '2026-09-22', to: '2026-10-21' };
    mockApi('GET', '/health', HEALTH);
    mockApi('GET', '/imports', [{ id: 7, kind: 'cibc-credit-pdf', periodStart: range.from, periodEnd: range.to, rowsInserted: 64 }]);
    mockApi('GET', '/analytics/summary', (url: URL) => ({
      range, importId: 7, dataBounds: { from: '2026-08-22', to: '2026-10-21' }, totalCents: 129187, purchaseCount: 64, refundCents: 0, days: 30,
      activeDays: 26, avgPerDayCents: 4306, medianPurchaseCents: 1157,
      largest: { id: 9, merchant: 'IKEA', amountCents: 13415, txnDate: '2026-09-22' },
      previous: url.searchParams.get('importId') ? { range: { from: '2026-08-22', to: '2026-09-21' }, importId: 6, totalCents: 164909, purchaseCount: 67 } : null,
      changeRatio: -0.2166,
    }));
    mockApi('GET', '/analytics/categories', [{ categoryId: 2, name: 'Dining & Coffee', cents: 33038, count: 29, share: 0.26, previousCents: 30000 }]);
    mockApi('GET', '/analytics/timeseries', [
      { date: '2026-09-22', cents: 5000, count: 2, cumulativeCents: 5000 },
      { date: '2026-09-23', cents: 2500, count: 1, cumulativeCents: 7500 },
    ]);
    mockApi('GET', '/analytics/merchants', [{ merchant: 'IKEA', categoryName: 'Shopping', cents: 16204, count: 2, avgCents: 8102, lastDate: '2026-10-01' }]);
    mockApi('GET', '/analytics/calendar', { days: [{ date: '2026-09-22', cents: 5000, count: 2 }], weekdays: Array.from({ length: 7 }, (_u, weekday) => ({ weekday, cents: 100, count: 1, avgPerDayCents: 100 })) });
    mockApi('GET', '/analytics/anomalies', []);
    mockApi('GET', '/analytics/recurring', [{ merchant: 'Spotify', categoryName: 'Subscriptions & Software', typicalCents: 1242, occurrences: 2, intervalDays: 30, lastDate: '2026-10-09', nextExpected: '2026-11-09', annualCents: 14904 }]);
    mockApi('GET', '/analytics/insights', { source: 'rules', model: null, insights: [{ id: 'period-change', tone: 'down', title: 'Spending is down 22%', detail: 'Less than before.' }] });

    renderApp('/');
    expect(await screen.findByText('$1,291.87')).toBeInTheDocument();
    expect(screen.getByText('−22%')).toBeInTheDocument();
    expect(screen.getByText('Spending is down 22%')).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: /Dining & Coffee: \$330\.38/ })).toHaveAttribute('href', '/transactions?importId=7&categoryId=2');
    expect(await screen.findByText('Spotify')).toBeInTheDocument();
    expect(screen.getByText('$12.42 a month, $149.04 a year')).toBeInTheDocument();
    // No AI key on the server: the button that would send data to a model is not offered.
    expect(screen.queryByRole('button', { name: /Ask Claude/ })).not.toBeInTheDocument();
    // Every chart asked for the selected statement, and the pace chart for the one before it.
    expect(calls.filter((c) => c.path === '/analytics/categories')[0]!.search).toBe('?importId=7');
    await waitFor(() => expect(calls.some((c) => c.path === '/analytics/timeseries' && c.search === '?importId=6&granularity=day')).toBe(true));
  });
});

describe('Transactions', () => {
  beforeEach(() => {
    mockApi('GET', '/categories', CATEGORIES);
    mockApi('GET', '/transactions', { items: [txn({}), txn({ id: 2, merchant: 'Metro', description: 'METRO 9001', amountCents: 2961, categoryId: 1, categoryName: 'Groceries', receiptId: 7 })], total: 2, limit: 50, offset: 0 });
  });

  it('lists transactions and searches after a pause in typing', async () => {
    const user = userEvent.setup();
    renderApp('/transactions?from=2026-09-22&to=2026-10-21');
    expect(await screen.findByText('Tim Hortons')).toBeInTheDocument();
    expect(screen.getByText(/2 transactions · Sep 22/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Receipt/ })).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox'), 'metro');
    await waitFor(() => expect(calls.some((c) => c.path === '/transactions' && c.search.includes('q=metro'))).toBe(true));
    expect(calls.filter((c) => c.search.includes('q=m&') || c.search.endsWith('q=m')).length).toBe(0);
  });

  it('changing a category offers to turn the correction into a rule', async () => {
    const user = userEvent.setup();
    mockApi('PATCH', '/transactions/1', txn({ categoryId: 1, categoryName: 'Groceries', categorySource: 'manual' }));
    mockApi('POST', '/rules', { rule: { id: 5, pattern: 'Tim Hortons', categoryId: 1, categoryName: 'Groceries', source: 'user', priority: 300 }, recategorized: 4 });
    renderApp('/transactions');

    const select = await screen.findByRole('combobox', { name: /Category for Tim Hortons/ });
    await user.selectOptions(select, 'Groceries');
    expect(await screen.findByText('Tim Hortons moved to Groceries.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ categoryId: 1 });

    await user.click(screen.getByRole('button', { name: 'Always do this for Tim Hortons' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/rules')?.body).toEqual({ pattern: 'Tim Hortons', categoryId: 1 }));
    expect(await screen.findByText('Rule saved. 4 transactions updated.')).toBeInTheDocument();
  });

  it('validates a manual entry before sending it, then shows server field errors', async () => {
    const user = userEvent.setup();
    mockApi('POST', '/transactions', () => new Response(
      JSON.stringify({ status: 400, detail: 'The request did not match the expected shape.', errors: [{ field: 'txnDate', message: 'Expected a calendar date as YYYY-MM-DD' }] }),
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    ));
    renderApp('/transactions');
    await user.click(await screen.findByRole('button', { name: /Add transaction/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add transaction' });

    await user.click(within(dialog).getByRole('button', { name: 'Add transaction' }));
    expect(within(dialog).getByText('Say where the money went.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter an amount such as 12.50.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByLabelText('Where'), 'Farmers market');
    await user.type(within(dialog).getByLabelText('Amount'), '12.5');
    await user.click(within(dialog).getByRole('button', { name: 'Add transaction' }));
    expect(await within(dialog).findByText('Expected a calendar date as YYYY-MM-DD')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ description: 'Farmers market', amountCents: 1250 });
  });
});

describe('Import', () => {
  const preview = (over: Partial<ImportResult>): ImportResult => ({
    status: 'preview', importId: null, docType: 'statement', kind: 'cibc-credit-pdf', parser: 'deterministic', filename: 'october.pdf',
    periodStart: '2026-09-22', periodEnd: '2026-10-21', rowsParsed: 2, rowsInserted: 2, rowsDuplicate: 0, reconciled: true,
    checks: [{ label: 'Purchases, advances, interest and fees', unit: 'cents', expected: 3436, actual: 3436, ok: true }],
    warnings: [], receiptsLinked: 0,
    preview: [{ txnDate: '2026-10-05', description: 'TIM HORTONS #1021', merchant: 'Tim Hortons', amountCents: 475, type: 'purchase', categoryName: 'Dining & Coffee', duplicate: false }],
    ...over,
  });
  const file = new File(['%PDF-1.7'], 'october.pdf', { type: 'application/pdf' });

  beforeEach(() => {
    mockApi('GET', '/health', HEALTH);
    mockApi('GET', '/imports', []);
  });

  it('previews first, shows the reconciliation result, and imports only on confirmation', async () => {
    const user = userEvent.setup();
    mockApi('POST', '/imports', (url: URL) => (url.searchParams.get('dryRun') === 'true' ? preview({}) : preview({ status: 'imported', importId: 3 })));
    renderApp('/import');

    await user.upload(screen.getByTestId('file-input'), file);
    expect(await screen.findByText(/All 1 figures printed on the statement match/)).toBeInTheDocument();
    expect(screen.getByText('Tim Hortons')).toBeInTheDocument();
    const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/imports');
    expect(posts().map((c) => c.search)).toEqual(['?dryRun=true&parser=auto']);

    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }));
    expect(await screen.findByText('Imported 2 transactions.')).toBeInTheDocument();
    expect(posts().map((c) => c.search)).toEqual(['?dryRun=true&parser=auto', '?dryRun=false&parser=auto']);
  });

  it('warns loudly when the totals do not match', async () => {
    const user = userEvent.setup();
    mockApi('POST', '/imports', preview({ reconciled: false, checks: [{ label: 'Purchases', unit: 'cents', expected: 83826, actual: 83537, ok: false }] }));
    renderApp('/import');
    await user.upload(screen.getByTestId('file-input'), file);
    expect(await screen.findByRole('alert')).toHaveTextContent('Totals do not match.');
    expect(screen.getByText('printed $838.26, read $835.37')).toBeInTheDocument();
  });

  it('shows the server reason when a file cannot be read', async () => {
    const user = userEvent.setup();
    mockApi('POST', '/imports', () => new Response(JSON.stringify({ status: 422, detail: 'This PDF has no text layer (it may be a scan), so it cannot be read.' }), { status: 422, headers: { 'content-type': 'application/problem+json' } }));
    renderApp('/import');
    await user.upload(screen.getByTestId('file-input'), file);
    expect(await screen.findByRole('alert')).toHaveTextContent('no text layer');
    expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
  });

  it('does not offer the AI reader unless the server has it enabled', async () => {
    renderApp('/import');
    expect(await screen.findByText(/nothing is ever sent off this computer/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('routing', () => {
  it('shows a not-found page for unknown addresses', async () => {
    renderApp('/nope');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
