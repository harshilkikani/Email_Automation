import { describe, it, expect } from 'vitest';
import { FoursquareAdapter, type FoursquareResponse } from '../src/foursquare.js';

const resp: FoursquareResponse = {
  results: [
    { fsq_id: 'a', name: 'Acme HVAC', website: 'https://acmehvac.com', tel: '512-555-0100',
      location: { formatted_address: '1 Main St, Austin, TX', locality: 'Austin', region: 'TX', postcode: '78701' } },
    { fsq_id: 'b', name: 'No Site Co' },   // skipped — no website
  ],
};

describe('FoursquareAdapter', () => {
  it('maps results with a website and skips those without', async () => {
    const a = new FoursquareAdapter({ enabled: true, apiKey: 'k', fetcher: async () => resp });
    const r = await a.search({ niche: 'HVAC', city: 'Austin', state: 'TX', targetCount: 10 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.name).toBe('Acme HVAC');
    expect(r.candidates[0]!.website).toBe('https://acmehvac.com');
    expect(r.candidates[0]!.source).toBe('foursquare');
    expect(r.costCents).toBe(0);
  });

  it('is disabled without a key, and fails soft on error', async () => {
    expect(new FoursquareAdapter({ enabled: true, apiKey: '' }).isEnabled()).toBe(false);
    const a = new FoursquareAdapter({ enabled: true, apiKey: 'k', fetcher: async () => { throw new Error('boom'); } });
    const r = await a.search({ niche: 'HVAC', city: 'Austin', state: 'TX', targetCount: 5 });
    expect(r.candidates).toHaveLength(0);   // soft fail, no throw
  });
});
