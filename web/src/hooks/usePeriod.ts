import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../lib/api.ts';
import type { Range } from '../lib/api.ts';
import { buildPeriodOptions, defaultPeriod, matchOption } from '../lib/periods.ts';
import type { PeriodOption } from '../lib/periods.ts';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface PeriodState {
  /** False until the statement list and data bounds have loaded. */
  ready: boolean;
  /** True when the ledger has no transactions at all. */
  empty: boolean;
  range: Range;
  options: PeriodOption[];
  selected: PeriodOption | undefined;
  setRange: (range: Range) => void;
}

/**
 * The selected reporting period. It lives in the URL, as ?statement=<id> for a
 * statement or ?from=...&to=... for dates, so a view can be bookmarked and
 * every chart on the page reads the same scope.
 */
export function usePeriod(): PeriodState {
  const [params, setParams] = useSearchParams();
  const imports = useQuery({ queryKey: ['imports'], queryFn: api.imports });
  const overall = useQuery({ queryKey: ['summary', 'all'], queryFn: () => api.summary({ from: '', to: '' }) });

  const options = useMemo(
    () => buildPeriodOptions(imports.data ?? [], overall.data?.dataBounds ?? null),
    [imports.data, overall.data],
  );

  const statement = Number(params.get('statement'));
  const from = params.get('from');
  const to = params.get('to');
  const fromStatement = statement > 0 ? options.find((o) => o.range.importId === statement)?.range : undefined;
  const fromDates = from && to && ISO.test(from) && ISO.test(to) && from <= to ? { from, to } : undefined;
  const range = fromStatement ?? fromDates ?? defaultPeriod(options).range;

  const setRange = useCallback(
    (next: Range) => {
      setParams((current) => {
        const updated = new URLSearchParams(current);
        for (const key of ['statement', 'from', 'to']) updated.delete(key);
        if (next.importId) {
          updated.set('statement', String(next.importId));
        } else {
          updated.set('from', next.from);
          updated.set('to', next.to);
        }
        return updated;
      });
    },
    [setParams],
  );

  return {
    ready: imports.isSuccess && overall.isSuccess,
    empty: overall.isSuccess && overall.data.dataBounds === null,
    range,
    options,
    selected: matchOption(options, range),
    setRange,
  };
}
