import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { CalendarHeatmap } from '../charts/CalendarHeatmap.tsx';
import { ColumnChart } from '../charts/ColumnChart.tsx';
import { PaceChart } from '../charts/PaceChart.tsx';
import { RankedBars, shareNote } from '../charts/RankedBars.tsx';
import { ChartCard } from '../components/ChartCard.tsx';
import { Delta, ErrorNote, FirstRun, Skeleton, StatTile } from '../components/common.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { PeriodPicker } from '../components/PeriodPicker.tsx';
import { usePeriod } from '../hooks/usePeriod.ts';
import { api, toQuery } from '../lib/api.ts';
import type { Insight, InsightsResponse, Range } from '../lib/api.ts';
import { dateRange, longDate, money, plural, shortDate, todayIso, WEEKDAYS, WEEKDAYS_LONG } from '../lib/format.ts';

const TONE_ICON: Record<Insight['tone'], IconName> = { up: 'up', down: 'down', alert: 'alert', neutral: 'info' };

function useAnalytics<T>(key: string, range: Range, fetcher: (range: Range) => Promise<T>, enabled = true) {
  return useQuery({
    queryKey: ['analytics', key, range.from, range.to, range.importId ?? null],
    queryFn: () => fetcher(range),
    placeholderData: keepPreviousData, // keep the last render while a new period loads
    enabled,
  });
}

