import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { expected, fixture, makeApp } from './helpers.ts';
import type { TestContext } from './helpers.ts';

let ctx: TestContext;
const api = () => request(ctx.app);
const upload = (name: string, query = '') =>
  api().post(`/api/imports${query}`).attach('file', Buffer.from(fixture(name)), name);

beforeEach(() => {
  ctx = makeApp();
});

function assertProblem(res: request.Response, status: number) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'] ?? '', /application\/problem\+json/);
  assert.equal(res.body.status, status);
  assert.ok(res.body.type && res.body.title && res.body.detail);
  assert.ok(res.body.requestId, 'problem responses carry the request id');
}

describe('GET /api/health', () => {
  it('reports status without leaking configuration', async () => {
    const res = await api().get('/api/health').expect(200);
    assert.equal(res.body.status, 'ok');
    assert.deepEqual(res.body.ai, { enabled: false, model: null });
    assert.deepEqual(res.body.counts, { transactions: 0, receipts: 0, imports: 0 });
    assert.match(res.body.version, /^\d+\.\d+\.\d+$/);
  });
});

describe('transactions', () => {
  const create = (body: object) => api().post('/api/transactions').send(body);

  it('creates, reads, updates and deletes', async () => {
    const created = await create({ txnDate: '2026-03-05', description: 'TIM HORTONS #1021', amountCents: 475 }).expect(201);
    assert.equal(created.headers.location, `/api/transactions/${created.body.id}`);
    assert.equal(created.body.merchant, 'Tim Hortons');
    assert.equal(created.body.categoryName, 'Dining & Coffee');
    assert.equal(created.body.categorySource, 'rule');

    const fetched = await api().get(`/api/transactions/${created.body.id}`).expect(200);
    assert.deepEqual(fetched.body, created.body);

    const categories = (await api().get('/api/categories').expect(200)).body as Array<{ id: number; name: string }>;
    const other = categories.find((c) => c.name === 'Other')!;
    const updated = await api().patch(`/api/transactions/${created.body.id}`).send({ categoryId: other.id, notes: 'team coffee' }).expect(200);
    assert.equal(updated.body.categoryName, 'Other');
    assert.equal(updated.body.categorySource, 'manual');
    assert.equal(updated.body.notes, 'team coffee');

    await api().delete(`/api/transactions/${created.body.id}`).expect(204);
    assertProblem(await api().get(`/api/transactions/${created.body.id}`), 404);
    assertProblem(await api().delete(`/api/transactions/${created.body.id}`), 404);
  });

  it('rejects invalid input with field-level errors', async () => {
    const res = await create({ txnDate: '2026-02-30', description: '', amountCents: 4.75, extra: true });
    assertProblem(res, 400);
    const fields = (res.body.errors as Array<{ field: string }>).map((e) => e.field).sort();
    assert.deepEqual(fields, ['(root)', 'amountCents', 'description', 'txnDate']);
  });

  it('rejects a zero amount, an unknown category and an empty update', async () => {
    assertProblem(await create({ txnDate: '2026-03-05', description: 'x', amountCents: 0 }), 400);
    assertProblem(await create({ txnDate: '2026-03-05', description: 'x', amountCents: 100, categoryId: 9999 }), 422);
    const created = await create({ txnDate: '2026-03-05', description: 'x', amountCents: 100 }).expect(201);
    assertProblem(await api().patch(`/api/transactions/${created.body.id}`).send({}), 400);
    assertProblem(await api().get('/api/transactions/abc'), 400);
  });

  it('filters, searches, sorts and paginates', async () => {
    await create({ txnDate: '2026-03-01', description: 'METRO 9001', amountCents: 4000 });
    await create({ txnDate: '2026-03-02', description: 'TIM HORTONS #1021', amountCents: 300 });
    await create({ txnDate: '2026-03-03', description: 'TIM HORTONS #2022', amountCents: 500 });
    await create({ txnDate: '2026-04-01', description: 'PRESTO MOBI/ABCDEFGH12', amountCents: 1000 });

    const march = await api().get('/api/transactions?from=2026-03-01&to=2026-03-31').expect(200);
    assert.equal(march.body.total, 3);
    assert.deepEqual(march.body.items.map((t: { txnDate: string }) => t.txnDate), ['2026-03-03', '2026-03-02', '2026-03-01']);

    const search = await api().get('/api/transactions?q=tim%20hortons&sort=amount&order=asc').expect(200);
    assert.deepEqual(search.body.items.map((t: { amountCents: number }) => t.amountCents), [300, 500]);

    const big = await api().get('/api/transactions?minCents=1000').expect(200);
    assert.equal(big.body.total, 2);

    const page = await api().get('/api/transactions?limit=2&offset=2&sort=date&order=asc').expect(200);
    assert.deepEqual([page.body.total, page.body.items.length, page.body.limit, page.body.offset], [4, 2, 2, 2]);
    assert.equal(page.body.items[0].txnDate, '2026-03-03');

    assertProblem(await api().get('/api/transactions?limit=5000'), 400);
    assertProblem(await api().get('/api/transactions?sort=password'), 400);
  });

  it('treats search text as text, not as a pattern or as SQL', async () => {
    await create({ txnDate: '2026-03-01', description: '100% JUICE BAR', amountCents: 700 });
    await create({ txnDate: '2026-03-02', description: 'PLAIN CAFE', amountCents: 700 });
    assert.equal((await api().get('/api/transactions?q=%25').expect(200)).body.total, 1);
    assert.equal((await api().get('/api/transactions?q=_').expect(200)).body.total, 0);
    const injection = await api().get(`/api/transactions?q=${encodeURIComponent("' OR 1=1 --")}`).expect(200);
    assert.equal(injection.body.total, 0);
    assert.equal((await api().get('/api/transactions').expect(200)).body.total, 2);
  });
});

