import { describe, it, expect } from 'vitest';
import { localSendDeferral, STATE_TZ } from '../src/services/local-time.js';

function localParts(d: Date, tz: string): { hour: number; minute: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const m: Record<string, string> = {};
  for (const p of f.formatToParts(d)) m[p.type] = p.value;
  let hour = parseInt(m.hour ?? '0', 10); if (hour === 24) hour = 0;
  const dow: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, minute: parseInt(m.minute ?? '0', 10), dow: dow[m.weekday ?? 'Thu'] ?? 4 };
}

describe('localSendDeferral', () => {
  it('sends now in local business hours on a weekday, else defers into the 9–11am local window', () => {
    for (const state of ['CA', 'NY', 'TX', 'FL', 'CO', 'AZ', 'WA', 'IL', 'HI', 'AK']) {
      const tz = STATE_TZ[state]!;
      for (let h = 0; h < 24 * 7; h += 3) {
        const now = new Date(Date.UTC(2026, 5, 15, 0, 0, 0) + h * 3600_000); // week of Jun 15 2026
        const t = localSendDeferral(now, state, `${state}-${h}`);
        if (t === null) {
          const cur = localParts(now, tz);
          expect(cur.hour, `${state} send-now hour`).toBeGreaterThanOrEqual(9);
          expect(cur.hour, `${state} send-now hour`).toBeLessThan(17);
          expect(cur.dow).toBeGreaterThanOrEqual(1);
          expect(cur.dow).toBeLessThanOrEqual(5);
        } else {
          expect(t.getTime()).toBeGreaterThan(now.getTime());
          const tt = localParts(t, tz);
          // Lands somewhere in the 9:00–11:00 morning window, on a weekday.
          expect(tt.hour, `${state} target hour`).toBeGreaterThanOrEqual(9);
          expect(tt.hour, `${state} target hour`).toBeLessThan(11);
          expect(tt.dow).toBeGreaterThanOrEqual(1);
          expect(tt.dow).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it('spreads recipients across the window — not all at the same minute (anti-bulk-pattern)', () => {
    // Many recipients, same night/timezone: their target minutes should be distributed.
    const now = new Date(Date.UTC(2026, 5, 16, 6, 0, 0)); // ~1–2am US, everything defers
    const slots = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = localSendDeferral(now, 'NY', `lead-${i}`);
      expect(t).not.toBeNull();
      const p = localParts(t!, STATE_TZ.NY!);
      expect(p.hour).toBeGreaterThanOrEqual(9);
      expect(p.hour).toBeLessThan(11);
      slots.add(`${p.hour}:${p.minute}`);
    }
    // 200 recipients should land on many distinct minutes, never one big spike.
    expect(slots.size).toBeGreaterThan(40);
  });

  it('the same recipient is stable across ticks (its slot does not drift)', () => {
    const now = new Date(Date.UTC(2026, 5, 16, 6, 0, 0));
    const a = localSendDeferral(now, 'CA', 'lead-xyz');
    const b = localSendDeferral(new Date(now.getTime() + 60_000), 'CA', 'lead-xyz');
    expect(localParts(a!, STATE_TZ.CA!)).toEqual(localParts(b!, STATE_TZ.CA!)); // same minute slot
  });

  it('falls back to a default timezone for unknown / missing states without throwing', () => {
    expect(() => localSendDeferral(new Date(), 'ZZ', 's')).not.toThrow();
    expect(() => localSendDeferral(new Date(), null, 's')).not.toThrow();
    expect(() => localSendDeferral(new Date(), undefined, 's')).not.toThrow();
  });
});
