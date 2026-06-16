import { describe, it, expect } from 'vitest';
import { composeOfferEmail, offerSubjects, OFFER_LABEL, type ValidationOffer } from '../src/index';

const OFFERS: ValidationOffer[] = ['claim_supplement', 'liens', 'reviews'];

describe('validation offers', () => {
  it('every offer has a label and two subject templates', () => {
    for (const o of OFFERS) {
      expect(OFFER_LABEL[o]).toBeTruthy();
      const subs = offerSubjects(o);
      expect(subs).toHaveLength(2);
      expect(subs[0]).toContain('{{business}}');
    }
  });

  it('composes a body + variant tag for every offer, link-free with signoff tokens', () => {
    for (const o of OFFERS) {
      const { body, variant } = composeOfferEmail({ offer: o, business: 'Acme Co', city: 'Dallas', ownerFirst: 'Mike', seed: 'lead-1' });
      expect(body).toMatch(/^Hi Mike,/);
      expect(body).not.toMatch(/https?:\/\//);          // reply-only: no links
      expect(body).toContain('{{from_name}}');
      expect(body).toContain('{{from_signoff}}');
      expect(variant.offer).toBe(o);
    }
  });

  it('reviews offer pitches Google reviews and asks for a reply (no link)', () => {
    const { body } = composeOfferEmail({ offer: 'reviews', business: 'Bright Dental', city: 'Austin', seed: 'r1' });
    expect(body.toLowerCase()).toContain('review');
    expect(body.toLowerCase()).toMatch(/reply|example/);
  });

  it('varies wording by seed for the reviews offer', () => {
    const bodies = new Set(['a', 'b', 'c', 'd'].map(s => composeOfferEmail({ offer: 'reviews', business: 'Acme', city: 'Reno', seed: s }).body));
    expect(bodies.size).toBeGreaterThan(1);
  });
});
