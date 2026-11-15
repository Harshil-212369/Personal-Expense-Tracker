import { useQuery } from '@tanstack/react-query';
import { Fragment } from 'react';
import { api } from '../lib/api.ts';
import type { ReceiptItem } from '../lib/api.ts';
import { longDate, money } from '../lib/format.ts';
import { ErrorNote, Skeleton, useOverlay } from './common.tsx';
import { Icon } from './Icon.tsx';

function quantityNote(item: ReceiptItem): string | null {
  if (item.unit && item.unit !== 'ea' && item.quantity && item.unitPriceCents) {
    return `${item.quantity.toFixed(3)} ${item.unit} at ${money(item.unitPriceCents)}/${item.unit}`;
  }
  if (item.quantity && item.quantity > 1 && item.unitPriceCents) return `${item.quantity} at ${money(item.unitPriceCents)}`;
  return null;
}

/** The itemized receipt behind a statement line. */
export function ReceiptDrawer({ receiptId, onClose }: { receiptId: number; onClose: () => void }) {
  useOverlay(onClose);
  const query = useQuery({ queryKey: ['receipt', receiptId], queryFn: () => api.receipt(receiptId) });
  const receipt = query.data;
  const departments = [...new Set((receipt?.items ?? []).map((i) => i.department ?? 'Items'))];
  const itemsTotal = (receipt?.items ?? []).reduce((sum, i) => sum + i.totalCents, 0);

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Receipt">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{receipt ? receipt.merchant : 'Receipt'}</h2>
          <button type="button" className="btn ghost" onClick={onClose} autoFocus><Icon name="x" label="Close" /></button>
        </div>
        {query.isError ? <ErrorNote error={query.error} /> : null}
        {!receipt && !query.isError ? <Skeleton height={300} /> : null}
        {receipt ? (
          <>
            <p className="muted">
              {longDate(receipt.purchasedOn)}{receipt.purchasedTime ? ` at ${receipt.purchasedTime}` : ''}
              {receipt.paymentMethod ? ` · ${receipt.paymentMethod}` : ''}
            </p>
            <div className={`banner ${receipt.arithmeticOk ? 'ok' : 'warn'}`}>
              <Icon name={receipt.arithmeticOk ? 'check' : 'alert'} />
              <span>
                {receipt.arithmeticOk
                  ? 'Verified: the items, discounts and tax add up to the printed total.'
                  : 'The items do not add up to the printed total. Check this receipt by hand.'}
              </span>
            </div>
            <table className="receipt-lines">
              <tbody>
                {departments.map((department) => (
                  <Fragment key={department}>
                    <tr className="receipt-dept"><td colSpan={2}>{department}</td></tr>
                    {receipt.items!.filter((i) => (i.department ?? 'Items') === department).map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.name}
                          {quantityNote(item) ? <div className="cell-sub">{quantityNote(item)}</div> : null}
                          {item.savingCents > 0 ? <div className="cell-sub">Saved {money(item.savingCents)}</div> : null}
                        </td>
                        <td className="num" style={{ textAlign: 'right', verticalAlign: 'top' }}>{money(item.totalCents)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
                {receipt.subtotalCents !== itemsTotal ? (
                  <tr><td>Basket discounts</td><td className="num" style={{ textAlign: 'right' }}>{money(receipt.subtotalCents - itemsTotal)}</td></tr>
                ) : null}
                <tr className="receipt-total"><td>Subtotal</td><td className="num" style={{ textAlign: 'right' }}>{money(receipt.subtotalCents)}</td></tr>
                <tr><td>Tax</td><td className="num" style={{ textAlign: 'right' }}>{money(receipt.taxCents)}</td></tr>
                <tr className="receipt-total"><td>Total</td><td className="num" style={{ textAlign: 'right' }}>{money(receipt.totalCents)}</td></tr>
              </tbody>
            </table>
            {receipt.savingsCents > 0 ? <p className="muted">You saved {money(receipt.savingsCents)} on this trip.</p> : null}
            <p className="muted" style={{ fontSize: 13 }}>
              {receipt.transactionId
                ? 'Matched to a line on your card statement, so it is counted once.'
                : 'Not on an imported statement yet. It will link automatically when that statement is imported.'}
            </p>
          </>
        ) : null}
      </aside>
    </div>
  );
}
