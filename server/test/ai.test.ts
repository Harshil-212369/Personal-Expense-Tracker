import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createAnthropicGateway } from '../src/ai/gateway.ts';
import type { AiStatement } from '../src/ai/gateway.ts';
import { keepTransactionLines, minimizeForModel, redact } from '../src/ai/redact.ts';
import { HttpError } from '../src/lib/errors.ts';
import { makeApp, stubAi, unknownLayoutPdf } from './helpers.ts';

/**
 * No test in this file touches the network. The stub gateway stands in for the
 * model, and the real gateway is exercised against a local fake of the HTTP API.
 */

describe('data minimization', () => {
  const statementText = [
    'ACME BANK VISA',
    'ALEX SAMPLE',
    '12-345 EXAMPLE STREET',
    'TORONTO ON M5V 2T6',
    'Account number 4500 1234 5678 9013',
    'Statement period from March 1 to March 31, 2026',
    'Mar 02 Mar 03 CORNER CAFE TORONTO ON 4.50',
    'Mar 05 Mar 06 PHONE CO 416-555-0199 ON 62.15',
    'Questions? Write to help@acmebank.example',
    'Total purchases $66.65',
  ].join('\n');

  it('keeps transaction and total lines and drops the name and address block', () => {
    const kept = keepTransactionLines(statementText);
    assert.match(kept, /CORNER CAFE/);
    assert.match(kept, /Total purchases/);
    assert.match(kept, /Statement period/);
    assert.doesNotMatch(kept, /ALEX SAMPLE|EXAMPLE STREET|M5V|ACME BANK VISA|help@/);
  });

  it('masks identifiers that remain on kept lines', () => {
    const { text, counts } = redact('card 4500 1234 5678 9013 or 4500 XXXX XXXX 9013, acct ******8711, a@b.example, 416-555-0199, M5V 2T6');
    assert.doesNotMatch(text, /4500|9013|8711|a@b|555|M5V/);
    assert.equal(counts['card'], 2);
    assert.equal(counts['email'], 1);
    assert.equal(counts['phone'], 1);
    assert.equal(counts['postal-code'], 1);
  });

  it('masks configured personal terms regardless of case, treating them as literal text', () => {
    const { text, counts } = redact('Paid by ALEX SAMPLE (a.k.a. alex sample) at C++ Cafe', ['Alex Sample', 'C++']);
    assert.equal(text, 'Paid by [REDACTED] (a.k.a. [REDACTED]) at [REDACTED] Cafe');
    assert.equal(counts['personal-term'], 3);
  });

  it('leaves ordinary amounts and dates alone', () => {
    const line = 'Mar 02 Mar 03 CORNER CAFE TORONTO ON 4.50';
    assert.equal(redact(line).text, line);
  });

  it('runs both steps for the model', () => {
    const { text } = minimizeForModel(statementText, ['Alex Sample']);
    assert.doesNotMatch(text, /ALEX|4500|416-555|M5V/);
    assert.match(text, /PHONE CO \[PHONE\] ON 62\.15/);
  });
});

describe('AI statement reader', () => {
  const extraction: AiStatement = {
    institution: 'Acme Bank',
    accountLast4: '9013',
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    statedTotals: { purchases: 66.65, payments: 20, credits: 4.5 },
    transactions: [
      { date: '2026-03-02', description: 'CORNER CAFE', amount: 4.5, kind: 'purchase' },
      { date: '2026-03-05', description: 'PHONE CO', amount: 62.15, kind: 'purchase' },
      { date: '2026-03-09', description: 'CORNER CAFE', amount: -4.5, kind: 'purchase' }, // mislabeled refund
      { date: '2026-03-15', description: 'PAYMENT RECEIVED', amount: 20, kind: 'payment' },
      { date: '2026-02-31', description: 'IMPOSSIBLE DATE', amount: 9.99, kind: 'purchase' },
    ],
  };
  const pdfLines = [
    'ACME BANK VISA', 'ALEX SAMPLE', 'Account number 4500 1234 5678 9013',
    'Mar 02 Mar 03 CORNER CAFE TORONTO ON 4.50', 'Total purchases $66.65',
  ];

  it('falls back to the model for an unknown layout and validates what comes back', async () => {
    const ai = stubAi({ extractStatement: async () => extraction });
    const { app } = makeApp({ ai, env: { REDACT_TERMS: 'Alex Sample' } });
    const res = await request(app).post('/api/imports').attach('file', Buffer.from(await unknownLayoutPdf(pdfLines)), 'acme.pdf').expect(201);

    assert.equal(res.body.parser, 'ai');
    assert.equal(res.body.kind, 'ai-statement');
    assert.equal(res.body.rowsInserted, 4, 'the row with an impossible date is dropped');
    assert.equal(res.body.reconciled, true, 'extracted rows match all three printed totals');
    assert.match(res.body.warnings.join(' '), /invalid date/);

    const refund = res.body.preview.find((row: { amountCents: number }) => row.amountCents === -450);
    assert.equal(refund.type, 'refund', 'the sign of the amount wins over the label');
    const payment = res.body.preview.find((row: { type: string }) => row.type === 'payment');
    assert.equal(payment.amountCents, -2000);

    const sent = ai.calls[0]!.input as string;
    assert.doesNotMatch(sent, /ALEX SAMPLE|4500|9013/, 'nothing identifying may be sent to the model');
    assert.match(sent, /CORNER CAFE/);
  });

  it('reports a failed reconciliation instead of trusting the model', async () => {
    const wrong = { ...extraction, statedTotals: { purchases: 100, payments: null, credits: null } };
    const { app } = makeApp({ ai: stubAi({ extractStatement: async () => wrong }) });
    const res = await request(app).post('/api/imports?dryRun=true').attach('file', Buffer.from(await unknownLayoutPdf(pdfLines)), 'acme.pdf').expect(200);
    assert.equal(res.body.reconciled, false);
    assert.match(res.body.warnings.join(' '), /Reconciliation mismatch/);
  });

  it('can be forced on a known format, and rejects an empty extraction', async () => {
    const ai = stubAi({ extractStatement: async () => ({ ...extraction, transactions: [] }) });
    const { app } = makeApp({ ai });
    const res = await request(app).post('/api/imports?parser=ai').attach('file', Buffer.from('2026-03-02,CORNER CAFE,4.50,,\n'), 'x.csv');
    assert.equal(res.status, 422);
    assert.equal(ai.calls.length, 1);
  });

  it('answers 422 for an unknown layout when no model is configured', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/imports').attach('file', Buffer.from(await unknownLayoutPdf(pdfLines)), 'acme.pdf');
    assert.equal(res.status, 422);
  });
});

