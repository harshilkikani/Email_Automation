import { describe, it, expect } from 'vitest';
import { buildRows, totalMonthCost, type RawProviderUsage } from '../src/lib/provider-usage';

function raw(over: Partial<RawProviderUsage> = {}): RawProviderUsage {
  return {
    today: [], month: [], lastCalls: [],
    budgets: { bouncer_usd: 5, hunter_credits: 50, yelp_usd: 0, places_usd: 0 },
    providersEnabled: { ses: true, bouncer: false, hunter: false, yelp: false, places: false },
    sampleMode: false,
    ...over,
  };
}

describe('provider-usage transform', () => {
  it('produces a row per known provider in stable order', () => {
    const rows = buildRows(raw());
    expect(rows.map(r => r.provider)).toEqual(['ses', 'bouncer', 'hunter', 'yelp', 'places']);
  });

  it('aggregates today + month per provider', () => {
    const rows = buildRows(raw({
      today: [
        { provider: 'bouncer', sku: 'verify', count: 2, cents: 4 },
        { provider: 'bouncer', sku: 'verify', count: 1, cents: 2 },
      ],
      month: [
        { provider: 'bouncer', sku: 'verify', count: 50, cents: 200 },
      ],
      lastCalls: [{ provider: 'bouncer', lastOccurredAt: '2026-05-18T01:00:00Z' }],
    }));
    const b = rows.find(r => r.provider === 'bouncer')!;
    expect(b.todayCalls).toBe(3);
    expect(b.todayCostUsd).toBeCloseTo(0.06);
    expect(b.monthCalls).toBe(50);
    expect(b.monthCostUsd).toBeCloseTo(2.00);
    expect(b.budgetUsd).toBe(5);
    expect(b.remainingUsd).toBeCloseTo(3.00);
    expect(b.pct).toBeCloseTo(40);
    expect(b.warn).toBe('ok');
  });

  it('warns amber at 75% and red at 90% and caps at 100%', () => {
    const a = buildRows(raw({ month: [{ provider: 'bouncer', sku: 'x', count: 1, cents: 400 }] }));
    const r = buildRows(raw({ month: [{ provider: 'bouncer', sku: 'x', count: 1, cents: 460 }] }));
    const c = buildRows(raw({ month: [{ provider: 'bouncer', sku: 'x', count: 1, cents: 510 }] }));
    expect(a.find(x => x.provider === 'bouncer')!.warn).toBe('amber');
    expect(r.find(x => x.provider === 'bouncer')!.warn).toBe('red');
    expect(c.find(x => x.provider === 'bouncer')!.warn).toBe('cap');
  });

  it('totalMonthCost sums all providers', () => {
    const rows = buildRows(raw({
      month: [
        { provider: 'bouncer', sku: 'x', count: 1, cents: 100 },
        { provider: 'ses', sku: 'send', count: 1, cents: 50 },
      ],
    }));
    expect(totalMonthCost(rows)).toBeCloseTo(1.50);
  });

  it('marks ses as enabled and not budgeted (linear pricing)', () => {
    const rows = buildRows(raw({ providersEnabled: { ses: true } as any }));
    const ses = rows.find(r => r.provider === 'ses')!;
    expect(ses.enabled).toBe(true);
    expect(ses.budgetUsd).toBeNull();
    expect(ses.warn).toBe('ok');
  });
});
