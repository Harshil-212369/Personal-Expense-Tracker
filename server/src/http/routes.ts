import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import type { AiGateway } from '../ai/gateway.ts';
import type { Config } from '../config.ts';
import {
  CategoryCreateSchema, CategoryUpdateSchema, ImportOptionsSchema, RangeQuerySchema, RuleCreateSchema,
  TimeseriesQuerySchema, TransactionCreateSchema, TransactionQuerySchema, TransactionUpdateSchema,
} from '../contracts.ts';
import type { HealthResponse } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { badRequest, HttpError, toProblem } from '../lib/errors.ts';
import { categorizeUncategorized } from '../services/aiCategorize.ts';
import * as analytics from '../services/analytics.ts';
import { recategorizeAll } from '../services/categorizer.ts';
import * as categories from '../services/categories.ts';
import * as importer from '../services/importer.ts';
import { insights } from '../services/insights.ts';
import * as receipts from '../services/receipts.ts';
import * as transactions from '../services/transactions.ts';
import { parseId, validate } from './middleware.ts';

export interface RouteDeps {
  db: Db;
  config: Config;
  ai: AiGateway | null;
  version: string;
}

function limiter(limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res
        .status(429)
        .type('application/problem+json')
        .send(JSON.stringify(toProblem(429, 'rate-limited', 'Too many requests. Slow down and try again in a minute.')));
    },
  });
}

export function apiRouter({ db, config, ai, version }: RouteDeps): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(), // uploads are parsed in memory and never written to disk
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4 },
  });
  // Expensive endpoints (file parsing, model calls) get a tighter budget.
  const heavy = limiter(config.env === 'test' ? 10_000 : 30);

  // --- System -----------------------------------------------------------------
  router.get('/health', (_req, res) => {
    const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n'] ?? 0);
    const body: HealthResponse = {
      status: 'ok',
      version,
      ai: { enabled: ai !== null, model: ai?.model ?? null },
      auth: config.apiToken ? 'token' : 'none',
      counts: { transactions: count('transactions'), receipts: count('receipts'), imports: count('imports') },
    };
    res.json(body);
  });

  // --- Transactions -----------------------------------------------------------
  router.get('/transactions', (req, res) => {
    res.json(transactions.listTransactions(db, validate(TransactionQuerySchema, req.query)));
  });
  router.post('/transactions', (req, res) => {
    const created = transactions.createTransaction(db, validate(TransactionCreateSchema, req.body));
    res.status(201).location(`/api/transactions/${created.id}`).json(created);
  });
  router.get('/transactions/:id', (req, res) => {
    res.json(transactions.getTransaction(db, parseId(req.params.id, 'Transaction')));
  });
  router.patch('/transactions/:id', (req, res) => {
    const id = parseId(req.params.id, 'Transaction');
    res.json(transactions.updateTransaction(db, id, validate(TransactionUpdateSchema, req.body)));
  });
  router.delete('/transactions/:id', (req, res) => {
    transactions.deleteTransaction(db, parseId(req.params.id, 'Transaction'));
    res.status(204).end();
  });

  // --- Categories -------------------------------------------------------------
  router.get('/categories', (_req, res) => {
    res.json(categories.listCategories(db));
  });
  router.post('/categories', (req, res) => {
    const created = categories.createCategory(db, validate(CategoryCreateSchema, req.body).name);
    res.status(201).location(`/api/categories/${created.id}`).json(created);
  });
  router.patch('/categories/:id', (req, res) => {
    const id = parseId(req.params.id, 'Category');
    res.json(categories.renameCategory(db, id, validate(CategoryUpdateSchema, req.body).name));
  });
  router.delete('/categories/:id', (req, res) => {
    categories.deleteCategory(db, parseId(req.params.id, 'Category'));
    res.status(204).end();
  });

  // --- Rules ------------------------------------------------------------------
  router.get('/rules', (_req, res) => {
    res.json(categories.listRules(db));
  });
  router.post('/rules', (req, res) => {
    const result = categories.upsertRule(db, validate(RuleCreateSchema, req.body));
    res.status(201).json(result);
  });
  router.post('/rules/apply', (_req, res) => {
    res.json({ recategorized: recategorizeAll(db) });
  });
  router.delete('/rules/:id', (req, res) => {
    res.json(categories.deleteRule(db, parseId(req.params.id, 'Rule')));
  });

  // --- Imports ----------------------------------------------------------------
  router.get('/imports', (_req, res) => {
    res.json(importer.listImports(db));
  });
  router.post('/imports', heavy, upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('Attach the document as multipart form field "file".');
    const options = validate(ImportOptionsSchema, req.query);
    const result = await importer.importFile(
      { db, ai, redactTerms: config.redactTerms },
      { bytes: new Uint8Array(req.file.buffer), filename: req.file.originalname, dryRun: options.dryRun, parser: options.parser },
    );
    // 201 only when something was stored; a preview or a duplicate changes nothing.
    res.status(result.status === 'imported' ? 201 : 200).json(result);
  });
  router.get('/imports/:id', (req, res) => {
    res.json(importer.getImport(db, parseId(req.params.id, 'Import')));
  });
  router.delete('/imports/:id', (req, res) => {
    importer.deleteImport(db, parseId(req.params.id, 'Import'));
    res.status(204).end();
  });

  // --- Receipts ---------------------------------------------------------------
  router.get('/receipts', (_req, res) => {
    res.json(receipts.listReceipts(db));
  });
  router.get('/receipts/:id', (req, res) => {
    res.json(receipts.getReceipt(db, parseId(req.params.id, 'Receipt')));
  });
  router.delete('/receipts/:id', (req, res) => {
    receipts.deleteReceipt(db, parseId(req.params.id, 'Receipt'));
    res.status(204).end();
  });

  // --- Analytics --------------------------------------------------------------
  const range = (query: unknown) => analytics.resolveScope(db, validate(RangeQuerySchema, query));

  router.get('/analytics/summary', (req, res) => {
    res.json(analytics.summary(db, range(req.query)));
  });
  router.get('/analytics/categories', (req, res) => {
    res.json(analytics.byCategory(db, range(req.query)));
  });
  router.get('/analytics/timeseries', (req, res) => {
    const query = validate(TimeseriesQuerySchema, req.query);
    res.json(analytics.timeseries(db, analytics.resolveScope(db, query), query.granularity));
  });
  router.get('/analytics/merchants', (req, res) => {
    res.json(analytics.topMerchants(db, range(req.query)));
  });
  router.get('/analytics/calendar', (req, res) => {
    res.json(analytics.calendar(db, range(req.query)));
  });
  router.get('/analytics/recurring', (_req, res) => {
    res.json(analytics.recurring(db));
  });
  router.get('/analytics/anomalies', (req, res) => {
    res.json(analytics.anomalies(db, range(req.query)));
  });
  router.get('/analytics/habits', (req, res) => {
    res.json(analytics.habits(db, range(req.query)));
  });
  router.get('/analytics/groceries', (req, res) => {
    res.json(analytics.groceries(db, range(req.query)));
  });
  router.get('/analytics/insights', async (req, res) => {
    res.json(await insights(db, ai, range(req.query), false));
  });

  // --- AI (opt-in; every route here returns 503 when no key is configured) ----
  router.post('/ai/insights', heavy, async (req, res) => {
    if (!ai) throw new HttpError(503, 'ai-disabled', 'AI features are not configured on this server.');
    res.json(await insights(db, ai, range(req.body ?? {}), true));
  });
  router.post('/ai/categorize', heavy, async (_req, res) => {
    res.json(await categorizeUncategorized(db, ai));
  });

  return router;
}
