import { describe, it, expect } from 'vitest';
import {
  deriveDeficiencies, deterministicOpener, sanitizeOpener, composeEmail,
  NoopAiAdapter, OllamaAdapter, renderEmail, defaultTemplateFor, pickSignoffName,
  type IntelFacts, type SignalFacts,
} from '../src/index.js';

const baseIntel: IntelFacts = { bookingVendor: null, techStack: [], emails: ['a@b.com'], hoursText: null, yearFounded: null };
const baseSig: SignalFacts = { webPresenceLevel: 'modern', hasOnlineBooking: true, reviewCount30d: 20, reviewRating: 4.8 };

describe('deriveDeficiencies', () => {
  it('flags no online booking when there is no booking vendor', () => {
    const d = deriveDeficiencies({ ...baseIntel }, { ...baseSig, hasOnlineBooking: false });
    expect(d.map(x => x.code)).toContain('no_online_booking');
  });

  it('prioritizes web presence (no_website first)', () => {
    const d = deriveDeficiencies({ ...baseIntel, bookingVendor: null }, { ...baseSig, webPresenceLevel: 'none', hasOnlineBooking: false });
    expect(d[0]!.code).toBe('no_website');
  });

  it('detects a dated DIY builder', () => {
    const d = deriveDeficiencies({ ...baseIntel, techStack: ['GoDaddy'] }, baseSig);
    expect(d.map(x => x.code)).toContain('dated_builder');
  });

  it('detects a stale site by founded year', () => {
    const d = deriveDeficiencies({ ...baseIntel, yearFounded: 2001 }, baseSig, 2026);
    expect(d.map(x => x.code)).toContain('stale_site');
  });

  it('returns nothing when the business looks healthy', () => {
    expect(deriveDeficiencies(baseIntel, baseSig)).toEqual([]);
  });

  it('only states verifiable facts (no fabrication)', () => {
    const d = deriveDeficiencies({ ...baseIntel }, { ...baseSig, reviewCount30d: 0 });
    expect(d.some(x => x.code === 'no_reviews')).toBe(true);
    // reviewCount null must NOT produce a reviews deficiency
    expect(deriveDeficiencies(baseIntel, { ...baseSig, reviewCount30d: null }).some(x => /review/.test(x.code))).toBe(false);
  });
});

describe('deterministicOpener', () => {
  it('builds a specific opener from the top deficiency', () => {
    const d = deriveDeficiencies({ ...baseIntel, bookingVendor: null }, { ...baseSig, hasOnlineBooking: false });
    const o = deterministicOpener('Acme Plumbing', 'Austin', d);
    expect(o).toContain('Acme Plumbing');
    expect(o).toContain('Austin');
  });
  it('is null with no deficiencies', () => {
    expect(deterministicOpener('Acme', 'Austin', [])).toBeNull();
  });
});

describe('sanitizeOpener', () => {
  it('strips quotes, preamble, and rejects links', () => {
    expect(sanitizeOpener('Here is the opener: "Saw Acme — looks like no booking."', 'Acme'))
      .toBe('Saw Acme — looks like no booking.');
    expect(sanitizeOpener('Check Acme at https://x.com now', 'Acme')).toBe('');
  });
  it('rejects output that never mentions the business', () => {
    expect(sanitizeOpener('A generic line with no name here at all.', 'Acme')).toBe('');
  });
});

describe('NoopAiAdapter.personalizeOpener', () => {
  it('returns null (deterministic fallback)', async () => {
    const a = new NoopAiAdapter();
    expect(await a.personalizeOpener({ business: 'Acme', city: 'Austin', niche: 'Plumber', deficiencies: deriveDeficiencies(baseIntel, { ...baseSig, hasOnlineBooking: false }), product: 'x' })).toBeNull();
  });
});

describe('OllamaAdapter.personalizeOpener', () => {
  const defs = deriveDeficiencies(baseIntel, { ...baseSig, hasOnlineBooking: false });

  it('returns the model opener on success', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ response: 'Saw Acme in Austin — looks like there is no way to book online.' }) })) as any;
    try {
      const a = new OllamaAdapter('http://x', 'm');
      const o = await a.personalizeOpener({ business: 'Acme', city: 'Austin', niche: 'Plumber', deficiencies: defs, product: 'x' });
      expect(o).toContain('Acme');
    } finally { globalThis.fetch = orig; }
  });

  it('falls back to null on error', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    try {
      const a = new OllamaAdapter('http://x', 'm');
      expect(await a.personalizeOpener({ business: 'Acme', city: 'Austin', niche: 'Plumber', deficiencies: defs, product: 'x' })).toBeNull();
    } finally { globalThis.fetch = orig; }
  });

  it('returns null when there are no deficiencies (never invents)', async () => {
    const a = new OllamaAdapter('http://x', 'm');
    expect(await a.personalizeOpener({ business: 'Acme', city: 'Austin', niche: 'Plumber', deficiencies: [], product: 'x' })).toBeNull();
  });
});

