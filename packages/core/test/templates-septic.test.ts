import { describe, it, expect } from 'vitest';
import { renderEmail, TEMPLATES, mapSepticEvidence, pickSlot } from '@keres/core';

const baseCtx = {
  leadId: 'septic-1',
  business: 'Acme Septic Co',
  city: 'Houston',
  fromName: 'Sam',
  fromSignoff: 'Keres AI',
};

describe('Septic / Houston pilot template', () => {
  it('is registered as a template', () => {
    expect(TEMPLATES['septic-houston-pilot']).toBeTruthy();
  });

  it('uses the no_website opener and exposes its supporting signal', () => {
    const r = renderEmail(TEMPLATES['septic-houston-pilot']!, {
      ...baseCtx,
      signals: { webPresenceLevel: 'none', isStormZone: false, niche: 'Septic', hasOnlineBooking: false },
    });
    expect(r.slotKey).toBe('no_website');
    expect(r.body).toContain('Acme Septic Co');
    /* Evidence mapping reports the signal that picked the opener. */
    expect(mapSepticEvidence('no_website').signal).toContain('web_presence_level=none');
  });

  it('falls back to default when no specific signal is present', () => {
    const r = renderEmail(TEMPLATES['septic-houston-pilot']!, {
      ...baseCtx,
      signals: { webPresenceLevel: 'modern', isStormZone: false, niche: 'Septic', hasOnlineBooking: false },
    });
    expect(r.slotKey).toBe('default');
    /* Default opener never claims something we don't know. */
    expect(r.body.toLowerCase()).not.toContain("don't have a website");
    expect(r.body.toLowerCase()).not.toContain('no website');
  });

  it('renders no unresolved tokens for any slot variant', () => {
    for (const wp of ['none', 'social_only', 'gbp_only', 'basic'] as const) {
      const r = renderEmail(TEMPLATES['septic-houston-pilot']!, {
        ...baseCtx,
        signals: { webPresenceLevel: wp, isStormZone: false, niche: 'Septic', hasOnlineBooking: false },
      });
      expect(r.body).not.toMatch(/\{\{/);
      expect(r.subject).not.toMatch(/\{\{/);
    }
  });

  it('pickSlot matches our evidence intentions', () => {
    expect(pickSlot({ webPresenceLevel: 'none', isStormZone: false, niche: 'Septic', hasOnlineBooking: false })).toBe('no_website');
    expect(pickSlot({ webPresenceLevel: 'social_only', isStormZone: false, niche: 'Septic', hasOnlineBooking: false })).toBe('social_only');
    expect(pickSlot({ webPresenceLevel: 'gbp_only', isStormZone: false, niche: 'Septic', hasOnlineBooking: false })).toBe('gbp_only');
  });
});
