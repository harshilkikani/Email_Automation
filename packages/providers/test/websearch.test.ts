import { describe, it, expect } from 'vitest';
import { WebSearchAdapter, type WebResult } from '../src/websearch.js';

/* Raw web results: real business, a directory, a listicle, and a duplicate
   domain — only the real business sites should survive. */
function results(): WebResult[] {
  return [
    { url: 'https://abcplumbingaustin.com/', title: 'ABC Plumbing | Austin TX' },
    { url: 'https://www.yelp.com/biz/abc-plumbing', title: 'ABC Plumbing - Yelp' },
    { url: 'https://listicles.example.com/best', title: '17 Best Plumbers in Austin (2025)' },
    { url: 'https://abcplumbingaustin.com/contact', title: 'ABC Plumbing Contact' },
    { url: 'https://southtownseptic.com/', title: 'Southtown Septic Co. - Home' },
  ];
}

describe('WebSearchAdapter', () => {
  const cfg = { enabled: true, fetcher: async () => results() };

  it('keeps only real business sites: drops directories, listicles, dupes', async () => {
    const a = new WebSearchAdapter(cfg);
    const r = await a.search({ niche: 'Plumber', city: 'Austin', state: 'TX', targetCount: 10 });
    const hosts = r.candidates.map(c => new URL(c.website!).hostname).sort();
    expect(hosts).toEqual(['abcplumbingaustin.com', 'southtownseptic.com']);
    expect(r.candidates.find(c => c.website!.includes('abcplumbing'))!.name).toBe('ABC Plumbing');
    expect(r.source).toBe('websearch');
  });

  it('is a no-op when disabled', async () => {
    const a = new WebSearchAdapter({ enabled: false, fetcher: async () => results() });
    const r = await a.search({ niche: 'Plumber', city: 'Austin', state: 'TX', targetCount: 10 });
    expect(r.candidates).toEqual([]);
  });

  it('respects targetCount', async () => {
    const a = new WebSearchAdapter(cfg);
    const r = await a.search({ niche: 'Plumber', city: 'Austin', state: 'TX', targetCount: 1 });
    expect(r.candidates).toHaveLength(1);
  });
});
