import { describe, it, expect } from 'vitest';
import { HunterAdapter } from '@keres/providers';

const sample = {
  data: {
    domain: 'acmeplumbing.com',
    emails: [
      { value: 'info@acmeplumbing.com', first_name: null, last_name: null, position: null, confidence: 80 },
      { value: 'mike@acmeplumbing.com', first_name: 'Mike', last_name: 'Rivera', position: 'Owner', confidence: 95 },
      { value: 'dispatch@acmeplumbing.com', first_name: 'Dana', last_name: 'Lee', position: 'Dispatcher', confidence: 70 },
    ],
  },
};

describe('HunterAdapter.domainSearch', () => {
  it('maps the domain-search payload into owner candidates', async () => {
    const h = new HunterAdapter({ enabled: true, apiKey: 'k', fetcher: async () => sample });
    const cands = await h.domainSearch('acmeplumbing.com');
    expect(cands).toHaveLength(3);
    const mike = cands.find(c => c.firstName === 'Mike')!;
    expect(mike.position).toBe('Owner');
    expect(mike.confidence).toBeCloseTo(0.95);
  });

  it('returns [] when disabled (never spends a credit)', async () => {
    const h = new HunterAdapter({ enabled: false, apiKey: '', fetcher: async () => sample });
    expect(await h.domainSearch('x.com')).toEqual([]);
  });

  it('tolerates a malformed payload', async () => {
    const h = new HunterAdapter({ enabled: true, apiKey: 'k', fetcher: async () => ({ data: {} }) });
    expect(await h.domainSearch('x.com')).toEqual([]);
  });
});
