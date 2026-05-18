/**
 * Yelp TOS: 24-hour cache limit. We enforce this with a lint test on the DB schema.
 * No column may persist Yelp-sourced display fields (rating, review_count, etc.)
 * under a Yelp-namespaced name. Generic review_count / review_rating are allowed
 * because they are also produced by other sources, but no Yelp-tagged column.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const schemaPath = resolve(__dirname, '..', '..', 'db', 'src', 'schema.ts');
const schemaSrc = readFileSync(schemaPath, 'utf8');

describe('schema does not persist Yelp-sourced display fields', () => {
  const banned = [
    /\byelp_id\b/i,
    /\byelpRating\b/,
    /\byelp_review_count\b/i,
    /\byelpUrl\b/,
    /\byelpClaimed\b/,
    /\byelpPhotos\b/,
  ];
  for (const re of banned) {
    it(`no schema column matches ${re}`, () => {
      expect(schemaSrc).not.toMatch(re);
    });
  }
});

describe('Yelp adapter never returns more than scoring fields', () => {
  it('YelpAdapter.enrichForScoring returns only { businessId, reviewCount, rating, isClaimed }', async () => {
    const { YelpAdapter } = await import('@keres/providers');
    const adapter = new YelpAdapter({ apiKey: 'x', enabled: true,
      fetcher: async () => ({ businesses: [{
        id: 'biz-1', name: 'Acme', review_count: 5, rating: 4.5, is_claimed: true,
        url: 'https://yelp.com/biz/acme', categories: [{ alias: 'roofing' }],
        location: { address1: '101 Main St' }, photos: ['x.jpg'],
      }] }),
    });
    const r = await adapter.enrichForScoring('Acme', '101 Main St');
    expect(Object.keys(r).sort()).toEqual(['businessId', 'isClaimed', 'rating', 'reviewCount'].sort());
  });
});