describe('composeEmail (deep whole-email personalization)', () => {
  const defs = deriveDeficiencies(baseIntel, { ...baseSig, hasOnlineBooking: false });
  it('composes a full body greeting the owner, naming the gap, with signoff tokens', () => {
    const body = composeEmail({ business: 'Acme Septic', city: 'Austin', niche: 'Septic', deficiencies: defs, ownerFirst: 'John' })!;
    expect(body).toContain('Hi John,');
    expect(body).toContain('Acme Septic');
    expect(body).toContain('no online booking');     // the specific gap
    expect(body).toContain('{{from_name}}');          // persona filled at render
    expect(body).toContain('{{from_signoff}}');
  });
  it('falls back to "Hi there," without an owner, and is null with no gap', () => {
    expect(composeEmail({ business: 'Acme', city: '', niche: 'Septic', deficiencies: defs })).toContain('Hi there,');
    expect(composeEmail({ business: 'Acme', city: '', niche: 'Septic', deficiencies: [] })).toBeNull();
  });
  it('renderEmail uses the provided full body for touch 1', () => {
    const tpl = defaultTemplateFor('Septic');
    const body = composeEmail({ business: 'Acme Septic', city: 'Austin', niche: 'Septic', deficiencies: defs, ownerFirst: 'John' })!;
    const out = renderEmail(tpl, {
      leadId: 'l1', business: 'Acme Septic', city: 'Austin',
      signals: { webPresenceLevel: 'basic' as const, isStormZone: false, niche: 'Septic' as const, hasOnlineBooking: false },
      fromName: 'Sarah', fromSignoff: 'Keres AI', body, step: 1,
    });
    expect(out.body).toContain('Hi John,');
    expect(out.body).toContain('Sarah');              // persona token expanded
    expect(out.body).not.toContain('{{from_name}}');  // tokens resolved
  });
});

describe('pickSignoffName', () => {
  const pool = ['Jake', 'Sarah', 'Marcus', 'Emily'];
  it('is stable per lead id', () => {
    expect(pickSignoffName('lead-1', pool)).toBe(pickSignoffName('lead-1', pool));
  });
  it('varies across leads and stays within the pool', () => {
    const picks = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => pickSignoffName(id, pool));
    picks.forEach(p => expect(pool).toContain(p));
    expect(new Set(picks).size).toBeGreaterThan(1);
  });
  it('returns null with no names (caller falls back to org from-name)', () => {
    expect(pickSignoffName('lead-1', [])).toBeNull();
  });
});

describe('renderEmail opener override', () => {
  it('uses the provided opener instead of the slot opener', () => {
    const tpl = defaultTemplateFor('Plumber');
    const ctx = {
      leadId: 'lead-1', business: 'Acme', city: 'Austin',
      signals: { webPresenceLevel: 'none' as const, isStormZone: false, niche: 'Plumber' as const, hasOnlineBooking: false },
      fromName: 'Op', opener: 'Custom AI opener about Acme.',
    };
    expect(renderEmail(tpl, ctx).body).toContain('Custom AI opener about Acme.');
  });

  it('renders a follow-up body (Re: subject) for step > 1', () => {
    const tpl = defaultTemplateFor('Plumber');
    const ctx = {
      leadId: 'lead-1', business: 'Acme', city: 'Austin',
      signals: { webPresenceLevel: 'none' as const, isStormZone: false, niche: 'Plumber' as const, hasOnlineBooking: false },
      fromName: 'Sarah', fromSignoff: 'Keres AI', step: 2,
    };
    const out = renderEmail(tpl, ctx);
    expect(out.subject.startsWith('Re: ')).toBe(true);
    expect(out.body).toMatch(/Acme/);
    expect(out.body).toContain('Sarah');     // persona signoff carries into follow-ups
  });

  it('falls back to deterministic slot opener when no opener provided', () => {
    const tpl = defaultTemplateFor('Plumber');
    const ctx = {
      leadId: 'lead-1', business: 'Acme', city: 'Austin',
      signals: { webPresenceLevel: 'none' as const, isStormZone: false, niche: 'Plumber' as const, hasOnlineBooking: false },
      fromName: 'Op',
    };
    const body = renderEmail(tpl, ctx).body;
    expect(body).not.toContain('Custom AI opener');
    expect(body.length).toBeGreaterThan(0);
  });
});
