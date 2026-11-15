import { Link } from 'react-router';
import { money, percent } from '../lib/format.ts';

export interface RankedRow {
  key: string;
  name: string;
  cents: number;
  /** Shown beside the value, for example "38%" or "12 visits". */
  note?: string;
  /** Previous-period value, drawn as a tick on the track. */
  previousCents?: number;
  /** Where clicking the row leads. */
  to?: string;
  /** Extra context for assistive tech and the native tooltip. */
  description?: string;
}

/**
 * Part-to-whole as ranked horizontal bars: one hue, largest first, values
 * printed at the end of every row. Bars on a shared baseline compare more
 * accurately than slices of a pie, and the names never need a legend.
 */
export function RankedBars({ rows, showPrevious = false }: { rows: RankedRow[]; showPrevious?: boolean }) {
  const scaleMax = Math.max(1, ...rows.map((r) => Math.max(r.cents, showPrevious ? (r.previousCents ?? 0) : 0)));
  return (
    <div>
      <div className="rank" role="list">
        {rows.map((row) => {
          const width = `${Math.max(0, (row.cents / scaleMax) * 100)}%`;
          const previous = showPrevious && row.previousCents && row.previousCents > 0 ? row.previousCents : null;
          const summary = `${row.name}: ${money(row.cents)}${row.note ? `, ${row.note}` : ''}${previous ? `, previously ${money(previous)}` : ''}${row.description ? `. ${row.description}` : ''}`;
          const content = (
            <>
              <span className="rank-name">{row.name}</span>
              <span className="rank-track" aria-hidden="true">
                <span className="rank-bar" style={{ width }} />
                {previous ? <span className="rank-prev" style={{ left: `calc(${(previous / scaleMax) * 100}% - 1px)` }} /> : null}
              </span>
              <span className="rank-value num">
                {money(row.cents)}
                {row.note ? <small>{row.note}</small> : null}
              </span>
            </>
          );
          return row.to ? (
            <Link key={row.key} role="listitem" className="rank-row" to={row.to} title={summary} aria-label={summary}>{content}</Link>
          ) : (
            <div key={row.key} role="listitem" className="rank-row" style={{ cursor: 'default' }} title={summary} aria-label={summary}>{content}</div>
          );
        })}
      </div>
      {showPrevious && rows.some((r) => (r.previousCents ?? 0) > 0) ? (
        <div className="legend" style={{ marginTop: 12 }}>
          <span className="legend-item"><span className="key-box" style={{ color: 'var(--blue)' }} />This period</span>
          <span className="legend-item"><span style={{ width: 2, height: 14, background: 'var(--ink-2)', borderRadius: 1 }} />Previous period</span>
        </div>
      ) : null}
    </div>
  );
}

export function shareNote(share: number): string {
  return share > 0 && share < 0.005 ? '<1%' : percent(share);
}
