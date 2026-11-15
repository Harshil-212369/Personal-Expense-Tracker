import { useState } from 'react';
import type { CSSProperties } from 'react';
import { ChartTooltip } from '../components/ChartCard.tsx';
import type { DailyCell } from '../lib/api.ts';
import { addDays, longDate, money, plural, shortDate, weekdayIndex, WEEKDAYS, WEEKDAYS_LONG } from '../lib/format.ts';

const LEVELS = 5;

/**
 * Buckets a day's spending into one of five steps of a single-hue ramp.
 * Square-root scaling keeps one very large purchase from flattening every
 * other day into the palest step.
 */
export function heatLevel(cents: number, peak: number): number {
  if (cents <= 0 || peak <= 0) return 0;
  return Math.max(1, Math.min(LEVELS, Math.ceil(Math.sqrt(cents / peak) * LEVELS)));
}

/** A label for each week column: the month is named only where it changes. */
export function weekLabels(firstMonday: string, weeks: number): string[] {
  const labels: string[] = [];
  let lastMonth = '';
  const every = weeks > 16 ? 4 : weeks > 8 ? 2 : 1;
  for (let week = 0; week < weeks; week++) {
    const monday = addDays(firstMonday, week * 7);
    const month = monday.slice(0, 7);
    if (week % every !== 0) labels.push('');
    else if (month !== lastMonth) labels.push(shortDate(monday));
    else labels.push(String(Number(monday.slice(8))));
    if (week % every === 0) lastMonth = month;
  }
  return labels;
}

/** One cell per day, weeks as columns, Monday at the top. Darker means more was spent. */
export function CalendarHeatmap({ days }: { days: DailyCell[] }) {
  const [hover, setHover] = useState<{ cell: DailyCell; x: number; y: number } | null>(null);
  if (days.length === 0) return null;

  const peak = Math.max(0, ...days.map((d) => d.cents));
  const leading = weekdayIndex(days[0]!.date);
  const weeks = Math.ceil((leading + days.length) / 7);
  // A month gets large cells; a year still fits the card.
  const cell = weeks <= 6 ? 36 : weeks <= 14 ? 28 : weeks <= 28 ? 20 : 14;
  const labels = weekLabels(addDays(days[0]!.date, -leading), weeks);

  const show = (target: DailyCell, element: HTMLElement) => {
    const parent = element.closest('.chart') as HTMLElement;
    const a = element.getBoundingClientRect();
    const b = parent.getBoundingClientRect();
    setHover({ cell: target, x: a.left - b.left + a.width / 2, y: a.top - b.top });
  };

  return (
    <div className="heat" style={{ '--cell': `${cell}px` } as CSSProperties}>
      <div className="chart">
        <div className="heat-wrap">
          <div className="heat-days" aria-hidden="true">
            {WEEKDAYS.map((day, i) => <span key={day}>{i % 2 === 0 ? day : ''}</span>)}
          </div>
          <div>
            <div className="heat-grid" role="group" aria-label="Spending by day">
              {Array.from({ length: leading }, (_unused, i) => <span key={`blank-${i}`} className="heat-cell blank" />)}
              {days.map((day) => {
                const level = heatLevel(day.cents, peak);
                const label = `${WEEKDAYS_LONG[weekdayIndex(day.date)]}, ${longDate(day.date)}: ${day.cents > 0 ? `${money(day.cents)} across ${plural(day.count, 'purchase')}` : 'no spending'}`;
                return (
                  <button
                    key={day.date}
                    type="button"
                    className="heat-cell"
                    style={{ background: `var(--seq-${level})` }}
                    aria-label={label}
                    onPointerEnter={(e) => show(day, e.currentTarget)}
                    onPointerLeave={() => setHover(null)}
                    onFocus={(e) => show(day, e.currentTarget)}
                    onBlur={() => setHover(null)}
                  />
                );
              })}
            </div>
            <div className="heat-weeks" aria-hidden="true">
              {labels.map((label, i) => <span key={i}>{label}</span>)}
            </div>
          </div>
        </div>
        {hover ? (
          <ChartTooltip
            x={hover.x}
            y={hover.y}
            title={`${WEEKDAYS[weekdayIndex(hover.cell.date)]}, ${longDate(hover.cell.date)}`}
            rows={[
              { label: 'Spent', value: money(hover.cell.cents) },
              { label: 'Purchases', value: String(hover.cell.count) },
            ]}
          />
        ) : null}
      </div>
      <div className="heat-scale" aria-hidden="true">
        <span>Nothing</span>
        {Array.from({ length: LEVELS + 1 }, (_unused, level) => <i key={level} style={{ background: `var(--seq-${level})` }} />)}
        <span>{peak > 0 ? money(peak) : 'More'}</span>
      </div>
    </div>
  );
}
