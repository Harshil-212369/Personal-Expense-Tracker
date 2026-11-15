import type { AiGateway } from '../ai/gateway.ts';
import type { Insight, InsightsResponse, Scope } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { formatCents } from '../lib/money.ts';
import * as analytics from './analytics.ts';

const WEEKDAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const MAX_INSIGHTS = 6;
const percent = (ratio: number) => `${Math.round(Math.abs(ratio) * 100)}%`;

/**
 * Deterministic insights: plain statements derived from the analytics, with
 * thresholds so a trivial change is not reported as news. This is what the
 * dashboard shows when no AI key is configured, and what the AI narration is
 * grounded in when one is.
 */
export function ruleBasedInsights(db: Db, range: Scope): Insight[] {
  const insights: Insight[] = [];
  const summary = analytics.summary(db, range);
  if (summary.purchaseCount === 0) return insights;

  const categories = analytics.byCategory(db, range).filter((c) => c.cents > 0);
  const habits = analytics.habits(db, range);
  const recurring = analytics.recurring(db);
  const anomalies = analytics.anomalies(db, range, 1);
  const groceries = analytics.groceries(db, range);

  if (summary.previous && summary.changeRatio !== null && Math.abs(summary.changeRatio) >= 0.05) {
    const up = summary.changeRatio > 0;
    insights.push({
      id: 'period-change',
      tone: up ? 'up' : 'down',
      title: `Spending is ${up ? 'up' : 'down'} ${percent(summary.changeRatio)}`,
      detail: `${formatCents(summary.totalCents)} this period against ${formatCents(summary.previous.totalCents)} in the one before, a difference of ${formatCents(Math.abs(summary.totalCents - summary.previous.totalCents))}.`,
    });
  }

  const top = categories[0];
  if (top && top.share >= 0.25) {
    insights.push({
      id: 'top-category',
      tone: 'neutral',
      title: `${top.name} is ${percent(top.share)} of spending`,
      detail: `${formatCents(top.cents)} across ${top.count} purchase${top.count === 1 ? '' : 's'}, about ${formatCents(Math.round(top.cents / Math.max(1, top.count)))} each.`,
    });
  }

  if (summary.previous) {
    const mover = categories
      .map((c) => ({ ...c, delta: c.cents - c.previousCents }))
      .filter((c) => c.previousCents > 0 && Math.abs(c.delta) >= 1500 && Math.abs(c.delta) / c.previousCents >= 0.2)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    if (mover) {
      const up = mover.delta > 0;
      insights.push({
        id: 'category-mover',
        tone: up ? 'up' : 'down',
        title: `${mover.name} ${up ? 'rose' : 'fell'} by ${formatCents(Math.abs(mover.delta))}`,
        detail: `From ${formatCents(mover.previousCents)} to ${formatCents(mover.cents)}, the largest change of any category.`,
      });
    }
  }

  if (recurring.length > 0) {
    const monthly = recurring.reduce((sum, r) => sum + r.typicalCents, 0);
    const names = recurring.slice(0, 3).map((r) => r.merchant).join(', ');
    insights.push({
      id: 'recurring',
      tone: 'neutral',
      title: `${recurring.length} recurring charge${recurring.length === 1 ? '' : 's'} cost ${formatCents(monthly)} a month`,
      detail: `${names}${recurring.length > 3 ? ' and others' : ''}. That is ${formatCents(monthly * 12)} a year if nothing changes.`,
    });
  }

  if (anomalies[0]) {
    insights.push({ id: 'anomaly', tone: 'alert', title: 'One purchase stands out', detail: anomalies[0].detail });
  }

  if (habits.smallPurchaseCount >= 5) {
    insights.push({
      id: 'small-purchases',
      tone: 'neutral',
      title: `${habits.smallPurchaseCount} purchases were under ${formatCents(habits.smallPurchaseLimitCents)}`,
      detail: `They are ${percent(habits.smallPurchaseShareOfCount)} of your transactions and ${formatCents(habits.smallPurchaseCents)} in total (${percent(habits.smallPurchaseShareOfSpend)} of spending).`,
    });
  }

  if (habits.mostVisited && habits.mostVisited.count >= 4) {
    const m = habits.mostVisited;
    insights.push({
      id: 'most-visited',
      tone: 'neutral',
      title: `${m.merchant} was charged ${m.count} times`,
      detail: `${formatCents(m.cents)} in total, or ${formatCents(Math.round(m.cents / m.count))} per charge.`,
    });
  }

  if (habits.busiestWeekday && summary.days >= 14) {
    insights.push({
      id: 'busiest-weekday',
      tone: 'neutral',
      title: `${WEEKDAYS[habits.busiestWeekday.weekday]} cost the most`,
      detail: `An average of ${formatCents(habits.busiestWeekday.avgPerDayCents)} per ${WEEKDAYS[habits.busiestWeekday.weekday]!.slice(0, -1)}, against ${formatCents(summary.avgPerDayCents)} on a typical day.`,
    });
  }

  if (groceries.receiptCount > 0 && groceries.savingsCents > 0) {
    insights.push({
      id: 'receipt-savings',
      tone: 'down',
      title: `Receipts show ${formatCents(groceries.savingsCents)} saved`,
      detail: `Across ${groceries.receiptCount} itemized receipt${groceries.receiptCount === 1 ? '' : 's'} totalling ${formatCents(groceries.spendCents)}, from promotions and loyalty discounts.`,
    });
  }

  // Ordered by how much a person would want to know it; the page shows the top six.
  return insights.slice(0, MAX_INSIGHTS);
}

/**
 * The only spending data ever sent to the model for insights: aggregates.
 * No transaction rows, dates of individual purchases, locations or notes.
 */
export function buildRollup(db: Db, range: Scope) {
  const summary = analytics.summary(db, range);
  return {
    currency: 'CAD',
    amountsIn: 'cents',
    period: { from: range.from, to: range.to },
    totalCents: summary.totalCents,
    purchaseCount: summary.purchaseCount,
    avgPerDayCents: summary.avgPerDayCents,
    medianPurchaseCents: summary.medianPurchaseCents,
    previousPeriod: summary.previous ? { ...summary.previous.range, totalCents: summary.previous.totalCents } : null,
    categories: analytics.byCategory(db, range).map(({ name, cents, count, previousCents }) => ({ name, cents, count, previousCents })),
    topMerchants: analytics.topMerchants(db, range, 8).map(({ merchant, cents, count }) => ({ merchant, cents, count })),
    recurring: analytics.recurring(db).map(({ merchant, typicalCents, intervalDays }) => ({ merchant, typicalCents, intervalDays })),
    weekdays: analytics.calendar(db, range).weekdays.map(({ weekday, avgPerDayCents }) => ({ weekday: WEEKDAYS[weekday], avgPerDayCents })),
    smallPurchases: (({ smallPurchaseCount, smallPurchaseCents, smallPurchaseLimitCents }) => ({
      count: smallPurchaseCount, cents: smallPurchaseCents, underCents: smallPurchaseLimitCents,
    }))(analytics.habits(db, range)),
  };
}

export async function insights(db: Db, ai: AiGateway | null, range: Scope, useAi: boolean): Promise<InsightsResponse> {
  if (useAi && ai) {
    const written = await ai.writeInsights(buildRollup(db, range));
    return {
      source: 'ai',
      model: ai.model,
      insights: written.map((insight, index) => ({
        id: `ai-${index}`,
        tone: insight.tone,
        title: insight.title.slice(0, 120),
        detail: insight.detail.slice(0, 500),
      })),
    };
  }
  return { source: 'rules', model: null, insights: ruleBasedInsights(db, range) };
}
