import { describe, it, expect } from 'vitest';
import { pickHunterOwner } from '../src/services/owner-enrich.js';
import type { HunterOwnerCandidate } from '@keres/providers';

const c = (o: Partial<HunterOwnerCandidate>): HunterOwnerCandidate => ({
  email: 'x@x.com', firstName: null, lastName: null, position: null, confidence: null, ...o,
});

describe('pickHunterOwner', () => {
  it('prefers the most senior titled, named person', () => {
    const owner = pickHunterOwner([
      c({ email: 'info@x.com', firstName: null }),
      c({ email: 'mike@x.com', firstName: 'Mike', lastName: 'Rivera', position: 'Owner', confidence: 0.9 }),
      c({ email: 'dana@x.com', firstName: 'Dana', lastName: 'Lee', position: 'Dispatcher', confidence: 0.95 }),
    ]);
    expect(owner?.name).toBe('Mike Rivera');
  });

  it('falls back to a named person even without an owner title', () => {
    const owner = pickHunterOwner([
      c({ email: 'info@x.com', firstName: null }),
      c({ email: 'sam@x.com', firstName: 'Sam', lastName: 'Cole', position: 'Technician', confidence: 0.6 }),
    ]);
    expect(owner?.name).toBe('Sam Cole');
  });

  it('breaks title ties on confidence', () => {
    const owner = pickHunterOwner([
      c({ email: 'a@x.com', firstName: 'Al', lastName: 'One', position: 'Owner', confidence: 0.7 }),
      c({ email: 'b@x.com', firstName: 'Bo', lastName: 'Two', position: 'Owner', confidence: 0.92 }),
    ]);
    expect(owner?.name).toBe('Bo Two');
  });

  it('returns null when no candidate has a name', () => {
    expect(pickHunterOwner([c({ firstName: null }), c({ firstName: null })])).toBeNull();
    expect(pickHunterOwner([])).toBeNull();
  });
});
