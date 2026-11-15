import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { signedPercent } from '../lib/format.ts';
import { Icon } from './Icon.tsx';

/**
 * Change versus the previous period. For spending, up is the direction to
 * notice, so up is red and down is blue; the arrow and sign carry the same
 * meaning for anyone who cannot tell the colors apart.
 */
export function Delta({ ratio }: { ratio: number | null }) {
  if (ratio === null) return null;
  const rounded = Math.round(ratio * 100);
  const direction = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
  const words = direction === 'up' ? 'more than' : direction === 'down' ? 'less than' : 'the same as';
  return (
    <span className={`delta ${direction}`} title={`${Math.abs(rounded)}% ${words} the previous period`}>
      <Icon name={direction} size={13} />
      <span>{signedPercent(ratio)}</span>
      <span className="sr-only">{words} the previous period</span>
    </span>
  );
}

export function StatTile({ label, value, foot, hero = false }: { label: string; value: string; foot?: ReactNode; hero?: boolean }) {
  return (
    <div className={`tile${hero ? ' hero' : ''}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {foot ? <span className="tile-foot">{foot}</span> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function FirstRun() {
  return (
    <EmptyState
      title="No transactions yet"
      action={<Link className="btn primary" to="/import"><Icon name="upload" size={16} />Import a statement</Link>}
    >
      Import a card statement (PDF or CSV) or a receipt email to see where your money goes. Files are read on this
      computer and never uploaded anywhere. To explore with invented data first, stop the server and
      run <code className="inline">npm run demo</code>.
    </EmptyState>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="banner warn" role="alert">
      <Icon name="alert" />
      <span>{message}</span>
    </div>
  );
}

export function Skeleton({ height }: { height: number }) {
  return <div className="skeleton" style={{ height }} aria-hidden="true" />;
}

// --- Toasts -----------------------------------------------------------------

interface Toast {
  message: string;
  action?: { label: string; run: () => void };
}
const ToastContext = createContext<(toast: Toast) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.action ? 9000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const show = useCallback((next: Toast) => setToast(next), []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Closes an overlay on Escape and restores focus to whatever opened it. */
export function useOverlay(onClose: () => void) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);
}
