import { describe, it, expect } from 'vitest';
import { summarisePlacement } from '../src/services/placement.js';

/* In-memory Drizzle stand-in: just enough to satisfy `summarisePlacement`. */
function fakeDb(rows: Array<{ observed: string | null; sentAt: Date }>): any {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

describe('placement summary', () => {
  it('returns needs-observation when nothing has been observed', async () => {
    const r = await summarisePlacement(fakeDb([
      { observed: null, sentAt: new Date() },
      { observed: null, sentAt: new Date() },
    ]), 'd', 7);
    expect(r.recommendation).toBe('needs-observation');
    expect(r.observed).toBe(0);
  });
  it('passes when primary >= 80%', async () => {
    const r = await summarisePlacement(fakeDb([
      { observed: 'primary', sentAt: new Date() },
      { observed: 'primary', sentAt: new Date() },
      { observed: 'primary', sentAt: new Date() },
      { observed: 'primary', sentAt: new Date() },
      { observed: 'promotions', sentAt: new Date() },
    ]), 'd', 7);
    expect(r.recommendation).toBe('pass');
    expect(r.primaryPct).toBeCloseTo(0.8);
  });
  it('recommends fix-dns when spam >= 40%', async () => {
    const r = await summarisePlacement(fakeDb([
      { observed: 'primary', sentAt: new Date() },
      { observed: 'spam', sentAt: new Date() },
      { observed: 'spam', sentAt: new Date() },
    ]), 'd', 7);
    expect(r.recommendation).toBe('fix-dns');
  });
  it('recommends pause when primary < 50% and not flagged by spam-only', async () => {
    const r = await summarisePlacement(fakeDb([
      { observed: 'primary', sentAt: new Date() },
      { observed: 'promotions', sentAt: new Date() },
      { observed: 'promotions', sentAt: new Date() },
      { observed: 'promotions', sentAt: new Date() },
    ]), 'd', 7);
    expect(r.recommendation).toBe('pause');
  });
  it('recommends warm-longer at 50-79% primary', async () => {
    const r = await summarisePlacement(fakeDb([
      { observed: 'primary', sentAt: new Date() },
      { observed: 'primary', sentAt: new Date() },
      { observed: 'primary', sentAt: new Date() },
      { observed: 'promotions', sentAt: new Date() },
      { observed: 'promotions', sentAt: new Date() },
    ]), 'd', 7);
    expect(r.recommendation).toBe('warm-longer');
  });
});
