import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { ErrorNote, useToast } from '../components/common.tsx';
import { Icon } from '../components/Icon.tsx';
import { api } from '../lib/api.ts';
import type { CheckResult, ImportRecord, ImportResult } from '../lib/api.ts';
import { dateRange, longDate, money, plural } from '../lib/format.ts';

const KIND_LABEL: Record<string, string> = {
  'cibc-credit-pdf': 'CIBC credit card statement (PDF)',
  'cibc-csv': 'CIBC transaction export (CSV)',
  'generic-csv': 'CSV file',
  'metro-receipt-email': 'Metro receipt email',
  'ai-statement': 'Statement read by Claude',
};

const showCheckValue = (check: CheckResult, value: number) => (check.unit === 'cents' ? money(value) : value.toLocaleString('en-CA'));

function Checks({ checks }: { checks: CheckResult[] }) {
  return (
    <div className="checks" role="list" aria-label="Reconciliation checks">
      {checks.map((check) => (
        <div key={check.label} role="listitem" className={`check${check.ok ? '' : ' fail'}`}>
          <span className="check-icon"><Icon name={check.ok ? 'check' : 'x'} size={16} label={check.ok ? 'Matches' : 'Does not match'} /></span>
          <span>{check.label}</span>
          <span className="num">
            {check.ok ? showCheckValue(check, check.expected) : `printed ${showCheckValue(check, check.expected)}, read ${showCheckValue(check, check.actual)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

function Verdict({ result }: { result: Pick<ImportResult, 'reconciled' | 'checks' | 'docType'> }) {
  if (result.reconciled === true) {
    return (
      <div className="banner ok">
        <Icon name="check" />
        <span>
          <strong>Verified.</strong> All {result.checks.length} figures printed on the {result.docType} match what was read from it, to the cent.
        </span>
      </div>
    );
  }
  if (result.reconciled === false) {
    return (
      <div className="banner warn" role="alert">
        <Icon name="alert" />
        <span><strong>Totals do not match.</strong> Something was misread. You can still import, but check the rows below against the document first.</span>
      </div>
    );
  }
  return (
    <div className="banner">
      <Icon name="info" />
      <span>This file prints no totals, so the rows could not be checked against it. Review them before importing.</span>
    </div>
  );
}

export function ImportPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [useAi, setUseAi] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);

  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const history = useQuery({ queryKey: ['imports'], queryFn: api.imports });
  const parser = useAi ? 'ai' : 'auto';

  const dryRun = useMutation({
    mutationFn: (chosen: File) => api.importFile(chosen, { dryRun: true, parser }),
    onSuccess: (result) => {
      setPreview(result);
      setDone(null);
    },
  });
  const commit = useMutation({
    mutationFn: (chosen: File) => api.importFile(chosen, { dryRun: false, parser }),
    onSuccess: (result) => {
      setDone(result);
      setPreview(null);
      setFile(null);
      void queryClient.invalidateQueries();
    },
  });
  const rollback = useMutation({
    mutationFn: (record: ImportRecord) => api.deleteImport(record.id),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast({ message: 'Import removed, along with everything it added.' });
    },
  });

  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    setFile(chosen);
    setPreview(null);
    setDone(null);
    commit.reset();
    dryRun.mutate(chosen);
  };

  const busy = dryRun.isPending || commit.isPending;
  const aiAvailable = health.data?.ai.enabled ?? false;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Import</h1>
          <p className="page-sub">
            Statements and receipts are read on this computer. Every import is previewed first, checked against the totals
            printed on the document, and can be undone.
          </p>
        </div>
      </div>

      <div className="stack">
        <div
          className={`dropzone${dragging ? ' over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files[0]); }}
        >
          <Icon name="upload" size={26} />
          <strong>{busy ? 'Reading…' : 'Drop a file here, or choose one'}</strong>
          <span className="muted">CIBC credit card statement (PDF) · bank CSV export · Metro receipt email (.eml)</span>
          <input ref={input} type="file" accept=".pdf,.csv,.eml,application/pdf,text/csv,message/rfc822" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} data-testid="file-input" />
        </div>

        {aiAvailable ? (
          <label className="row" style={{ gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={useAi} onChange={(e) => { setUseAi(e.target.checked); setPreview(null); }} />
            <span>
              Read with Claude ({health.data?.ai.model}) instead of the built-in parser.{' '}
              <span className="muted">Sends only transaction lines, with card numbers, emails, phone numbers and postal codes masked.</span>
            </span>
          </label>
        ) : (
          <p className="muted" style={{ fontSize: 13.5 }}>
            Unknown statement layouts can be read by Claude when <code className="inline">ANTHROPIC_API_KEY</code> is set. Without it, nothing is ever sent off this computer.
          </p>
        )}

        {dryRun.isError ? <ErrorNote error={dryRun.error} /> : null}
        {commit.isError ? <ErrorNote error={commit.error} /> : null}

        {preview && file ? (
          <section className="card stack" aria-label="Import preview">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h2 className="card-title">{KIND_LABEL[preview.kind] ?? preview.kind}</h2>
                <p className="card-sub">
                  {preview.filename}
                  {preview.periodStart && preview.periodEnd ? ` · ${preview.periodStart === preview.periodEnd ? longDate(preview.periodStart) : dateRange(preview.periodStart, preview.periodEnd)}` : ''}
                  {preview.parser === 'ai' ? ' · read by Claude' : ''}
                </p>
              </div>
              <div className="row">
                <button type="button" className="btn" onClick={() => { setPreview(null); setFile(null); }}>Cancel</button>
                <button type="button" className="btn primary" disabled={busy || preview.status === 'duplicate' || preview.rowsInserted === 0} onClick={() => commit.mutate(file)}>
                  {commit.isPending ? 'Importing…' : `Import ${plural(preview.rowsInserted, preview.docType === 'receipt' ? 'item' : 'transaction')}`}
                </button>
              </div>
            </div>

            {preview.status === 'duplicate' ? (
              <div className="banner"><Icon name="info" /><span>This exact file was imported before. Nothing to do.</span></div>
            ) : (
              <>
                <Verdict result={preview} />
                {preview.checks.length > 0 ? <Checks checks={preview.checks} /> : null}
                {preview.rowsDuplicate > 0 ? (
                  <div className="banner"><Icon name="info" /><span>{plural(preview.rowsDuplicate, 'row')} already on file from an earlier import will be skipped.</span></div>
                ) : null}
                <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr><th scope="col">Date</th><th scope="col">{preview.docType === 'receipt' ? 'Item' : 'Merchant'}</th><th scope="col">{preview.docType === 'receipt' ? 'Department' : 'Category'}</th><th scope="col" className="right">Amount</th></tr>
                    </thead>
                    <tbody>
                      {preview.preview.map((row, i) => (
                        <tr key={i} style={row.duplicate ? { opacity: 0.5 } : undefined}>
                          <td className="num" style={{ whiteSpace: 'nowrap' }}>{longDate(row.txnDate)}</td>
                          <td>
                            <div className="cell-main">{preview.docType === 'receipt' ? row.description : row.merchant}{row.duplicate ? <span className="chip outline" style={{ marginLeft: 8 }}>Already imported</span> : null}</div>
                            {preview.docType === 'statement' && row.description !== row.merchant ? <div className="cell-sub">{row.description}</div> : null}
                          </td>
                          <td>{row.categoryName}</td>
                          <td className={`right num${row.amountCents < 0 ? ' amount-credit' : ''}`}>{row.amountCents < 0 ? `+${money(-row.amountCents)}` : money(row.amountCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        ) : null}

        {done ? (
          <div className="banner ok" role="status">
            <Icon name="check" />
            <span>
              <strong>Imported {plural(done.rowsInserted, done.docType === 'receipt' ? 'item' : 'transaction')}.</strong>{' '}
              {done.receiptsLinked > 0 ? `${plural(done.receiptsLinked, 'receipt')} matched to a statement line. ` : ''}
              <Link to={done.docType === 'receipt' ? '/receipts' : '/'}>{done.docType === 'receipt' ? 'See your receipts' : 'See the dashboard'}</Link>
            </span>
          </div>
        ) : null}

        <section className="card" aria-labelledby="history-title">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="history-title">Import history</h2>
              <p className="card-sub">Removing an import removes exactly the rows it added.</p>
            </div>
          </div>
          {history.isError ? <ErrorNote error={history.error} /> : null}
          {history.data?.length === 0 ? <p className="muted">Nothing imported yet.</p> : null}
          {history.data && history.data.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th scope="col">File</th><th scope="col">Covers</th><th scope="col" className="right">Rows</th><th scope="col">Checked</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {history.data.map((record) => (
                    <tr key={record.id}>
                      <td>
                        <div className="cell-main">{KIND_LABEL[record.kind] ?? record.kind}</div>
                        <div className="cell-sub">{record.filename} · imported {longDate(record.importedAt.slice(0, 10))}</div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{record.periodStart && record.periodEnd ? (record.periodStart === record.periodEnd ? longDate(record.periodStart) : dateRange(record.periodStart, record.periodEnd)) : '—'}</td>
                      <td className="right num">{record.rowsInserted}{record.rowsDuplicate ? <span className="cell-sub"> (+{record.rowsDuplicate} skipped)</span> : null}</td>
                      <td>
                        {record.reconciled === true ? <span className="chip blue"><Icon name="check" size={12} />Verified</span> : null}
                        {record.reconciled === false ? <span className="chip red"><Icon name="alert" size={12} />Mismatch</span> : null}
                        {record.reconciled === null ? <span className="chip outline">No totals</span> : null}
                      </td>
                      <td className="right">
                        <button
                          type="button"
                          className="btn small danger"
                          disabled={rollback.isPending}
                          onClick={() => {
                            if (window.confirm(`Remove this import and the ${record.rowsInserted} rows it added? This cannot be undone.`)) rollback.mutate(record);
                          }}
                        >
                          Undo import
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}
