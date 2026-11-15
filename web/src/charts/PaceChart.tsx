import { scaleLinear } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import { useState } from 'react';
import { ChartTooltip } from '../components/ChartCard.tsx';
import { useElementWidth } from '../hooks/useElementWidth.ts';
import type { TimeseriesPoint } from '../lib/api.ts';
import { money, moneyAxis, shortDate } from '../lib/format.ts';

interface Props {
  current: TimeseriesPoint[];
  previous: TimeseriesPoint[] | null;
  /** Days after this date have not happened yet and are not drawn. */
  today: string;
}

const HEIGHT = 250;
const MARGIN = { top: 16, right: 86, bottom: 28, left: 54 };

/**
 * Cumulative spending through the period against the previous period, aligned
 * by day number. It answers "am I ahead of or behind last time, and since
 * when?", which a pair of totals cannot.
 */
export function PaceChart({ current, previous, today }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const shown = current.filter((p) => p.date <= today);
  const days = Math.max(current.length, previous?.length ?? 0, 2);
  const innerW = Math.max(120, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const peak = Math.max(1, ...shown.map((p) => p.cumulativeCents), ...(previous ?? []).map((p) => p.cumulativeCents));

  const x = scaleLinear().domain([0, days - 1]).range([0, innerW]);
  const y = scaleLinear().domain([0, peak]).nice(4).range([innerH, 0]);
  const path = line<TimeseriesPoint>().x((_d, i) => x(i)).y((d) => y(d.cumulativeCents)).curve(curveMonotoneX);
  const wash = area<TimeseriesPoint>().x((_d, i) => x(i)).y0(innerH).y1((d) => y(d.cumulativeCents)).curve(curveMonotoneX);

  const lastCurrent = shown.at(-1);
  const lastPrevious = previous?.at(-1);
  const endCurrentY = lastCurrent ? y(lastCurrent.cumulativeCents) : 0;
  const endPreviousY = lastPrevious ? y(lastPrevious.cumulativeCents) : 0;
  // Two end labels that would overlap are worse than one: the legend and tooltip still carry the other.
  const showPreviousLabel = !!lastPrevious && (!lastCurrent || Math.abs(endCurrentY - endPreviousY) > 30);

  const tickStep = Math.max(1, Math.ceil(days / 6));
  const xTicks = Array.from({ length: days }, (_unused, i) => i).filter((i) => i % tickStep === 0 && i < current.length);

  const indexAt = (clientX: number, target: SVGElement) => {
    const box = target.getBoundingClientRect();
    return Math.max(0, Math.min(days - 1, Math.round(x.invert(clientX - box.left))));
  };
  const hoverCurrent = hover !== null ? shown[hover] : undefined;
  const hoverPrevious = hover !== null ? previous?.[hover] : undefined;
  const hoverTop = Math.min(
    hoverCurrent ? y(hoverCurrent.cumulativeCents) : innerH,
    hoverPrevious ? y(hoverPrevious.cumulativeCents) : innerH,
  );

  return (
    <div>
      <div className="chart" ref={ref}>
        <svg
          height={HEIGHT}
          role="img"
          tabIndex={0}
          aria-label={`Cumulative spending by day. ${lastCurrent ? `${money(lastCurrent.cumulativeCents)} so far this period` : 'No spending yet'}${lastPrevious ? `, ${money(lastPrevious.cumulativeCents)} in the previous period` : ''}. Use the arrow keys to read each day.`}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') setHover(Math.min(days - 1, (hover ?? -1) + 1));
            else if (event.key === 'ArrowLeft') setHover(Math.max(0, (hover ?? days) - 1));
            else if (event.key === 'Escape') setHover(null);
            else return;
            event.preventDefault();
          }}
          onBlur={() => setHover(null)}
        >
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {y.ticks(4).map((tick) => (
              <g key={tick} transform={`translate(0,${y(tick)})`}>
                <line className={tick === 0 ? 'base-line' : 'grid-line'} x2={innerW} />
                <text className="axis-text" x={-10} dy="0.32em" textAnchor="end">{moneyAxis(tick)}</text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} className="axis-text" x={x(i)} y={innerH + 19} textAnchor={i === 0 ? 'start' : 'middle'}>
                {shortDate(current[i]!.date)}
              </text>
            ))}

            {previous && previous.length > 1 ? (
              <path d={path(previous) ?? undefined} fill="none" stroke="var(--context)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ) : null}
            {shown.length > 1 ? (
              <>
                <path d={wash(shown) ?? undefined} fill="var(--blue-wash)" />
                <path d={path(shown) ?? undefined} fill="none" stroke="var(--blue)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </>
            ) : null}

            {lastPrevious && previous ? (
              <g transform={`translate(${x(previous.length - 1)},${endPreviousY})`}>
                <circle r={4.5} fill="var(--context)" stroke="var(--surface)" strokeWidth={2} />
                {showPreviousLabel ? (
                  <text x={10} dy="0.32em" className="label-text">{moneyAxis(lastPrevious.cumulativeCents)}</text>
                ) : null}
              </g>
            ) : null}
            {lastCurrent ? (
              <g transform={`translate(${x(shown.length - 1)},${endCurrentY})`}>
                <circle r={4.5} fill="var(--blue)" stroke="var(--surface)" strokeWidth={2} />
                <text x={10} dy="0.32em" className="label-strong">{moneyAxis(lastCurrent.cumulativeCents)}</text>
              </g>
            ) : null}

            {hover !== null ? (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={0} y2={innerH} stroke="var(--ink-3)" strokeWidth={1} />
                {hoverPrevious ? <circle cx={x(hover)} cy={y(hoverPrevious.cumulativeCents)} r={4.5} fill="var(--context)" stroke="var(--surface)" strokeWidth={2} /> : null}
                {hoverCurrent ? <circle cx={x(hover)} cy={y(hoverCurrent.cumulativeCents)} r={4.5} fill="var(--blue)" stroke="var(--surface)" strokeWidth={2} /> : null}
              </g>
            ) : null}

            <rect
              width={innerW}
              height={innerH}
              fill="transparent"
              onPointerMove={(event) => setHover(indexAt(event.clientX, event.currentTarget))}
              onPointerLeave={() => setHover(null)}
            />
          </g>
        </svg>

        {hover !== null && (hoverCurrent || hoverPrevious) ? (
          <ChartTooltip
            x={MARGIN.left + x(hover)}
            y={MARGIN.top + hoverTop}
            title={`Day ${hover + 1}${hoverCurrent ? ` · ${shortDate(hoverCurrent.date)}` : ''}`}
            rows={[
              ...(hoverCurrent ? [{ label: 'This period', value: money(hoverCurrent.cumulativeCents), color: 'var(--blue)' }] : []),
              ...(hoverPrevious ? [{ label: 'Previous', value: money(hoverPrevious.cumulativeCents), color: 'var(--context)' }] : []),
            ]}
          />
        ) : null}
      </div>
      {previous ? (
        <div className="legend" style={{ marginTop: 6 }}>
          <span className="legend-item"><span className="key-line" style={{ color: 'var(--blue)' }} />This period</span>
          <span className="legend-item"><span className="key-line" style={{ color: 'var(--context)' }} />Previous period</span>
        </div>
      ) : null}
    </div>
  );
}