describe('categories and rules', () => {
  it('manages custom categories and protects built-in ones', async () => {
    const created = await api().post('/api/categories').send({ name: 'Climbing' }).expect(201);
    assertProblem(await api().post('/api/categories').send({ name: 'climbing' }), 409);
    const renamed = await api().patch(`/api/categories/${created.body.id}`).send({ name: 'Bouldering' }).expect(200);
    assert.equal(renamed.body.name, 'Bouldering');

    const groceries = ((await api().get('/api/categories')).body as Array<{ id: number; name: string }>).find((c) => c.name === 'Groceries')!;
    assertProblem(await api().patch(`/api/categories/${groceries.id}`).send({ name: 'Food' }), 422);
    assertProblem(await api().delete(`/api/categories/${groceries.id}`), 422);

    await api().delete(`/api/categories/${created.body.id}`).expect(204);
    assertProblem(await api().delete(`/api/categories/${created.body.id}`), 404);
  });

  it('applies a new rule to existing transactions and reverts when it is deleted', async () => {
    const txn = await api().post('/api/transactions').send({ txnDate: '2026-03-05', description: 'SQ *BOULDER BARN', amountCents: 2400 }).expect(201);
    assert.equal(txn.body.categoryName, 'Uncategorized');

    const category = await api().post('/api/categories').send({ name: 'Climbing' }).expect(201);
    const rule = await api().post('/api/rules').send({ pattern: 'Boulder Barn', categoryId: category.body.id }).expect(201);
    assert.equal(rule.body.recategorized, 1);
    assert.equal(rule.body.rule.source, 'user');
    assert.equal((await api().get(`/api/transactions/${txn.body.id}`)).body.categoryName, 'Climbing');

    const rules = (await api().get('/api/rules').expect(200)).body as Array<{ id: number; source: string }>;
    assert.equal(rules[0]!.source, 'user', 'user rules sort first because they win');

    const removed = await api().delete(`/api/rules/${rule.body.rule.id}`).expect(200);
    assert.equal(removed.body.recategorized, 1);
    assert.equal((await api().get(`/api/transactions/${txn.body.id}`)).body.categoryName, 'Uncategorized');
    assertProblem(await api().post('/api/rules').send({ pattern: 'x', categoryId: 1 }), 400);
    assertProblem(await api().post('/api/rules').send({ pattern: 'valid', categoryId: 9999 }), 422);
    assert.equal((await api().post('/api/rules/apply').expect(200)).body.recategorized, 0);
  });
});

