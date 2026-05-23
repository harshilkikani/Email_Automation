/**
 * Market saturation math — pure-function tests.
 *
 * The branch's `apps/server/src/services/saturation.ts` reads/writes the
 * per-zip aggregates, but the actual policy lives here. Bugs in this math
 * mean either over-sending (decay too aggressive) or under-sending (decay
 * too lenient), both expensive.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSaturationPct,
  softDeboost,
  shouldBlock,
  DEFAULT_SATURATION_CONFIG,
  type SaturationEvent,
  type SaturationConfig,
} from '../src/saturation.js';

const ANCHOR = new Date('2026-05-23T00:00:00.000Z');
const cfg: SaturationConfig = DEFAULT_SATURATION_CONFIG;

function ev(leadId: string, daysAgo: number): SaturationEvent {
  return { leadId, sentAt: new Date(ANCHOR.getTime() - daysAgo * 86_400_000) };
}

describe('computeSaturationPct', () => {
  it('returns 0 when there are no eligible leads', () => {
    expect(computeSaturationPct([ev('a', 1)], 0, ANCHOR, 14)).toBe(0);
    expect(computeSaturationPct([], 0, ANCHOR, 14)).toBe(0);
  });

  it('returns 0 when there are no events', () => {
    expect(computeSaturationPct([], 100, ANCHOR, 14)).toBe(0);
  });

  it('fresh send to 1 of 1 eligible lead = 100%', () => {
    expect(computeSaturationPct([ev('a', 0)], 1, ANCHOR, 14)).toBe(100);
  });

  it('fresh send to 1 of 10 eligible leads = 10%', () => {
    expect(computeSaturationPct([ev('a', 0)], 10, ANCHOR, 14)).toBeCloseTo(10, 5);
  });

  it('decay: a send τ days ago counts as 1/e of a fresh send', () => {
    const tau = 14;
    const pct = computeSaturationPct([ev('a', tau)], 100, ANCHOR, tau);
    /* e^-1 ≈ 0.3678794. 1 send / 100 eligible × decay × 100 = 0.3678794. */
    expect(pct).toBeCloseTo(Math.exp(-1) * 1, 4);
  });

  it('duplicate sends to same lead use the freshest decay only (no compounding)', () => {
    /* Two sends 0 days and 14 days ago to the same lead. We take the max
       (the fresher decay = 1.0), not the sum (which would be 1 + 1/e). */
    const pct = computeSaturationPct([ev('a', 0), ev('a', 14)], 10, ANCHOR, 14);
    expect(pct).toBeCloseTo(10, 5);   // 1 distinct lead / 10 eligible
  });

  it('distinct leads sum independently', () => {
    /* 3 distinct leads, all fresh. 3 / 100 = 3%. */
    const pct = computeSaturationPct(
      [ev('a', 0), ev('b', 0), ev('c', 0)],
      100,
      ANCHOR,
      14,
    );
    expect(pct).toBeCloseTo(3, 5);
  });

  it('caps at 100% even when decayed sends exceed eligible count', () => {
    /* 200 distinct fresh sends but only 50 "eligible" — math says 400%, cap to 100. */
    const events: SaturationEvent[] = [];
    for (let i = 0; i < 200; i++) events.push(ev(`lead-${i}`, 0));
    expect(computeSaturationPct(events, 50, ANCHOR, 14)).toBe(100);
  });

  it('clamps negative dt to 0 (clock-skew safety)', () => {
    /* sentAt is 1 day in the FUTURE relative to "now" — treat as fresh, not negative-decay. */
    const futureEv: SaturationEvent = { leadId: 'a', sentAt: new Date(ANCHOR.getTime() + 86_400_000) };
    expect(computeSaturationPct([futureEv], 1, ANCHOR, 14)).toBe(100);
  });

  it('larger τ → slower decay (more saturation for the same age)', () => {
    const old = ev('a', 30);
    const slow = computeSaturationPct([old], 1, ANCHOR, 28);
    const fast = computeSaturationPct([old], 1, ANCHOR, 7);
    expect(slow).toBeGreaterThan(fast);
  });
});

describe('softDeboost', () => {
  it('0 below softCap', () => {
    expect(softDeboost(0, cfg)).toBe(0);
    expect(softDeboost(cfg.softCapPct - 0.0001, cfg)).toBe(0);
    expect(softDeboost(cfg.softCapPct, cfg)).toBe(0);
  });

  it('0.5 at and above hardCap', () => {
    expect(softDeboost(cfg.hardCapPct, cfg)).toBe(0.5);
    expect(softDeboost(99, cfg)).toBe(0.5);
  });

  it('linear interpolation between caps', () => {
    /* At the midpoint of (30, 60) = 45 → halfway → 0.25 */
    const mid = (cfg.softCapPct + cfg.hardCapPct) / 2;
    expect(softDeboost(mid, cfg)).toBeCloseTo(0.25, 5);
  });

  it('degenerate cfg where softCap == hardCap: <= soft branch wins, never deboosts at boundary', () => {
    const bad: SaturationConfig = { ...cfg, softCapPct: 60, hardCapPct: 60 };
    /* Implementation contract: the `<=` softCap branch runs first, so at
       the exact boundary we return 0 (no deboost). Above the boundary the
       hardCap branch returns 0.5. */
    expect(softDeboost(59.999, bad)).toBe(0);
    expect(softDeboost(60, bad)).toBe(0);
    expect(softDeboost(60.0001, bad)).toBe(0.5);
  });
});

describe('shouldBlock', () => {
  it('blocks at and above hardCap', () => {
    expect(shouldBlock(cfg.hardCapPct, cfg)).toBe(true);
    expect(shouldBlock(cfg.hardCapPct + 0.01, cfg)).toBe(true);
    expect(shouldBlock(99, cfg)).toBe(true);
  });

  it('does not block below hardCap', () => {
    expect(shouldBlock(cfg.hardCapPct - 0.0001, cfg)).toBe(false);
    expect(shouldBlock(cfg.softCapPct, cfg)).toBe(false);
    expect(shouldBlock(0, cfg)).toBe(false);
  });
});
