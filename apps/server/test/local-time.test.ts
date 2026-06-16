import { describe, it, expect } from 'vitest';
import { localSendDeferral, STATE_TZ } from '../src/services/local-time.js';

function localHourDow(d: Date, tz: string): { hour: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', weekday: 'short' });
  const m: Record<string, string> = {};
  for (const p of f.formatToParts(d)) m[p.type] = p.value;
  let hour = parseInt(m.hour ?? '0', 10); if (hour === 24) hour = 0;
  const dow: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, dow: dow[m.weekday ?? 'Thu'] ?? 4 };
}

describe('localSendDeferral', () => {
  it('sends now only during local business hours on a weekday, else defers to 10am local weekday', () => {
    // Sweep a full week (no DST transition in this window) across many timezones.
    for (const state of ['CA', 'NY', 'TX', 'FL', 'CO', 'AZ', 'WA', 'IL', 'HI', 'AK']) {
      const tz = STATE_TZ[state]!;
      for (let h = 0; h < 24 * 7; h += 3) {
        const now = new Date(Date.UTC(2026, 5, 15, 0, 0, 0) + h * 3600_000); // week of Jun 15 2026
        const t = localSendDeferral(now, state);
        if (t === null) {
          const cur = localHourDow(now, tz);
          expect(cur.hour, `${state} send-now hour`).toBeGreaterThanOrEqual(9);
          expect(cur.hour, `${state} send-now hour`).toBeLessThan(17);
          expect(cur.dow, `${state} send-now dow`).toBeGreaterThanOrEqual(1);
          expect(cur.dow, `${state} send-now dow`).toBeLessThanOrEqual(5);
        } else {
          expect(t.getTime()).toBeGreaterThan(now.getTime());
          const tt = localHourDow(t, tz);
          expect(tt.hour, `${state} target hour`).toBe(10);
          expect(tt.dow, `${state} target dow`).toBeGreaterThanOrEqual(1);
          expect(tt.dow, `${state} target dow`).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it('a coastal lead at 7am Pacific (10am Eastern) is deferred, not sent early', () => {
    // 2026-06-16 (Tue) 14:00 UTC = 07:00 PDT — before the 9am local window.
    const now = new Date(Date.UTC(2026, 5, 16, 14, 0, 0));
    const t = localSendDeferral(now, 'CA');
    expect(t).not.toBeNull();
    expect(localHourDow(t!, STATE_TZ.CA!).hour).toBe(10);
  });

  it('falls back to a default timezone for unknown / missing states without throwing', () => {
    expect(() => localSendDeferral(new Date(), 'ZZ')).not.toThrow();
    expect(() => localSendDeferral(new Date(), null)).not.toThrow();
    expect(() => localSendDeferral(new Date(), undefined)).not.toThrow();
  });
});