describe('AI categorization', () => {
  async function seed(app: ReturnType<typeof makeApp>['app']) {
    for (const description of ['SQ *BOULDER BARN', 'SQ *BOULDER BARN', 'ZZ UNKNOWN VENDOR', 'TIM HORTONS #1']) {
      await request(app).post('/api/transactions').send({ txnDate: '2026-03-05', description, amountCents: 1000 }).expect(201);
    }
  }

  it('sends merchant names only and stores confident answers as reusable rules', async () => {
    const ai = stubAi({
      categorizeMerchants: async () => [
        { merchant: 'Boulder Barn', category: 'Entertainment', confidence: 'high' },
        { merchant: 'ZZ Unknown Vendor', category: 'Other', confidence: 'low' },
        { merchant: 'Injected Merchant', category: 'Groceries', confidence: 'high' }, // never sent: ignored
        { merchant: 'Boulder Barn', category: 'Made Up Category', confidence: 'high' }, // not a category: ignored
      ],
    });
    const { app } = makeApp({ ai });
    await seed(app);

    const res = await request(app).post('/api/ai/categorize').expect(200);
    assert.deepEqual(res.body, { merchantsSent: 2, rulesCreated: 1, recategorized: 2, skippedLowConfidence: 1 });

    const sent = ai.calls[0]!.input as { merchants: string[]; categories: string[] };
    assert.deepEqual(sent.merchants, ['Boulder Barn', 'ZZ Unknown Vendor']);
    assert.ok(sent.categories.includes('Groceries') && !sent.categories.includes('Uncategorized') && !sent.categories.includes('Card Payments'));
    assert.doesNotMatch(JSON.stringify(sent), /1000|2026-03-05/, 'amounts and dates are never sent');

    const rules = (await request(app).get('/api/rules')).body as Array<{ source: string; pattern: string }>;
    assert.deepEqual(rules.filter((r) => r.source === 'ai').map((r) => r.pattern), ['Boulder Barn']);
    const boulder = (await request(app).get('/api/transactions?q=boulder')).body.items[0];
    assert.deepEqual([boulder.categoryName, boulder.categorySource], ['Entertainment', 'ai']);

    // The saved rule now answers without another model call.
    const again = await request(app).post('/api/ai/categorize').expect(200);
    assert.equal(again.body.merchantsSent, 1);
  });

  it('does nothing when everything is categorized, and 503s when AI is off', async () => {
    const ai = stubAi();
    const { app } = makeApp({ ai });
    const res = await request(app).post('/api/ai/categorize').expect(200);
    assert.equal(res.body.merchantsSent, 0);
    assert.equal(ai.calls.length, 0);

    const off = makeApp();
    assert.equal((await request(off.app).post('/api/ai/categorize')).status, 503);
    assert.equal((await request(off.app).post('/api/ai/insights').send({})).status, 503);
  });
});

