import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorNote, Skeleton, useOverlay, useToast } from '../components/common.tsx';
import { Icon } from '../components/Icon.tsx';
import { ReceiptDrawer } from '../components/ReceiptDrawer.tsx';
import { api, ApiError } from '../lib/api.ts';
import type { Category, Transaction, TransactionFilters } from '../lib/api.ts';
import { dateRange, longDate, money, parseDollars, plural, todayIso } from '../lib/format.ts';

const PAGE_SIZE = 50;
const SOURCE_LABEL: Record<Transaction['categorySource'], string> = {
  manual: 'Set by you',
  rule: 'Matched a rule',
  ai: 'Suggested by Claude',
  bank: "From the bank's category",
  default: 'Default',
};
type Sort = NonNullable<TransactionFilters['sort']>;

export function Transactions() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [receiptId, setReceiptId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [searchText, setSearchText] = useState(params.get('q') ?? '');

  const filters: TransactionFilters = {
    ...(params.get('from') ? { from: params.get('from')! } : {}),
    ...(params.get('to') ? { to: params.get('to')! } : {}),
    ...(params.get('q') ? { q: params.get('q')! } : {}),
    ...(params.get('categoryId') ? { categoryId: Number(params.get('categoryId')) } : {}),
    ...(params.get('importId') ? { importId: Number(params.get('importId')) } : {}),
    ...(params.get('type') ? { type: params.get('type')! } : {}),
    sort: (params.get('sort') as Sort | null) ?? 'date',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
    limit: PAGE_SIZE,
    offset: Math.max(0, Number(params.get('offset') ?? 0)) || 0,
  };

  const update = (changes: Record<string, string | number | null>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      if (!('offset' in changes)) next.delete('offset'); // any new filter starts from the first page
      return next;
    });
  };

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchText !== (params.get('q') ?? '')) update({ q: searchText.trim() || null });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const page = useQuery({ queryKey: ['transactions', filters], queryFn: () => api.transactions(filters), placeholderData: keepPreviousData });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    void queryClient.invalidateQueries({ queryKey: ['summary'] });
    void queryClient.invalidateQueries({ queryKey: ['categories'] });
  };

  const createRule = useMutation({
    mutationFn: api.createRule,
    onSuccess: (result) => {
      toast({ message: `Rule saved. ${plural(result.recategorized, 'transaction')} updated.` });
      void queryClient.invalidateQueries({ queryKey: ['rules'] });
      refresh();
    },
    onError: (error) => toast({ message: error instanceof Error ? error.message : 'Could not save the rule.' }),
  });

  const recategorize = useMutation({
    mutationFn: ({ txn, categoryId }: { txn: Transaction; categoryId: number }) => api.updateTransaction(txn.id, { categoryId }),
    onSuccess: (updated, { txn }) => {
      refresh();
      // One correction can become a rule, so the same merchant never needs fixing again.
      toast({
        message: `${updated.merchant} moved to ${updated.categoryName}.`,
        action: { label: `Always do this for ${txn.merchant}`, run: () => createRule.mutate({ pattern: txn.merchant, categoryId: updated.categoryId }) },
      });
    },
    onError: (error) => toast({ message: error instanceof Error ? error.message : 'Could not update the category.' }),
  });

  const remove = useMutation({
    mutationFn: (txn: Transaction) => api.deleteTransaction(txn.id),
    onSuccess: () => {
      refresh();
      toast({ message: 'Transaction deleted.' });
    },
  });

  const sortBy = (column: Sort) => update({ sort: column, order: filters.sort === column && filters.order === 'desc' ? 'asc' : 'desc' });
  const sortState = (column: Sort) => (filters.sort === column ? (filters.order === 'asc' ? 'ascending' : 'descending') : 'none');
  const activeCategory = categories.data?.find((c) => c.id === filters.categoryId);
  const total = page.data?.total ?? 0;
  const offset = filters.offset ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Transactions</h1>
          <p className="page-sub">
            {page.data ? plural(total, 'transaction') : 'Loading'}
            {filters.importId ? ' · on one statement' : filters.from && filters.to ? ` · ${dateRange(filters.from, filters.to)}` : ' · all dates'}
          </p>
        </div>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Add transaction</button>
      </div>

      <div className="card">
        <div className="toolbar">
          <label className="grow" style={{ position: 'relative' }}>
            <span className="sr-only">Search transactions</span>
            <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--ink-3)' }}><Icon name="search" size={16} /></span>
            <input className="input" style={{ width: '100%', paddingLeft: 34 }} type="search" placeholder="Search merchant, description or notes" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          </label>
          <select className="select" aria-label="Category" value={filters.categoryId ?? ''} onChange={(e) => update({ categoryId: e.target.value || null })}>
            <option value="">All categories</option>
            {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="select" aria-label="Type" value={filters.type ?? ''} onChange={(e) => update({ type: e.target.value || null })}>
            <option value="">All types</option>
            <option value="purchase">Purchases</option>
            <option value="refund">Refunds</option>
            <option value="payment">Card payments</option>
            <option value="credit">Reward credits</option>
            <option value="fee">Fees</option>
            <option value="interest">Interest</option>
          </select>
          {filters.from || filters.q || filters.categoryId || filters.type || filters.importId ? (
            <button type="button" className="btn ghost" onClick={() => { setSearchText(''); setParams({}); }}>Clear filters</button>
          ) : null}
        </div>

        {page.isError ? <ErrorNote error={page.error} /> : null}
        {!page.data && !page.isError ? <Skeleton height={320} /> : null}
        {page.data && page.data.items.length === 0 ? (
          <div className="empty">
            <p>No transactions match{activeCategory ? ` in ${activeCategory.name}` : ''}. Try a wider date range or clear the filters.</p>
          </div>
        ) : null}
        {page.data && page.data.items.length > 0 ? (
          <div className={`table-wrap${page.isPlaceholderData ? ' is-refreshing' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" aria-sort={sortState('date')}><button type="button" onClick={() => sortBy('date')}>Date{filters.sort === 'date' ? <Icon name={filters.order === 'asc' ? 'up' : 'down'} size={12} /> : null}</button></th>
                  <th scope="col" aria-sort={sortState('merchant')}><button type="button" onClick={() => sortBy('merchant')}>Merchant{filters.sort === 'merchant' ? <Icon name={filters.order === 'asc' ? 'up' : 'down'} size={12} /> : null}</button></th>
                  <th scope="col">Category</th>
                  <th scope="col" className="right" aria-sort={sortState('amount')}><button type="button" onClick={() => sortBy('amount')}>Amount{filters.sort === 'amount' ? <Icon name={filters.order === 'asc' ? 'up' : 'down'} size={12} /> : null}</button></th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((txn) => (
                  <TransactionRow
                    key={txn.id}
                    txn={txn}
                    categories={categories.data ?? []}
                    onCategory={(categoryId) => recategorize.mutate({ txn, categoryId })}
                    onReceipt={() => setReceiptId(txn.receiptId)}
                    onDelete={() => {
                      if (window.confirm(`Delete this ${money(txn.amountCents)} transaction at ${txn.merchant}? This cannot be undone.`)) remove.mutate(txn);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {total > PAGE_SIZE ? (
          <div className="pager">
            <span>{offset + 1}&ndash;{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString('en-CA')}</span>
            <div className="row">
              <button type="button" className="btn small" disabled={offset === 0} onClick={() => update({ offset: Math.max(0, offset - PAGE_SIZE) || null })}>Previous</button>
              <button type="button" className="btn small" disabled={offset + PAGE_SIZE >= total} onClick={() => update({ offset: offset + PAGE_SIZE })}>Next</button>
            </div>
          </div>
        ) : null}
      </div>

      {receiptId !== null ? <ReceiptDrawer receiptId={receiptId} onClose={() => setReceiptId(null)} /> : null}
      {adding ? <AddTransactionDialog categories={categories.data ?? []} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); toast({ message: 'Transaction added.' }); }} /> : null}
    </>
  );
}

function TransactionRow({ txn, categories, onCategory, onReceipt, onDelete }: {
  txn: Transaction;
  categories: Category[];
  onCategory: (categoryId: number) => void;
  onReceipt: () => void;
  onDelete: () => void;
}) {
  const incoming = txn.amountCents < 0;
  return (
    <tr>
      <td className="num" style={{ whiteSpace: 'nowrap' }}>{longDate(txn.txnDate)}</td>
      <td>
        <div className="cell-main">
          {txn.merchant}
          {txn.receiptId ? (
            <button type="button" className="chip blue" style={{ marginLeft: 8 }} onClick={onReceipt} title="Show the itemized receipt">
              <Icon name="receipt" size={12} />Receipt
            </button>
          ) : null}
          {txn.type !== 'purchase' ? <span className="chip outline" style={{ marginLeft: 8 }}>{txn.type}</span> : null}
        </div>
        <div className="cell-sub">{txn.description}{txn.location ? ` · ${txn.location}` : ''}{txn.notes ? ` · ${txn.notes}` : ''}</div>
      </td>
      <td>
        <select
          className="inline-select"
          aria-label={`Category for ${txn.merchant} on ${longDate(txn.txnDate)}`}
          title={SOURCE_LABEL[txn.categorySource]}
          value={txn.categoryId}
          onChange={(e) => onCategory(Number(e.target.value))}
        >
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {txn.categorySource === 'ai' ? <span className="chip" title="Suggested by Claude and saved as a rule"><Icon name="spark" size={11} />AI</span> : null}
      </td>
      <td className={`right num cell-main${incoming ? ' amount-credit' : ''}`} style={{ whiteSpace: 'nowrap' }}>
        {incoming ? `+${money(-txn.amountCents)}` : money(txn.amountCents)}
      </td>
      <td className="right">
        <button type="button" className="btn ghost small" onClick={onDelete}><Icon name="trash" size={15} label={`Delete ${txn.merchant} transaction`} /></button>
      </td>
    </tr>
  );
}

function AddTransactionDialog({ categories, onClose, onSaved }: { categories: Category[]; onClose: () => void; onSaved: () => void }) {
  useOverlay(onClose);
  const [form, setForm] = useState({ txnDate: todayIso(), description: '', amount: '', categoryId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: api.createTransaction,
    onSuccess: onSaved,
    onError: (error) => {
      if (error instanceof ApiError && error.fieldErrors.length) {
        setErrors(Object.fromEntries(error.fieldErrors.map((f) => [f.field, f.message])));
      } else {
        setErrors({ form: error instanceof Error ? error.message : 'Could not save.' });
      }
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const amountCents = parseDollars(form.amount);
    const next: Record<string, string> = {};
    if (!form.description.trim()) next['description'] = 'Say where the money went.';
    if (amountCents === null || amountCents === 0) next['amountCents'] = 'Enter an amount such as 12.50.';
    setErrors(next);
    if (Object.keys(next).length || amountCents === null) return;
    save.mutate({
      txnDate: form.txnDate,
      description: form.description.trim(),
      amountCents,
      ...(form.categoryId ? { categoryId: Number(form.categoryId) } : {}),
    });
  };

  return (
    <div className="scrim center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-label="Add transaction" onSubmit={submit} noValidate>
        <h2>Add a transaction</h2>
        <p className="muted" style={{ marginTop: -6 }}>For cash and anything that never reaches a statement.</p>
        <Field label="Where" error={errors['description']}>
          {(props) => <input {...props} className="input" autoFocus value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Farmers market" />}
        </Field>
        <div className="row" style={{ alignItems: 'start' }}>
          <Field label="Amount" error={errors['amountCents']} style={{ flex: 1 }}>
            {(props) => <input {...props} className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="12.50" />}
          </Field>
          <Field label="Date" error={errors['txnDate']} style={{ flex: 1 }}>
            {(props) => <input {...props} className="input" type="date" value={form.txnDate} max={todayIso()} onChange={(e) => setForm({ ...form, txnDate: e.target.value })} />}
          </Field>
        </div>
        <Field label="Category">
          {(props) => (
            <select {...props} className="select" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">Choose automatically</option>
              {categories.filter((c) => c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </Field>
        {errors['form'] ? <span className="field-error" role="alert">{errors['form']}</span> : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Add transaction'}</button>
        </div>
      </form>
    </div>
  );
}

interface FieldControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

/**
 * A labeled control with its error message. The error is tied to the input
 * with aria-describedby rather than placed inside the label, so the field's
 * name stays "Amount" and a screen reader announces the problem separately.
 */
function Field({ label, error, style, children }: {
  label: string;
  error?: string | undefined;
  style?: React.CSSProperties;
  children: (props: FieldControlProps) => React.ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="field" style={style}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': error ? errorId : undefined })}
      {error ? <span id={errorId} className="field-error">{error}</span> : null}
    </div>
  );
}
