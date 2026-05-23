/**
 * Tests for the pure `deferralTarget` helper in send-time-histogram.
 *
 * The DB-touching `getPreferredHour` / `getPreferredHoursBulk` paths are
 * exercised end-to-end in the integration test against real Postgres
 * (search `integration.test.ts` for "send-time histogram"). Here we only
 * verify the deterministic time arithmetic, which is the part most likely
 * to ship subtle off-by-one bugs.
 */
import { describe, it, expect } from 'vitest';
import { deferralTarget } from '../src/services/send-time-histogram.js';

const window = { startHour: 14, endHour: 22 };  // 14:00–22:00 UTC

describe('deferralTarget', () => {
  it('returns null when there is no preferred hour (cold start)', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    expect(deferralTarget(now, null, window)).toBeNull();
  });

  it('returns null when current hour is at or past the preferred hour', () => {
    const at = new Date('2026-05-23T16:00:00Z');
    expect(deferralTarget(at, 16, window)).toBeNull();
    const past = new Date('2026-05-23T18:30:00Z');
    expect(deferralTarget(past, 16, window)).toBeNull();
  });

  it('defers to today at the preferred hour when earlier in the day', () => {
    const now = new Date('2026-05-23T14:30:00Z');
    const target = deferralTarget(now, 18, window);
    expect(target).not.toBeNull();
    expect(target!.toISOString()).toBe('2026-05-23T18:00:00.000Z');
  });

  it('zero-minute, zero-second precision on the deferred Date', () => {
    const now = new Date('2026-05-23T14:37:42.123Z');
    const target = deferralTarget(now, 17, window);
    expect(target!.getUTCMinutes()).toBe(0);
    expect(target!.getUTCSeconds()).toBe(0);
    expect(target!.getUTCMilliseconds()).toBe(0);
  });

  it('ignores a preferred hour outside the send window', () => {
    /* preferred=8 is before the 14:00 start → no deferral, fall through */
    const now = new Date('2026-05-23T06:00:00Z');
    expect(deferralTarget(now, 8, window)).toBeNull();
    /* preferred=22 is past the 22:00 (exclusive) end → no deferral */
    expect(deferralTarget(now, 22, window)).toBeNull();
    /* preferred=23 → no deferral */
    expect(deferralTarget(now, 23, window)).toBeNull();
  });

  it('respects boundary: startHour inclusive, endHour exclusive', () => {
    const earlyMorning = new Date('2026-05-23T10:00:00Z');
    /* preferred = startHour (14) → deferral target = today 14:00. */
    const at14 = deferralTarget(earlyMorning, 14, window);
    expect(at14?.toISOString()).toBe('2026-05-23T14:00:00.000Z');
    /* preferred = endHour-1 (21) → deferral target = today 21:00. */
    const at21 = deferralTarget(earlyMorning, 21, window);
    expect(at21?.toISOString()).toBe('2026-05-23T21:00:00.000Z');
  });

  it('preserves the date when deferring late within the same day', () => {
    /* Late in the window. Preferred is later still — defer today. */
    const lateInWindow = new Date('2026-05-23T20:55:00Z');
    const target = deferralTarget(lateInWindow, 21, window);
    expect(target?.toISOString()).toBe('2026-05-23T21:00:00.000Z');
  });
});
