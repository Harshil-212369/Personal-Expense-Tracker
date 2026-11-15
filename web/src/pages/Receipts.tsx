import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { RankedBars } from '../charts/RankedBars.tsx';
import { ChartCard } from '../components/ChartCard.tsx';
import { EmptyState, ErrorNote, Skeleton, StatTile } from '../components/common.tsx';
import { Icon } from '../components/Icon.tsx';
import { ReceiptDrawer } from '../components/ReceiptDrawer.tsx';
import { api } from '../lib/api.ts';
import { longDate, money, plural } from '../lib/format.ts';

export function Receipts() {
  const receipts = useQuery({ queryKey: ['receipts'], queryFn: api.receipts });
  const stats = useQuery({ queryKey: ['analytics', 'groceries'], queryFn: () => api.groceries() });
  const [open, setOpen] = useState<number | null>(null);

  const header = (
    <div className="page-head">
      <div>
        <h1 className="page-title">Receipts</h1>
        <p className="page-sub">Itemized receipts, matched to the statement line they explain so nothing is counted twice.</p>
      </div>
      <Link className="btn" to="/import"><Icon name="upload" size={16} />Import a receipt</Link>
    </div>
  );

  if (receipts.isError) return <>{header}<ErrorNote error={receipts.error} /></>;
  if (!receipts.data || !stats.data) return <>{header}<div className="card"><Skeleton height={240} /></div></>;
  if (receipts.data.length === 0) {
    return (
      <>
        {header}
        <EmptyState title="No receipts yet" action={<Link className="btn primary" to="/import">Import a receipt email</Link>}>
          Metro emails a digital receipt when you scan your loyalty card. Save that email as an .eml file and import it
          here to see every item, its unit price and what you saved.
        </EmptyState>
      </>
    );
  }

  const g = stats.data;
  const weighed = g.items.filter((i) => i.unit && i.unit !== 'ea' && i.lastUnitPriceCents);

  return (
    <>
      {header}
      <div className="grid">
        <section className="card span-12" aria-label="Receipt totals">
          <div className="kv">
            <StatTile label="Receipts" value={String(g.receiptCount)} foot={g.unlinkedReceipts ? `${g.unlinkedReceipts} awaiting a statement` : 'All matched to a statement line'} />
            <StatTile label="Spent" value={money(g.spendCents)} foot={plural(g.itemLines, 'item')} />
            <StatTile label="Saved" value={money(g.savingsCents)} foot="Promotions and loyalty offers" />
            <StatTile label="Sales tax" value={money(g.taxCents)} foot="Most groceries are zero-rated" />
          </div>
        </section>

        <ChartCard
          className="span-7"
          title="What you buy most"
          subtitle="By total spent across all receipts"
          table={{
            columns: ['Item', 'Department', 'Times bought', 'Total', 'Saved'],
            numeric: [2, 3, 4],
            rows: g.items.map((i) => [i.name, i.department ?? '', i.timesBought, money(i.totalCents), money(i.totalSavingCents)]),
          }}
        >
          <RankedBars
            rows={g.items.slice(0, 10).map((i) => ({
              key: i.name,
              name: i.name,
              cents: i.totalCents,
              note: `×${i.timesBought}`,
              description: `Bought ${plural(i.timesBought, 'time')}, last on ${longDate(i.lastBought)}`,
            }))}
          />
        </ChartCard>

        <ChartCard
          className="span-5"
          title="By department"
          table={{ columns: ['Department', 'Spent', 'Items'], numeric: [1, 2], rows: g.departments.map((d) => [d.department, money(d.cents), d.count]) }}
        >
          <RankedBars rows={g.departments.map((d) => ({ key: d.department, name: d.department, cents: d.cents, note: plural(d.count, 'item') }))} />
        </ChartCard>

        {weighed.length > 0 ? (
          <section className="card span-12" aria-labelledby="unit-prices">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="unit-prices">Unit prices</h2>
                <p className="card-sub">What you paid per kilogram, so a price change is visible the next time you shop</p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th scope="col">Item</th><th scope="col" className="right">Latest</th><th scope="col" className="right">Lowest</th><th scope="col" className="right">Highest</th><th scope="col" className="right">Times bought</th></tr>
                </thead>
                <tbody>
                  {weighed.map((i) => (
                    <tr key={i.name}>
                      <td className="cell-main">{i.name}</td>
                      <td className="right num">{money(i.lastUnitPriceCents!)}/{i.unit}</td>
                      <td className="right num">{money(i.minUnitPriceCents!)}</td>
                      <td className="right num">{money(i.maxUnitPriceCents!)}</td>
                      <td className="right num">{i.timesBought}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="card span-12" aria-labelledby="all-receipts">
          <div className="card-head"><h2 className="card-title" id="all-receipts">All receipts</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th scope="col">Date</th><th scope="col">Store</th><th scope="col" className="right">Items</th><th scope="col" className="right">Saved</th><th scope="col" className="right">Total</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {receipts.data.map((r) => (
                  <tr key={r.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{longDate(r.purchasedOn)}</td>
                    <td className="cell-main">{r.merchant}{r.storeRef ? <span className="cell-sub"> · store {r.storeRef}</span> : null}</td>
                    <td className="right num">{r.itemCount}</td>
                    <td className="right num">{money(r.savingsCents)}</td>
                    <td className="right num cell-main">{money(r.totalCents)}</td>
                    <td>
                      {r.transactionId
                        ? <span className="chip blue"><Icon name="link" size={12} />On statement</span>
                        : <span className="chip outline">Awaiting statement</span>}
                      {!r.arithmeticOk ? <span className="chip red" style={{ marginLeft: 6 }}><Icon name="alert" size={12} />Check totals</span> : null}
                    </td>
                    <td className="right"><button type="button" className="btn small" onClick={() => setOpen(r.id)}>View items</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      {open !== null ? <ReceiptDrawer receiptId={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
