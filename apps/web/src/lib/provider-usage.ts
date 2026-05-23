/**
 * Pure transforms for the Provider Usage page.
 *
 * Kept out of the React component so the math is unit-testable in isolation.
 */

export interface RawProviderUsage {
  today: Array<{ provider: string; sku: string; count: number; cents: number }>;
  month: Array<{ provider: string; sku: string; count: number; cents: number }>;
  lastCalls: Array<{ provider: string; lastOccurredAt: string }>;
  budgets: { bouncer_usd: number; hunter_credits: number; yelp_usd: number; places_usd: number };
  providersEnabled: Record<string, boolean>;
  sampleMode: boolean;
}

export interface ProviderRow {
  provider: string;
  enabled: boolean;
  todayCalls: number;
  todayCostUsd: number;
  monthCalls: number;
  monthCostUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
  pct: number;
  warn: 'ok' | 'amber' | 'red' | 'cap';
  lastCallAt: string | null;
  notes: string;
}

const PROVIDER_NOTES: Record<string, string> = {
  ses: 'Outbound — $0.10/1k after free tier. Cap is informational only; SES bills linearly.',
  bouncer: 'PAYG. Only spent on score≥80 ambiguous emails after the free chain.',
  hunter: 'Free 50 credits/mo (2026). Only spent on score≥95 leads where scrape failed.',
  yelp: 'No-store. Only fields stored: business_id. Spending appears here only if YELP_MONTHLY_BUDGET_USD > 0.',
  places: 'Disabled at MVP. Never spent unless ENABLE_PLACES=true.',
  twilio: 'Deferred to point-of-sale. Should not appear here at MVP.',
  anthropic: 'Per-lead AI is forbidden at MVP. Should not appear here.',
};

function budgetFor(provider: string, b: RawProviderUsage['budgets']): number | null {
  switch (provider) {
    case 'bouncer': return b.bouncer_usd;
    case 'yelp':    return b.yelp_usd > 0 ? b.yelp_usd : null;
    case 'places':  return b.places_usd > 0 ? b.places_usd : null;
    /* Hunter is credit-based and free at 50/mo. Surface as null cap so the
       UI can render the credit count separately. */
    case 'hunter':  return null;
    default: return null;
  }
}

export function buildRows(raw: RawProviderUsage): ProviderRow[] {
  const provs = new Set<string>([
    ...raw.today.map(r => r.provider),
    ...raw.month.map(r => r.provider),
    ...Object.keys(raw.providersEnabled),
  ]);
  const aggToday = new Map<string, { calls: number; cents: number }>();
  for (const r of raw.today) {
    const cur = aggToday.get(r.provider) ?? { calls: 0, cents: 0 };
    cur.calls += Number(r.count); cur.cents += Number(r.cents);
    aggToday.set(r.provider, cur);
  }
  const aggMonth = new Map<string, { calls: number; cents: number }>();
  for (const r of raw.month) {
    const cur = aggMonth.get(r.provider) ?? { calls: 0, cents: 0 };
    cur.calls += Number(r.count); cur.cents += Number(r.cents);
    aggMonth.set(r.provider, cur);
  }
  const lastCallMap = new Map(raw.lastCalls.map(r => [r.provider, r.lastOccurredAt]));

  const rows: ProviderRow[] = [];
  for (const p of provs) {
    const t = aggToday.get(p) ?? { calls: 0, cents: 0 };
    const m = aggMonth.get(p) ?? { calls: 0, cents: 0 };
    const monthUsd = m.cents / 100;
    const todayUsd = t.cents / 100;
    const cap = budgetFor(p, raw.budgets);
    const remaining = cap !== null ? Math.max(0, cap - monthUsd) : null;
    const pct = cap && cap > 0 ? Math.min(100, (monthUsd / cap) * 100) : 0;
    const warn: ProviderRow['warn'] =
      cap === null ? 'ok'
      : monthUsd >= cap ? 'cap'
      : pct >= 90 ? 'red'
      : pct >= 75 ? 'amber'
      : 'ok';
    rows.push({
      provider: p,
      enabled: !!raw.providersEnabled[p],
      todayCalls: t.calls, todayCostUsd: todayUsd,
      monthCalls: m.calls, monthCostUsd: monthUsd,
      budgetUsd: cap, remainingUsd: remaining, pct, warn,
      lastCallAt: lastCallMap.get(p) ?? null,
      notes: PROVIDER_NOTES[p] ?? '',
    });
  }
  /* Stable, important-first order. */
  const order = ['ses', 'bouncer', 'hunter', 'yelp', 'places'];
  rows.sort((a, b) => {
    const ai = order.indexOf(a.provider), bi = order.indexOf(b.provider);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.provider.localeCompare(b.provider);
  });
  return rows;
}

export function totalMonthCost(rows: ProviderRow[]): number {
  return rows.reduce((acc, r) => acc + r.monthCostUsd, 0);
}
