import { describe, it, expect } from 'vitest';
import {
  makeIndex, addToIndex, checkDuplicate, diceSimilarity,
  normEmail, normPhone, normDomain, normName, normAddress,
} from '@keres/core/dedupe';

describe('dedupe normalization', () => {
  it('emails lowercase and trim', () => {
    expect(normEmail(' Foo@Example.COM ')).toBe('foo@example.com');
  });
  it('phone strips non-digits and rejects short', () => {
    expect(normPhone('(713) 555-1212')).toBe('7135551212');
    expect(normPhone('123')).toBeNull();
  });
  it('domain strips protocol and www', () => {
    expect(normDomain('https://www.Foo.Co/bar')).toBe('foo.co');
  });
  it('name strips punctuation', () => {
    expect(normName("O'Reilly Roofing, LLC")).toBe('oreillyroofingllc');
  });
  it('short address returns null', () => {
    expect(normAddress('123')).toBeNull();
    expect(normAddress('123 Main Street')).not.toBeNull();
  });
});

describe('dedupe match', () => {
  const seed = {
    name: 'Acme Roofing Co', email: 'info@acmeroofing.com', phone: '(713) 555-1212',
    website: 'https://acmeroofing.com', address: '101 Main St, Houston, TX 77001',
    city: 'Houston', state: 'TX', source: 'osm', sourceExternalId: 'node/1',
  };
  it('matches exact email', () => {
    const idx = makeIndex();
    addToIndex(idx, seed);
    const r = checkDuplicate({ ...seed, email: 'INFO@acmeroofing.com', name: 'Other Co' } as any, idx);
    expect(r.duplicate).toBe(true);
    expect(r.reason).toBe('email');
  });
  it('matches phone after normalization', () => {
    const idx = makeIndex();
    addToIndex(idx, seed);
    const r = checkDuplicate({ ...seed, email: 'x@y.com', phone: '713-555-1212', name: 'Other' } as any, idx);
    expect(r.duplicate).toBe(true);
    expect(r.reason).toBe('phone');
  });
  it('does NOT confuse identically-named businesses in different cities', () => {
    const idx = makeIndex();
    addToIndex(idx, seed);
    const r = checkDuplicate({
      name: 'Acme Roofing Co',
      email: 'a@b.com', phone: '212-555-2323',
      website: 'differentdomain.com',                    // distinct domain
      address: '99 Wall St, New York, NY 10005',          // distinct address
      city: 'New York', state: 'NY',
      niche: 'Roofer', source: 'osm', sourceExternalId: 'other-id',
    } as any, idx);
    expect(r.duplicate).toBe(false);     // different city/state + distinct keys
  });
  it('fuzzy name match catches near-duplicates within same city', () => {
    const idx = makeIndex();
    addToIndex(idx, seed);
    const r = checkDuplicate({ ...seed, email: 'a@b.com', phone: '281-555-7777', name: 'Acme Roofing Company' } as any, idx);
    expect(r.duplicate).toBe(true);
  });
  it('source+external id matches when all other keys differ', () => {
    const idx = makeIndex();
    addToIndex(idx, seed);
    const r = checkDuplicate({
      name: 'Completely Other Co', email: 'a@b.com', phone: '281-555-1234',
      website: 'differentdomain.com', address: '999 Faraway Ave',
      city: 'Dallas', state: 'TX',
      niche: 'Roofer', source: 'osm', sourceExternalId: 'node/1',
    } as any, idx);
    expect(r.duplicate).toBe(true);
    expect(r.reason).toBe('external_id');
  });
});

describe('dice similarity', () => {
  it('1.0 for identical', () => expect(diceSimilarity('foo','foo')).toBe(1));
  it('high for near-identical', () => expect(diceSimilarity('acmeroofingco','acmeroofingcompany')).toBeGreaterThan(0.7));
});
