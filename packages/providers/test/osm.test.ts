import { describe, it, expect } from 'vitest';
import { OsmAdapter, OsmSampleAdapter, buildOverpass } from '@keres/providers';

describe('OSM Overpass adapter', () => {
  it('buildOverpass interpolates city', () => {
    const q = buildOverpass({ niche: 'Septic', city: 'Houston', state: 'TX', targetCount: 25 });
    expect(q).toContain('Houston');
    expect(q).toContain('septic_tank_cleaner');
  });
  it('converts an OSM element to a candidate', async () => {
    const fetcher = async () => ([{
      type: 'node' as const, id: 1,
      lat: 29.7, lon: -95.4,
      tags: {
        name: 'Test Septic',
        phone: '+1 713-555-1212',
        website: 'https://testseptic.com',
        'addr:housenumber': '101',
        'addr:street': 'Main St',
        'addr:city': 'Houston',
        'addr:state': 'TX',
        'addr:postcode': '77001',
      },
    }]);
    const adapter = new OsmAdapter({ endpoint: 'http://example.com', userAgent: 'test', enabled: true, fetcher });
    const r = await adapter.search({ niche: 'Septic', city: 'Houston', state: 'TX', targetCount: 25 });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].name).toBe('Test Septic');
    expect(r.attribution).toContain('OpenStreetMap contributors');
  });
  it('skips elements without phone', async () => {
    const fetcher = async () => ([{ type: 'node' as const, id: 1, tags: { name: 'No Phone' } }]);
    const adapter = new OsmAdapter({ endpoint: 'x', userAgent: 't', enabled: true, fetcher });
    const r = await adapter.search({ niche: 'Septic', city: 'Houston', state: 'TX', targetCount: 25 });
    expect(r.candidates.length).toBe(0);
  });
  it('sample adapter returns deterministic candidates with attribution', async () => {
    const adapter = new OsmSampleAdapter();
    const r = await adapter.search({ niche: 'Septic', city: 'Houston', state: 'TX', targetCount: 10 });
    expect(r.candidates.length).toBe(10);
    expect(r.candidates.every(c => c.phone)).toBe(true);
    expect(r.candidates.every(c => c.niche === 'Septic')).toBe(true);
  });
});