describe('imports', () => {
  it('previews, imports, then recognizes the duplicate', async () => {
    const total = expected.october.chargeCount + expected.october.paymentCount;

    const preview = await upload('statement-2026-10.pdf', '?dryRun=true').expect(200);
    assert.equal(preview.body.status, 'preview');
    assert.equal(preview.body.reconciled, true);
    assert.equal(preview.body.preview.length, total);
    assert.equal((await api().get('/api/health')).body.counts.transactions, 0);

    const imported = await upload('statement-2026-10.pdf').expect(201);
    assert.equal(imported.body.status, 'imported');
    assert.equal(imported.body.rowsInserted, total);
    assert.ok(imported.body.checks.every((c: { ok: boolean }) => c.ok));

    const duplicate = await upload('statement-2026-10.pdf').expect(200);
    assert.equal(duplicate.body.status, 'duplicate');

    const history = await api().get('/api/imports').expect(200);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].reconciled, true);
    await api().get(`/api/imports/${imported.body.importId}`).expect(200);
  });

  it('imports a receipt and serves its line items', async () => {
    await upload('statement-2026-10.pdf').expect(201);
    const result = await upload('metro-receipt.eml').expect(201);
    assert.equal(result.body.receiptsLinked, 1);

    const receipts = await api().get('/api/receipts').expect(200);
    assert.equal(receipts.body.length, 1);
    const detail = await api().get(`/api/receipts/${receipts.body[0].id}`).expect(200);
    assert.equal(detail.body.items.length, expected.receipt.itemCount);
    assert.equal(detail.body.totalCents, expected.receipt.totalCents);
    assert.equal(detail.body.arithmeticOk, true);

    const linked = await api().get('/api/transactions?hasReceipt=true').expect(200);
    assert.equal(linked.body.total, 1);
    assert.equal(linked.body.items[0].receiptId, detail.body.id);

    await api().delete(`/api/receipts/${detail.body.id}`).expect(204);
    assert.equal((await api().get('/api/transactions?hasReceipt=true')).body.total, 0);
  });

  it('deleting an import removes its transactions', async () => {
    const imported = await upload('statement-2026-09.pdf').expect(201);
    await api().delete(`/api/imports/${imported.body.importId}`).expect(204);
    assert.equal((await api().get('/api/health')).body.counts.transactions, 0);
    assertProblem(await api().get(`/api/imports/${imported.body.importId}`), 404);
  });

  it('rejects missing, unreadable and oversized uploads', async () => {
    assertProblem(await api().post('/api/imports'), 400);
    assertProblem(await api().post('/api/imports').attach('file', Buffer.from('%PDF-1.7 broken'), 'x.pdf'), 422);
    assertProblem(await api().post('/api/imports').attach('file', Buffer.from([0, 1, 2, 3]), 'x.bin'), 422);
    assertProblem(await upload('statement-2026-10.pdf', '?dryRun=maybe'), 400);

    const small = makeApp({ env: { MAX_UPLOAD_BYTES: '1024' } });
    const res = await request(small.app).post('/api/imports').attach('file', Buffer.from(fixture('statement-2026-10.pdf')), 'big.pdf');
    assertProblem(res, 413);
  });

  it('says so when the AI reader is requested but not configured', async () => {
    assertProblem(await upload('statement-2026-10.pdf', '?parser=ai'), 503);
  });
});

