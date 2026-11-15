import { scaleLinear } from 'd3-scale';
import { useState } from 'react';
import { ChartTooltip } from '../components/ChartCard.tsx';
import type { TooltipRow } from '../components/ChartCard.tsx';
import { useElementWidth } from '../hooks/useElementWidth.ts';
import { moneyAxis } from '../lib/format.ts';

export interface Column {
  key: string;
  /** Axis label; shown only on the ticks chosen by `tickEvery`. */
  label: string;
  cents: number;
  tooltipTitle: string;
  tooltipRows: TooltipRow[];
}

interface Props {
  columns: Column[];
  height?: number;
  /** Label every nth column on the x axis. */
  tickEvery?: number;
  ariaLabel: string;
}

const MARGIN = { top: 22, right: 8, bottom: 26, left: 54 };
const MAX_BAR = 24;

/** Rounded top-left and top-right corners, square at the baseline. */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/**
 * A single-series column chart. One hue, thin bars, the tallest column
 * labeled directly and everything else left to the axis and the tooltip.
 */
export function ColumnChart({ columns, height = 220, tickEvery = 1, ariaLabel }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const innerW = Math.max(120, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const band = innerW / Math.max(1, columns.length);
  const barWidth = Math.max(2, Math.min(MAX_BAR, band - 2));
  const peak = Math.max(1, ...columns.map((c) => c.cents));
  const y = scaleLinear().domain([0, peak]).nice(4).range([innerH, 0]);
  const peakIndex = columns.findIndex((c) => c.cents === peak);
  const center = (i: number) => band * i + band / 2;
  const active = hover !== null ? columns[hover] : undefined;

  return (
    <div className="chart" ref={ref}>
      <svg
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`${ariaLabel} Use the arrow keys to read each value.`}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') setHover(Math.min(columns.length - 1, (hover ?? -1) + 1));
          else if (event.key === 'ArrowLeft') setHover(Math.max(0, (hover ?? columns.length) - 1));
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
          {columns.map((column, i) => {
            const top = y(Math.max(0, column.cents));
            const barHeight = innerH - top;
            return (
              <g key={column.key}>
                {barHeight > 0 ? (
                  <path
                    d={columnPath(center(i) - barWidth / 2, top, barWidth, barHeight)}
                    fill="var(--blue)"
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                ) : null}
                {i % tickEvery === 0 ? (
                  <text className="axis-text" x={center(i)} y={innerH + 19} textAnchor="middle">{column.label}</text>
                ) : null}
              </g>
            );
          })}
          {peakIndex >= 0 && columns[peakIndex]!.cents > 0 && hover === null ? (
            <text className="label-strong" x={center(peakIndex)} y={y(peak) - 7} textAnchor={peakIndex < 2 ? 'start' : peakIndex > columns.length - 3 ? 'end' : 'middle'}>
              {moneyAxis(peak)}
            </text>
          ) : null}
          {/* One wide hit area: the pointer only has to be nearest a column, not on it. */}
          <rect
            width={innerW}
            height={innerH}
            fill="transparent"
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setHover(Math.max(0, Math.min(columns.length - 1, Math.floor((event.clientX - box.left) / band))));
            }}
            onPointerLeave={() => setHover(null)}
          />
        </g>
      </svg>
      {active && hover !== null ? (
        <ChartTooltip
          x={MARGIN.left + center(hover)}
          y={MARGIN.top + y(Math.max(0, active.cents))}
          title={active.tooltipTitle}
          rows={active.tooltipRows}
        />
      ) : null}
    </div>
  );
}
