/**
 * Typed client for the LedgerLens REST API. The response types are imported
 * straight from the server's contract file, so a change to the API that the
 * UI has not caught up with fails the build instead of failing at runtime.
 */
import type {
  Anomaly, CalendarData, Category, CategoryBreakdown, GroceryStats, Habits, HealthResponse, ImportRecord,
  ImportResult, InsightsResponse, MerchantBreakdown, Page, Receipt, RecurringCharge, Rule, Summary,
  TimeseriesPoint, Transaction,
} from '../../../server/src/contracts.ts';

export type * from '../../../server/src/contracts.ts';

export interface FieldError {
  field: string;
  message: string;
}

/** An RFC 9457 problem response from the API, as a throwable. */
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: FieldError[];
  constructor(status: number, detail: string, fieldErrors: FieldError[] = []) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

const TOKEN_KEY = 'ledgerlens.apiToken';

/** Only used when the server is started with API_TOKEN. Kept for the tab's lifetime only. */
export const tokenStore = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

type QueryValue = string | number | boolean | undefined | null;

export function toQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = tokenStore.get();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Cannot reach the LedgerLens server. Is it running?');
  }
  if (response.status === 204) return undefined as T;

  const isJson = /json/.test(response.headers.get('content-type') ?? '');
  const body: unknown = isJson ? await response.json() : null;
  if (!response.ok) {
    const problem = (body ?? {}) as { detail?: string; errors?: FieldError[] };
    throw new ApiError(
      response.status,
      problem.detail ?? `Request failed (HTTP ${response.status}).`,
      Array.isArray(problem.errors) ? problem.errors : [],
    );
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** A reporting scope: a date range, or one imported statement when `importId` is set. */
export interface Range {
  from: string;
  to: string;
  importId?: number | undefined;
}

/** Query parameters for a scope. A statement is addressed by its id alone. */
function scopeQuery(range: Range): Record<string, string | number> {
  return range.importId ? { importId: range.importId } : { from: range.from, to: range.to };
}

export interface TransactionFilters {
  from?: string;
  to?: string;
  categoryId?: number;
  importId?: number;
  type?: string;
  q?: string;
  hasReceipt?: boolean;
  sort?: 'date' | 'amount' | 'merchant';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  transactions: (filters: TransactionFilters) => request<Page<Transaction>>(`/transactions${toQuery({ ...filters })}`),
  createTransaction: (body: { txnDate: string; description: string; amountCents: number; categoryId?: number; notes?: string }) =>
    request<Transaction>('/transactions', json('POST', body)),
  updateTransaction: (id: number, body: { categoryId?: number; notes?: string | null }) =>
    request<Transaction>(`/transactions/${id}`, json('PATCH', body)),
  deleteTransaction: (id: number) => request<void>(`/transactions/${id}`, { method: 'DELETE' }),

  categories: () => request<Category[]>('/categories'),
  createCategory: (name: string) => request<Category>('/categories', json('POST', { name })),
  deleteCategory: (id: number) => request<void>(`/categories/${id}`, { method: 'DELETE' }),

  rules: () => request<Rule[]>('/rules'),
  createRule: (body: { pattern: string; categoryId: number }) =>
    request<{ rule: Rule; recategorized: number }>('/rules', json('POST', body)),
  deleteRule: (id: number) => request<{ recategorized: number }>(`/rules/${id}`, { method: 'DELETE' }),

  imports: () => request<ImportRecord[]>('/imports'),
  importFile: (file: File, options: { dryRun: boolean; parser: 'auto' | 'ai' }) => {
    const form = new FormData();
    form.append('file', file);
    return request<ImportResult>(`/imports${toQuery({ dryRun: options.dryRun, parser: options.parser })}`, { method: 'POST', body: form });
  },
  deleteImport: (id: number) => request<void>(`/imports/${id}`, { method: 'DELETE' }),

  receipts: () => request<Receipt[]>('/receipts'),
  receipt: (id: number) => request<Receipt>(`/receipts/${id}`),

  summary: (range: Range) => request<Summary>(`/analytics/summary${toQuery(scopeQuery(range))}`),
  categoryBreakdown: (range: Range) => request<CategoryBreakdown[]>(`/analytics/categories${toQuery(scopeQuery(range))}`),
  timeseries: (range: Range, granularity: 'day' | 'week' | 'month' = 'day') =>
    request<TimeseriesPoint[]>(`/analytics/timeseries${toQuery({ ...scopeQuery(range), granularity })}`),
  merchants: (range: Range) => request<MerchantBreakdown[]>(`/analytics/merchants${toQuery(scopeQuery(range))}`),
  calendar: (range: Range) => request<CalendarData>(`/analytics/calendar${toQuery(scopeQuery(range))}`),
  recurring: () => request<RecurringCharge[]>('/analytics/recurring'),
  anomalies: (range: Range) => request<Anomaly[]>(`/analytics/anomalies${toQuery(scopeQuery(range))}`),
  habits: (range: Range) => request<Habits>(`/analytics/habits${toQuery(scopeQuery(range))}`),
  groceries: (range?: Range) => request<GroceryStats>(`/analytics/groceries${toQuery(range ? scopeQuery(range) : {})}`),
  insights: (range: Range) => request<InsightsResponse>(`/analytics/insights${toQuery(scopeQuery(range))}`),

  aiInsights: (range: Range) => request<InsightsResponse>('/ai/insights', json('POST', scopeQuery(range))),
  aiCategorize: () =>
    request<{ merchantsSent: number; rulesCreated: number; recategorized: number; skippedLowConfidence: number }>('/ai/categorize', { method: 'POST' }),
};