describe('analytics', () => {
  beforeEach(async () => {
    await upload('statement-2026-09.pdf').expect(201);
    await upload('statement-2026-10.pdf').expect(201);
    await upload('metro-receipt.eml').expect(201);
  });
  const period = `from=${expected.october.periodStart}&to=${expected.october.periodEnd}`;

  it('agrees with the statement on what the period cost', async () => {
    const all = await api().get('/api/analytics/summary').expect(200);
    assert.equal(all.body.totalCents, expected.september.purchasesCents + expected.october.purchasesCents);
    assert.ok(all.body.dataBounds.from <= expected.september.periodStart);

    const categories = await api().get(`/api/analytics/categories?${period}`).expect(200);
    const summary = await api().get(`/api/analytics/summary?${period}`).expect(200);
    const fromCategories = categories.body.reduce((sum: number, c: { cents: number }) => sum + c.cents, 0);
    assert.equal(fromCategories, summary.body.totalCents, 'the category breakdown must add up to the headline total');
    assert.ok(summary.body.previous, 'September is on file, so October has a comparison');
  });

  it('serves every chart endpoint with consistent totals', async () => {
    const summary = (await api().get(`/api/analytics/summary?${period}`)).body;
    const series = (await api().get(`/api/analytics/timeseries?${period}`).expect(200)).body;
    assert.equal(series.length, summary.days);
    assert.equal(series.at(-1).cumulativeCents, summary.totalCents);

    const weekly = (await api().get(`/api/analytics/timeseries?${period}&granularity=week`).expect(200)).body;
    assert.equal(weekly.at(-1).cumulativeCents, summary.totalCents);

    const calendar = (await api().get(`/api/analytics/calendar?${period}`).expect(200)).body;
    assert.equal(calendar.weekdays.length, 7);
    assert.equal(calendar.days.length, summary.days);

    const merchants = (await api().get(`/api/analytics/merchants?${period}`).expect(200)).body;
    assert.ok(merchants.length > 3 && merchants.length <= 10);
    assert.ok(merchants[0].cents >= merchants[1].cents);

    const recurring = (await api().get('/api/analytics/recurring').expect(200)).body as Array<{ merchant: string }>;
    assert.ok(recurring.some((r) => r.merchant === 'Anthropic'), 'two monthly charges should be detected as recurring');

    await api().get(`/api/analytics/anomalies?${period}`).expect(200);
    const habits = (await api().get(`/api/analytics/habits?${period}`).expect(200)).body;
    assert.ok(habits.smallPurchaseCount > 0);

    const groceries = (await api().get('/api/analytics/groceries').expect(200)).body;
    assert.equal(groceries.receiptCount, 1);
    assert.equal(groceries.unlinkedReceipts, 0);
    assert.equal(groceries.itemLines, expected.receipt.itemCount);

    const insights = (await api().get(`/api/analytics/insights?${period}`).expect(200)).body;
    assert.equal(insights.source, 'rules');
    assert.ok(insights.insights.length >= 3);
  });

  it('reports a statement exactly as the statement prints it', async () => {
    const imports = (await api().get('/api/imports')).body as Array<{ id: number; kind: string; periodEnd: string }>;
    const october = imports.find((i) => i.kind === 'cibc-credit-pdf' && i.periodEnd === expected.october.periodEnd)!;
    const september = imports.find((i) => i.kind === 'cibc-credit-pdf' && i.periodEnd === expected.september.periodEnd)!;

    // By purchase date the period loses the rows bought the day before it opened...
    const byDate = (await api().get(`/api/analytics/summary?${period}`)).body;
    assert.notEqual(byDate.totalCents, expected.october.purchasesCents);

    // ...the statement scope does not: it matches the printed total to the cent.
    const byStatement = (await api().get(`/api/analytics/summary?importId=${october.id}`).expect(200)).body;
    assert.equal(byStatement.totalCents, expected.october.purchasesCents);
    assert.equal(byStatement.importId, october.id);
    assert.ok(byStatement.range.from <= expected.october.periodStart);

    // It is compared with the statement before it, not with a block of days.
    assert.equal(byStatement.previous.importId, september.id);
    assert.equal(byStatement.previous.totalCents, expected.september.purchasesCents);
    assert.equal((await api().get(`/api/analytics/summary?importId=${september.id}`)).body.previous, null);

    // Every other endpoint honours the same scope.
    const categories = (await api().get(`/api/analytics/categories?importId=${october.id}`)).body as Array<{ cents: number; previousCents: number }>;
    assert.equal(categories.reduce((sum, c) => sum + c.cents, 0), expected.october.purchasesCents);
    assert.equal(categories.reduce((sum, c) => sum + c.previousCents, 0), expected.september.purchasesCents);
    const series = (await api().get(`/api/analytics/timeseries?importId=${october.id}`)).body;
    assert.equal(series.at(-1).cumulativeCents, expected.october.purchasesCents);
    const listed = (await api().get(`/api/transactions?importId=${october.id}&type=purchase&limit=1`)).body;
    assert.equal(listed.total, byStatement.purchaseCount);
    assertProblem(await api().get('/api/analytics/summary?importId=9999'), 404);
  });

  it('validates ranges', async () => {
    assertProblem(await api().get('/api/analytics/summary?from=2026-10-21&to=2026-09-22'), 400);
    assertProblem(await api().get('/api/analytics/summary?from=yesterday'), 400);
    assertProblem(await api().get('/api/analytics/timeseries?granularity=hour'), 400);
  });
});