export function Dashboard() {
  const period = usePeriod();
  const { range } = period;
  const ready = period.ready && !period.empty;
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });

  const summary = useAnalytics('summary', range, api.summary, ready);
  const categories = useAnalytics('categories', range, api.categoryBreakdown, ready);
  const daily = useAnalytics('daily', range, (r) => api.timeseries(r, 'day'), ready);
  // The server decides what this period is compared with (the statement
  // before it, or the preceding dates); the pace chart draws that same period.
  const previous = summary.data?.previous ?? null;
  const hasPrior = previous !== null;
  const prior: Range = previous ? { ...previous.range, importId: previous.importId ?? undefined } : range;
  const priorDaily = useAnalytics('daily', prior, (r) => api.timeseries(r, 'day'), ready && hasPrior);
  const merchants = useAnalytics('merchants', range, api.merchants, ready);
  const calendar = useAnalytics('calendar', range, api.calendar, ready);
  const anomalies = useAnalytics('anomalies', range, api.anomalies, ready);
  const insights = useAnalytics('insights', range, api.insights, ready);
  const recurring = useQuery({ queryKey: ['analytics', 'recurring'], queryFn: api.recurring, enabled: ready });

  const [aiInsights, setAiInsights] = useState<{ key: string; data: InsightsResponse } | null>(null);
  const rangeKey = `${range.from}:${range.to}:${range.importId ?? ''}`;
  const askAi = useMutation({
    mutationFn: () => api.aiInsights(range),
    onSuccess: (data) => setAiInsights({ key: rangeKey, data }),
  });
  const shownInsights = aiInsights?.key === rangeKey ? aiInsights.data : insights.data;

  const header = (
    <div className="page-head">
      <div>
        <h1 className="page-title">Spending</h1>
        <p className="page-sub">
          {range.importId ? 'Everything on the statement for ' : ''}
          {dateRange(range.from, range.to)}
        </p>
      </div>
      {ready ? (
        <div className="filters">
          <PeriodPicker range={range} options={period.options} selected={period.selected} onChange={period.setRange} />
        </div>
      ) : null}
    </div>
  );

  if (period.ready && period.empty) return <>{header}<FirstRun /></>;
  const failed = [summary, categories, daily, merchants, calendar].find((q) => q.isError);
  if (failed) return <>{header}<ErrorNote error={failed.error} /></>;
  if (!summary.data) return <>{header}<div className="grid"><div className="card span-12"><Skeleton height={120} /></div><div className="card span-12"><Skeleton height={260} /></div></div></>;

  const s = summary.data;
  const refreshing = summary.isPlaceholderData;
  const txLink = (extra: Record<string, string | number>) =>
    `/transactions${toQuery({ ...(range.importId ? { importId: range.importId } : { from: range.from, to: range.to }), ...extra })}`;
  const dailyRows = daily.data ?? [];
  const weeklyTicks = Math.max(1, Math.ceil(dailyRows.length / 8));
  const monthlyRecurring = (recurring.data ?? []).reduce((sum, r) => sum + r.typicalCents, 0);

  return (
    <>
      {header}
      <div className="grid">
        <section className={`card span-12${refreshing ? ' is-refreshing' : ''}`} aria-label="Summary">
          <div className="grid" style={{ alignItems: 'end' }}>
            <div className="span-5">
              <StatTile
                hero
                label="Total spent"
                value={money(s.totalCents)}
                foot={
                  s.previous ? (
                    <>
                      <Delta ratio={s.changeRatio} />
                      <span>vs {money(s.previous.totalCents)} in {dateRange(s.previous.range.from, s.previous.range.to)}</span>
                    </>
                  ) : (
                    <span>No earlier period on file to compare with</span>
                  )
                }
              />
            </div>
            <div className="span-7">
              <div className="kv">
                <StatTile label="Per day" value={money(s.avgPerDayCents)} foot={`${plural(s.days, 'day')}, ${s.activeDays} with spending`} />
                <StatTile label="Purchases" value={s.purchaseCount.toLocaleString('en-CA')} foot={s.previous ? `${s.previous.purchaseCount} last period` : undefined} />
                <StatTile label="Typical purchase" value={money(s.medianPurchaseCents)} foot="Median" />
                <StatTile
                  label="Largest purchase"
                  value={s.largest ? money(s.largest.amountCents) : '—'}
                  foot={s.largest ? `${s.largest.merchant}, ${shortDate(s.largest.txnDate)}` : undefined}
                />
              </div>
            </div>
          </div>
        </section>

        <ChartCard
          className="span-12"
          title="What stands out"
          subtitle={
            shownInsights?.source === 'ai'
              ? `Written by ${shownInsights.model} from aggregate figures only`
              : 'Computed on this computer from your transactions'
          }
          actions={
            health.data?.ai.enabled ? (
              <button type="button" className="btn small" onClick={() => askAi.mutate()} disabled={askAi.isPending} title="Sends category and merchant totals (no individual transactions) to the Claude API">
                <Icon name="spark" size={15} />
                {askAi.isPending ? 'Asking Claude…' : 'Ask Claude'}
              </button>
            ) : null
          }
        >
          {askAi.isError ? <div style={{ marginBottom: 10 }}><ErrorNote error={askAi.error} /></div> : null}
          {shownInsights && shownInsights.insights.length > 0 ? (
            <div className="insights">
              {shownInsights.insights.map((insight) => (
                <article key={insight.id} className={`insight ${insight.tone}`}>
                  <span className="insight-icon"><Icon name={TONE_ICON[insight.tone]} size={18} /></span>
                  <h3 className="insight-title">{insight.title}</h3>
                  <p className="insight-detail">{insight.detail}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">Nothing unusual in this period.</p>
          )}
        </ChartCard>

        <ChartCard
          className="span-7"
          title="Spending pace"
          subtitle={hasPrior ? 'Running total by day, against the previous period' : 'Running total by day'}
          refreshing={daily.isPlaceholderData}
          table={{
            columns: ['Date', 'Spent that day', 'Running total', ...(hasPrior ? ['Previous period running total'] : [])],
            numeric: [1, 2, 3],
            rows: dailyRows.map((p, i) => [longDate(p.date), money(p.cents), money(p.cumulativeCents), ...(hasPrior ? [priorDaily.data?.[i] ? money(priorDaily.data[i].cumulativeCents) : ''] : [])]),
          }}
        >
          {daily.data ? <PaceChart current={daily.data} previous={hasPrior ? (priorDaily.data ?? null) : null} today={todayIso()} /> : <Skeleton height={250} />}
        </ChartCard>

        <ChartCard
          className="span-5"
          title="Where it went"
          subtitle="By category. Select one to see its transactions."
          refreshing={categories.isPlaceholderData}
          table={{
            columns: ['Category', 'Spent', 'Share', 'Purchases', 'Previous period'],
            numeric: [1, 2, 3, 4],
            rows: (categories.data ?? []).map((c) => [c.name, money(c.cents), shareNote(c.share), c.count, money(c.previousCents)]),
          }}
        >
          {categories.data ? (
            <RankedBars
              showPrevious={hasPrior}
              rows={categories.data.filter((c) => c.cents > 0).map((c) => ({
                key: String(c.categoryId),
                name: c.name,
                cents: c.cents,
                note: shareNote(c.share),
                previousCents: c.previousCents,
                to: txLink({ categoryId: c.categoryId }),
                description: plural(c.count, 'purchase'),
              }))}
            />
          ) : <Skeleton height={250} />}
        </ChartCard>

        <ChartCard
          className="span-7"
          title="Day by day"
          subtitle="What each day cost"
          refreshing={daily.isPlaceholderData}
          table={{ columns: ['Date', 'Spent', 'Purchases'], numeric: [1, 2], rows: dailyRows.map((p) => [longDate(p.date), money(p.cents), p.count]) }}
        >
          {daily.data ? (
            <ColumnChart
              ariaLabel={`Spending for each day from ${longDate(range.from)} to ${longDate(range.to)}.`}
              tickEvery={weeklyTicks}
              columns={daily.data.map((p) => ({
                key: p.date,
                label: shortDate(p.date),
                cents: p.cents,
                tooltipTitle: longDate(p.date),
                tooltipRows: [{ label: 'Spent', value: money(p.cents) }, { label: 'Purchases', value: String(p.count) }],
              }))}
            />
          ) : <Skeleton height={220} />}
        </ChartCard>

        <ChartCard
          className="span-5"
          title="Top merchants"
          subtitle="Every store of a chain counted together"
          refreshing={merchants.isPlaceholderData}
          table={{
            columns: ['Merchant', 'Category', 'Spent', 'Purchases', 'Average'],
            numeric: [2, 3, 4],
            rows: (merchants.data ?? []).map((m) => [m.merchant, m.categoryName, money(m.cents), m.count, money(m.avgCents)]),
          }}
        >
          {merchants.data ? (
            <RankedBars
              rows={merchants.data.slice(0, 8).map((m) => ({
                key: m.merchant,
                name: m.merchant,
                cents: m.cents,
                note: `×${m.count}`,
                to: txLink({ q: m.merchant }),
                description: `${plural(m.count, 'purchase')}, ${money(m.avgCents)} on average`,
              }))}
            />
          ) : <Skeleton height={220} />}
        </ChartCard>

        <ChartCard
          className="span-7"
          title="Calendar"
          subtitle="Darker days cost more"
          refreshing={calendar.isPlaceholderData}
          table={{
            columns: ['Weekday', 'Total', 'Purchases', 'Average per day'],
            numeric: [1, 2, 3],
            rows: (calendar.data?.weekdays ?? []).map((w) => [WEEKDAYS_LONG[w.weekday]!, money(w.cents), w.count, money(w.avgPerDayCents)]),
          }}
        >
          {calendar.data ? <CalendarHeatmap days={calendar.data.days} /> : <Skeleton height={220} />}
        </ChartCard>

        <ChartCard
          className="span-5"
          title="By weekday"
          subtitle="Average spent per day of the week"
          refreshing={calendar.isPlaceholderData}
          table={{
            columns: ['Weekday', 'Average per day', 'Total'],
            numeric: [1, 2],
            rows: (calendar.data?.weekdays ?? []).map((w) => [WEEKDAYS_LONG[w.weekday]!, money(w.avgPerDayCents), money(w.cents)]),
          }}
        >
          {calendar.data ? (
            <ColumnChart
              height={200}
              ariaLabel="Average spending for each day of the week."
              columns={calendar.data.weekdays.map((w) => ({
                key: String(w.weekday),
                label: WEEKDAYS[w.weekday]!,
                cents: w.avgPerDayCents,
                tooltipTitle: WEEKDAYS_LONG[w.weekday]!,
                tooltipRows: [{ label: 'Average', value: money(w.avgPerDayCents) }, { label: 'Total', value: money(w.cents) }, { label: 'Purchases', value: String(w.count) }],
              }))}
            />
          ) : <Skeleton height={200} />}
        </ChartCard>

        <section className="card span-6" aria-labelledby="recurring-title">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="recurring-title">Recurring charges</h2>
              <p className="card-sub">
                {recurring.data?.length
                  ? `${money(monthlyRecurring)} a month, ${money(monthlyRecurring * 12)} a year`
                  : 'Subscriptions and bills, detected from a steady monthly charge'}
              </p>
            </div>
            <Icon name="repeat" />
          </div>
          {recurring.data?.length ? (
            <div className="list">
              {recurring.data.map((r) => (
                <div className="list-row" key={r.merchant}>
                  <div>
                    <div className="cell-main">{r.merchant}</div>
                    <div className="cell-sub">{r.categoryName} · seen {r.occurrences} times · next around {shortDate(r.nextExpected)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num cell-main">{money(r.typicalCents)}</div>
                    <div className="cell-sub">{money(r.annualCents)} / yr</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">None found yet. A charge needs to appear in at least two statements, about a month apart, to count.</p>
          )}
        </section>

        <section className="card span-6" aria-labelledby="anomalies-title">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="anomalies-title">Worth a second look</h2>
              <p className="card-sub">Purchases that differ from your own history</p>
            </div>
            <Icon name="alert" />
          </div>
          {anomalies.data?.length ? (
            <div className="list">
              {anomalies.data.map((a) => (
                <div className="list-row" key={a.transactionId}>
                  <div>
                    <div className="cell-main">
                      <Link to={txLink({ q: a.merchant })}>{a.merchant}</Link>
                      <span className="chip red" style={{ marginLeft: 8 }}>
                        {a.reason === 'new-merchant' ? 'New merchant' : a.reason === 'merchant-outlier' ? 'Unusual for this merchant' : 'Unusual for this category'}
                      </span>
                    </div>
                    <div className="cell-sub">{longDate(a.txnDate)} · {a.detail}</div>
                  </div>
                  <div className="num cell-main">{money(a.amountCents)}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Nothing unusual in this period.</p>
          )}
        </section>
      </div>
    </>
  );
}
