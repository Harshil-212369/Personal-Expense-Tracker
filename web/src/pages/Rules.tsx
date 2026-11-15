import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote, Skeleton, useToast } from '../components/common.tsx';
import { Icon } from '../components/Icon.tsx';
import { api } from '../lib/api.ts';
import type { Rule } from '../lib/api.ts';
import { plural } from '../lib/format.ts';

const SOURCE: Record<Rule['source'], { label: string; chip: string }> = {
  user: { label: 'Yours', chip: 'chip blue' },
  ai: { label: 'Claude', chip: 'chip' },
  seed: { label: 'Built in', chip: 'chip outline' },
};

export function Rules() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(false);

  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const rules = useQuery({ queryKey: ['rules'], queryFn: api.rules });
  const refreshAll = () => void queryClient.invalidateQueries();
  const fail = (error: unknown) => toast({ message: error instanceof Error ? error.message : 'That did not work.' });

  const addRule = useMutation({
    mutationFn: api.createRule,
    onSuccess: (result) => {
      setPattern('');
      refreshAll();
      toast({ message: `Rule saved. ${plural(result.recategorized, 'transaction')} updated.` });
    },
    onError: fail,
  });
  const removeRule = useMutation({
    mutationFn: (rule: Rule) => api.deleteRule(rule.id),
    onSuccess: (result) => {
      refreshAll();
      toast({ message: `Rule removed. ${plural(result.recategorized, 'transaction')} re-categorized.` });
    },
    onError: fail,
  });
  const addCategory = useMutation({
    mutationFn: api.createCategory,
    onSuccess: () => {
      setNewCategory('');
      refreshAll();
    },
    onError: fail,
  });
  const removeCategory = useMutation({ mutationFn: api.deleteCategory, onSuccess: refreshAll, onError: fail });
  const aiCategorize = useMutation({
    mutationFn: api.aiCategorize,
    onSuccess: (result) => {
      refreshAll();
      toast({
        message: result.merchantsSent === 0
          ? 'Nothing is uncategorized.'
          : `Claude categorized ${plural(result.rulesCreated, 'merchant')}; ${plural(result.recategorized, 'transaction')} updated.`,
      });
    },
    onError: fail,
  });

  if (categories.isError) return <ErrorNote error={categories.error} />;
  const uncategorized = categories.data?.find((c) => c.name === 'Uncategorized')?.transactionCount ?? 0;
  const visibleRules = (rules.data ?? []).filter((r) => showBuiltIn || r.source !== 'seed');
  const builtInCount = (rules.data ?? []).filter((r) => r.source === 'seed').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Categories &amp; rules</h1>
          <p className="page-sub">
            A rule sends every transaction whose description contains some text to a category. Your rules win over
            Claude's suggestions, which win over the built-in ones. A category you set by hand on a transaction is never overridden.
          </p>
        </div>
      </div>

      <div className="grid">
        <section className="card span-7 stack" aria-labelledby="rules-title">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <div>
              <h2 className="card-title" id="rules-title">Rules</h2>
              <p className="card-sub">{uncategorized > 0 ? `${plural(uncategorized, 'transaction')} still uncategorized` : 'Everything is categorized'}</p>
            </div>
            {health.data?.ai.enabled && uncategorized > 0 ? (
              <button type="button" className="btn small" onClick={() => aiCategorize.mutate()} disabled={aiCategorize.isPending} title="Sends merchant names only: no amounts, dates or other details">
                <Icon name="spark" size={15} />
                {aiCategorize.isPending ? 'Asking Claude…' : 'Categorize the rest with Claude'}
              </button>
            ) : null}
          </div>

          <form
            className="row"
            style={{ alignItems: 'end' }}
            onSubmit={(event) => {
              event.preventDefault();
              if (pattern.trim().length >= 2 && categoryId) addRule.mutate({ pattern: pattern.trim(), categoryId: Number(categoryId) });
            }}
          >
            <label className="field" style={{ flex: '2 1 180px' }}>When the description contains
              <input className="input" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. Corner Bakery" maxLength={60} />
            </label>
            <label className="field" style={{ flex: '1 1 150px' }}>put it in
              <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Choose a category</option>
                {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <button type="submit" className="btn primary" disabled={pattern.trim().length < 2 || !categoryId || addRule.isPending}>Add rule</button>
          </form>

          {!rules.data ? <Skeleton height={200} /> : null}
          {rules.data && visibleRules.length === 0 ? <p className="muted">No rules of your own yet. Changing a transaction's category offers to create one.</p> : null}
          {visibleRules.length > 0 ? (
            <div className="table-wrap" style={{ maxHeight: 460, overflowY: 'auto' }}>
              <table className="table">
                <thead><tr><th scope="col">Contains</th><th scope="col">Category</th><th scope="col">From</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
                <tbody>
                  {visibleRules.map((rule) => (
                    <tr key={rule.id}>
                      <td className="num cell-main">{rule.pattern}</td>
                      <td>{rule.categoryName}</td>
                      <td><span className={SOURCE[rule.source].chip}>{SOURCE[rule.source].label}</span></td>
                      <td className="right">
                        <button type="button" className="btn ghost small" onClick={() => removeRule.mutate(rule)} disabled={removeRule.isPending}>
                          <Icon name="trash" size={15} label={`Remove rule ${rule.pattern}`} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <button type="button" className="btn ghost small" style={{ justifySelf: 'start' }} onClick={() => setShowBuiltIn(!showBuiltIn)} aria-expanded={showBuiltIn}>
            {showBuiltIn ? 'Hide' : 'Show'} {builtInCount} built-in rules
          </button>
        </section>

        <section className="card span-5 stack" aria-labelledby="categories-title">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h2 className="card-title" id="categories-title">Categories</h2>
          </div>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              if (newCategory.trim().length >= 2) addCategory.mutate(newCategory.trim());
            }}
          >
            <label className="sr-only" htmlFor="new-category">New category name</label>
            <input id="new-category" className="input" style={{ flex: 1 }} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="New category" maxLength={40} />
            <button type="submit" className="btn" disabled={newCategory.trim().length < 2 || addCategory.isPending}>Add</button>
          </form>
          {!categories.data ? <Skeleton height={200} /> : (
            <div className="list">
              {categories.data.map((c) => (
                <div className="list-row" key={c.id} style={{ padding: '8px 0' }}>
                  <div>
                    <span className="cell-main">{c.name}</span>
                    {c.kind === 'excluded' ? <span className="chip outline" style={{ marginLeft: 8 }} title="Kept for the record but left out of spending totals">Not counted as spending</span> : null}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="num muted">{c.transactionCount}</span>
                    {!c.isSystem ? (
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => {
                          if (window.confirm(`Delete "${c.name}"? Its ${c.transactionCount} transactions go back to automatic categorization.`)) removeCategory.mutate(c.id);
                        }}
                      >
                        <Icon name="trash" size={15} label={`Delete category ${c.name}`} />
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
