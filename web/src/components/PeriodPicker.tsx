import { useEffect, useId, useRef, useState } from 'react';
import type { Range } from '../lib/api.ts';
import { dateRange } from '../lib/format.ts';
import type { PeriodOption } from '../lib/periods.ts';
import { Icon } from './Icon.tsx';

interface Props {
  range: Range;
  options: PeriodOption[];
  selected: PeriodOption | undefined;
  onChange: (range: Range) => void;
}

/**
 * Presets listed as rows (nobody wants to fight a calendar grid to ask for
 * "the latest statement"), with a custom range tucked underneath.
 */
export function PeriodPicker({ range, options, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(range);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => setDraft(range), [range]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (next: Range) => {
    onChange(next);
    setOpen(false);
  };
  const draftValid = draft.from && draft.to && draft.from <= draft.to;

  return (
    <div className="period" ref={root}>
      <button type="button" className="btn" aria-haspopup="true" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
        <Icon name="calendar" size={16} />
        <span>
          {selected ? `${selected.label} · ` : ''}
          {dateRange(range.from, range.to)}
        </span>
        <Icon name="chevron" size={15} />
      </button>
      {open && (
        <div className="period-menu" id={menuId} role="group" aria-label="Choose a period">
          {options.map((option) => (
            <button key={option.id} type="button" className="period-row" onClick={() => choose(option.range)} aria-pressed={option.id === selected?.id}>
              <span aria-hidden="true">{option.id === selected?.id ? <Icon name="check" size={16} /> : null}</span>
              <span>
                {option.label}
                {option.hint ? <small>{option.hint}</small> : null}
              </span>
            </button>
          ))}
          <form
            className="period-custom"
            onSubmit={(event) => {
              event.preventDefault();
              if (draftValid) choose(draft);
            }}
          >
            <span className="muted" style={{ fontSize: 12.5 }}>Custom range</span>
            <div className="period-custom-row">
              <input className="input" type="date" aria-label="From" value={draft.from} max={draft.to} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              <input className="input" type="date" aria-label="To" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              <button className="btn small primary" type="submit" disabled={!draftValid}>Apply</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
