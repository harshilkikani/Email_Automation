import { describe, it, expect } from 'vitest';
import {
  TEMPLATES, defaultTemplateFor, renderEmail, pickSlot, stableHash,
} from '@keres/core/templates';

const ctx = {
  leadId: 'lead-001',
  business: 'Apex Roofing',
  city: 'Houston',
  signals: { webPresenceLevel: 'none' as const, isStormZone: false, niche: 'Roofer' as const, hasOnlineBooking: false },
  fromName: 'Sam at Keres AI',
  fromSignoff: 'Keres AI',
};

describe('templates', () => {
  it('all niche templates exist', () => {
    expect(TEMPLATES.septic).toBeTruthy();
    expect(TEMPLATES.water).toBeTruthy();
    expect(TEMPLATES.hvac).toBeTruthy();
    expect(TEMPLATES.roofer).toBeTruthy();
    expect(TEMPLATES.plumber).toBeTruthy();
    expect(TEMPLATES.electrician).toBeTruthy();
    expect(TEMPLATES.towing).toBeTruthy();
    expect(TEMPLATES['real-estate']).toBeTruthy();
    expect(TEMPLATES['general-audit']).toBeTruthy();
  });

  it('picks no_website slot when web presence is none', () => {
    expect(pickSlot(ctx.signals)).toBe('no_website');
  });

  it('picks storm_zone for roofer in storm zone', () => {
    expect(pickSlot({ ...ctx.signals, webPresenceLevel: 'basic', isStormZone: true })).toBe('storm_zone');
  });

  it('renders without unresolved tokens', () => {
    const r = renderEmail(TEMPLATES.roofer, ctx);
    expect(r.body).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(r.subject).not.toMatch(/\{\{/);
    expect(r.body).toContain('Apex Roofing');
  });

  it('city token resolves when present in body or opener', () => {
    /* Storm-zone opener uses {{city}}, so force that slot. */
    const r = renderEmail(TEMPLATES.roofer, {
      ...ctx,
      signals: { ...ctx.signals, webPresenceLevel: 'basic', isStormZone: true },
    });
    expect(r.body).toContain('Houston');
  });

  it('deterministic per lead-id', () => {
    const a = renderEmail(TEMPLATES.roofer, ctx);
    const b = renderEmail(TEMPLATES.roofer, ctx);
    expect(a.body).toBe(b.body);
    expect(a.subject).toBe(b.subject);
  });

  it('different lead-ids yield different opener selection on average', () => {
    const openers = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = renderEmail(TEMPLATES.roofer, { ...ctx, leadId: 'lead-' + i });
      openers.add(r.body.split('\n')[0]!);
    }
    /* multiple openers exist in the no_website pool, so > 1 distinct expected. */
    expect(openers.size).toBeGreaterThan(1);
  });

  it('no fake personalization — empty business falls back safely', () => {
    const r = renderEmail(TEMPLATES.roofer, { ...ctx, business: '' });
    expect(r.body).toContain('your business');
    expect(r.body).not.toMatch(/\{\{/);
  });

  it('defaultTemplateFor maps niche', () => {
    expect(defaultTemplateFor('Septic').key).toBe('septic');
    expect(defaultTemplateFor('Water/Mold').key).toBe('water');
    expect(defaultTemplateFor('Real Estate').key).toBe('real-estate');
  });

  it('stableHash is deterministic and 64-bit', () => {
    const a = stableHash('hello');
    const b = stableHash('hello');
    expect(a).toBe(b);
    expect(typeof a).toBe('bigint');
  });
});