describe('AI insights', () => {
  it('sends aggregates and returns the narration', async () => {
    const ai = stubAi({ writeInsights: async () => [{ tone: 'up', title: 'Coffee is climbing', detail: 'x'.repeat(900) }] });
    const { app } = makeApp({ ai });
    await request(app).post('/api/transactions').send({ txnDate: '2026-03-05', description: 'TIM HORTONS #1', amountCents: 450, notes: 'private note' });

    const res = await request(app).post('/api/ai/insights').send({ from: '2026-03-01', to: '2026-03-31' }).expect(200);
    assert.equal(res.body.source, 'ai');
    assert.equal(res.body.model, 'stub-model');
    assert.equal(res.body.insights[0].detail.length, 500, 'model text is length-capped');
    assert.doesNotMatch(JSON.stringify(ai.calls[0]!.input), /private note/);
    assert.equal((await request(app).get('/api/health')).body.ai.enabled, true);
  });
});

describe('Anthropic gateway (against a local fake of the API)', () => {
  const config = { anthropicApiKey: 'test-key', anthropicModel: 'claude-opus-5-5' };
  type Captured = { url: string; body: Record<string, unknown>; headers: Headers };

  function fakeApi(respond: (captured: Captured) => { status?: number; json: unknown }) {
    const requests: Captured[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const captured: Captured = {
        url: String(input instanceof Request ? input.url : input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      };
      requests.push(captured);
      const { status = 200, json } = respond(captured);
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
    };
    return { requests, gateway: createAnthropicGateway(config, { fetch: fakeFetch, maxRetries: 0 })! };
  }

  const message = (text: string, stopReason = 'end_turn') => ({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [{ type: 'text', text }], stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });

  it('is disabled without a key', () => {
    assert.equal(createAnthropicGateway({ anthropicApiKey: undefined, anthropicModel: 'claude-opus-5-5' }), null);
  });

  it('requests schema-constrained output with the category list as an enum', async () => {
    const { gateway, requests } = fakeApi(() => ({
      json: message(JSON.stringify({ assignments: [{ merchant: 'Boulder Barn', category: 'Entertainment', confidence: 'high' }] })),
    }));
    const result = await gateway.categorizeMerchants({ merchants: ['Boulder Barn'], categories: ['Entertainment', 'Other'] });
    assert.deepEqual(result, [{ merchant: 'Boulder Barn', category: 'Entertainment', confidence: 'high' }]);

    const sent = requests[0]!;
    assert.match(sent.url, /\/v1\/messages/);
    assert.equal(sent.body['model'], 'claude-opus-5-5');
    assert.equal(sent.body['fallbacks'], 'default');
    assert.match(`${sent.headers.get('x-api-key')} ${sent.headers.get('authorization')}`, /test-key/);
    assert.match(sent.headers.get('anthropic-beta') ?? '', /server-side-fallback/);
    const schema = JSON.stringify((sent.body['output_config'] as { format: unknown }).format);
    assert.match(schema, /"enum":\["Entertainment","Other"\]/);
    assert.equal(sent.body['temperature'], undefined);
    assert.equal(sent.body['thinking'], undefined);
  });

  it('omits the fallback parameter for models that do not accept it', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const gateway = createAnthropicGateway(
      { anthropicApiKey: 'k', anthropicModel: 'claude-haiku-5-5' },
      {
        maxRetries: 0,
        fetch: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify(message(JSON.stringify({ insights: [] }))), { headers: { 'content-type': 'application/json' } });
        },
      },
    )!;
    assert.deepEqual(await gateway.writeInsights({}), []);
    assert.equal(requests[0]!['fallbacks'], undefined);
  });

  const failure = async (respond: Parameters<typeof fakeApi>[0]) => {
    const { gateway } = fakeApi(respond);
    try {
      await gateway.writeInsights({ totalCents: 1 });
    } catch (error) {
      assert.ok(error instanceof HttpError);
      return error;
    }
    return assert.fail('expected the gateway to throw');
  };

  it('maps provider failures to clean HTTP errors', async () => {
    const apiError = (type: string) => ({ type: 'error', error: { type, message: 'nope' } });
    assert.deepEqual([(await failure(() => ({ status: 401, json: apiError('authentication_error') }))).code], ['ai-auth']);
    assert.deepEqual([(await failure(() => ({ status: 429, json: apiError('rate_limit_error') }))).code], ['ai-rate-limited']);
    const server = await failure(() => ({ status: 500, json: apiError('api_error') }));
    assert.deepEqual([server.status, server.code], [502, 'ai-error']);
    assert.doesNotMatch(server.message, /nope/, 'provider error text is not passed through');
  });

  it('treats refusals and truncated output as failures, never as data', async () => {
    assert.equal((await failure(() => ({ json: message('', 'refusal') }))).code, 'ai-refused');
    assert.equal((await failure(() => ({ json: message('{"insights":[{"tone":"up"', 'max_tokens') }))).code, 'ai-incomplete');
    assert.equal((await failure(() => ({ json: message('not json at all') }))).code, 'ai-invalid');
    assert.equal((await failure(() => ({ json: message('{"insights":[{"tone":"sideways","title":1}]}') }))).code, 'ai-invalid');
  });
});
