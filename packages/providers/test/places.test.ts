import { describe, it, expect } from 'vitest';
import { PlacesAdapter, type PlacesResponse } from '../src/places.js';

const page: PlacesResponse = {
  places: [
    {
      id: 'p1', displayName: { text: 'Acme Plumbing' }, websiteUri: 'https://acmeplumbing.com',
      nationalPhoneNumber: '(512) 555-0100', formattedAddress: '1 Main St, Austin, TX 78701',
      addressComponents: [
        { longText: 'Austin', types: ['locality'] },
        { longText: 'Texas', shortText: 'TX', types: ['administrative_area_level_1'] },
      ],
    },
    { id: 'p2', displayName: { text: 'No Website Co' } },   // skipped — no websiteUri
  ],
};

describe('PlacesAdapter', () => {
  it('maps places with a website to candidates and skips those without', async () => {
    const a = new PlacesAdapter({ enabled: true, apiKey: 'k', fetcher: async () => page });
    const r = await a.search({ niche: 'Plumber', city: 'Austin', state: 'TX', targetCount: 10 });
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.name).toBe('Acme Plumbing');
    expect(c.website).toBe('https://acmeplumbing.com');
    expect(c.source).toBe('places');
    expect(c.city).toBe('Austin');
    expect(c.state).toBe('TX');
    expect(r.costCents).toBeGreaterThan(0);
  });

  it('is disabled without an api key', async () => {
    const a = new PlacesAdapter({ enabled: true, apiKey: '' });
    expect(a.isEnabled()).toBe(false);
    const r = await a.search({ niche: 'Plumber', city: 'Austin', state: 'TX', targetCount: 5 });
    expect(r.candidates).toHaveLength(0);
    expect(r.costCents).toBe(0);
  });

  it('paginates until targetCount or no token', async () => {
    let calls = 0;
    const a = new PlacesAdapter({
      enabled: true, apiKey: 'k',
      fetcher: async (_q, token) => {
        calls++;
        return token
          ? { places: [{ id: 'p3', displayName: { text: 'B Co' }, websiteUri: 'https://b.com' }] }
          : { places: [{ id: 'p1', displayName: { text: 'A Co' }, websiteUri: 'https://a.com' }], nextPageToken: 'tok' };
      },
    });
    const r = await a.search({ niche: 'Plumber', city: 'Austin', state: 'TX', targetCount: 5 });
    expect(calls).toBe(2);
    expect(r.candidates.map(c => c.name)).toEqual(['A Co', 'B Co']);
  });
});