describe('security', () => {
  it('sends hardening headers and never caches API responses', async () => {
    const res = await api().get('/api/health').expect(200);
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'] ?? '', /default-src 'self'/);
    assert.match(res.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['x-request-id'] ?? '', /^[0-9a-f-]{36}$/);
  });

  it('refuses requests addressed to a non-local host (DNS rebinding)', async () => {
    assertProblem(await api().get('/api/transactions').set('Host', 'attacker.example'), 403);
    await api().get('/api/transactions').set('Host', 'localhost:4000').expect(200);
  });

  it('refuses cross-origin writes (CSRF) but allows same-origin ones', async () => {
    const body = { txnDate: '2026-03-05', description: 'x', amountCents: 100 };
    assertProblem(await api().post('/api/transactions').set('Origin', 'https://attacker.example').send(body), 403);
    const res = await api().post('/api/transactions').set('Host', 'localhost:4000').set('Origin', 'http://localhost:4000').send(body);
    assert.equal(res.status, 201);
    assert.equal((await api().get('/api/transactions')).body.total, 1);
  });

  it('requires the bearer token when one is configured', async () => {
    const token = 'local-test-token'.padEnd(32, 'x');
    const secured = makeApp({ env: { API_TOKEN: token } });
    const client = request(secured.app);
    await client.get('/api/health').expect(200);
    assert.equal((await client.get('/api/health')).body.auth, 'token');
    assertProblem(await client.get('/api/transactions'), 401);
    assertProblem(await client.get('/api/transactions').set('Authorization', `Bearer ${'wrong'.padEnd(32, 'y')}`), 401);
    assertProblem(await client.get('/api/transactions').set('Authorization', token), 401);
    await client.get('/api/transactions').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('returns problem details for unknown routes and malformed bodies', async () => {
    assertProblem(await api().get('/api/nope'), 404);
    assertProblem(await api().post('/api/transactions').set('Content-Type', 'application/json').send('{"broken'), 400);
    assertProblem(await api().post('/api/transactions').send({ description: 'x'.repeat(200_000) }), 413);
  });

  it('never echoes internal errors to the client', async () => {
    ctx.db.close(); // force every query to throw
    const res = await api().get('/api/transactions');
    assertProblem(res, 500);
    assert.equal(res.body.detail, 'An unexpected error occurred.');
    assert.doesNotMatch(JSON.stringify(res.body), /sqlite|database|stack|at /i);
  });
});
