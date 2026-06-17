import { describe, it, expect } from 'vitest';
import { deriveDeficiencies, type IntelFacts, type SignalFacts } from '../src/index';

const intel: IntelFacts = { bookingVendor: null, techStack: [], emails: ['a@b.com'], hoursText: null, yearFounded: null };
const baseSignals: SignalFacts = { webPresenceLevel: 'modern', hasOnlineBooking: true, reviewCount30d: 30, reviewRating: null };

describe('low_rating signal (uses the previously-unused reviewRating)', () => {
  it('flags a low rating with a defensible (non-false-precision) review pitch', () => {
    const d = deriveDeficiencies(intel, { ...baseSignals, reviewRating: 3.2 });
    const lr = d.find(x => x.code === 'low_rating');
    expect(lr).toBeTruthy();
    expect(lr!.fact.toLowerCase()).toContain('review');     // review-automation angle
    expect(lr!.fact).not.toContain('3.2');                  // never asserts the specific (possibly-wrong) rating
    expect(lr!.fact).not.toMatch(/\d(\.\d)?\s*stars?\b/i);  // no "X stars" rating claim
  });

  it('does not flag a healthy rating', () => {
    const d = deriveDeficiencies(intel, { ...baseSignals, reviewRating: 4.7 });
    expect(d.find(x => x.code === 'low_rating')).toBeFalsy();
  });

  it('does not flag when rating is unknown', () => {
    const d = deriveDeficiencies(intel, { ...baseSignals, reviewRating: null });
    expect(d.find(x => x.code === 'low_rating')).toBeFalsy();
  });
});
