import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';

export interface DataTable {
  columns: string[];
  rows: Array<Array<string | number>>;
  /** Column indexes to right-align (numbers). */
  numeric?: number[];
}

interface Props {
  title: string;
  subtitle?: ReactNode;
  className?: string;
  /** The same data as a table. Every chart offers one, so no value is reachable only by hovering. */
  table?: DataTable;
  actions?: ReactNode;
  refreshing?: boolean;
  children: ReactNode;
}

export function ChartCard({ title, subtitle, className = '', table, actions, refreshing, children }: Props) {
  const [showTable, setShowTable] = useState(false);
  const headingId = useId();
  return (
    <section className={`card ${className}`} aria-labelledby={headingId}>
      <div className="card-head">
        <div>
          <h2 className="card-title" id={headingId}>{title}</h2>
          {subtitle ? <p className="card-sub">{subtitle}</p> : null}
        </div>
        <div className="row" style={{ gap: 4 }}>
          {actions}
          {table ? (
            <button type="button" className="btn ghost small" aria-pressed={showTable} onClick={() => setShowTable(!showTable)} title={showTable ? 'Show chart' : 'Show as table'}>
              <Icon name={showTable ? 'chart' : 'table'} size={15} label={showTable ? 'Show chart' : 'Show as table'} />
            </button>
          ) : null}
        </div>
      </div>
      <div className={refreshing ? 'is-refreshing' : undefined}>
        {showTable && table ? <TableView table={table} caption={title} /> : children}
      </div>
    </section>
  );
}

function TableView({ table, caption }: { table: DataTable; caption: string }) {
  const numeric = new Set(table.numeric ?? []);
  return (
    <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{table.columns.map((c, i) => <th key={c} scope="col" className={numeric.has(i) ? 'right' : undefined}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => <td key={i} className={numeric.has(i) ? 'right num' : undefined}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface TooltipRow {
  label: string;
  value: string;
  /** CSS color of the series key; omit for a plain row. */
  color?: string;
}

/** One tooltip style for every chart: the value leads, the series name follows. */
export function ChartTooltip({ x, y, title, rows }: { x: number; y: number; title: string; rows: TooltipRow[] }) {
  return (
    <div className="tooltip" style={{ left: x, top: y }} role="status">
      <div className="tooltip-title">{title}</div>
      {rows.map((row) => (
        <div className="tooltip-row" key={row.label}>
          <span className="tooltip-key">
            {row.color ? <span className="key-line" style={{ color: row.color }} /> : null}
            {row.label}
          </span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}
