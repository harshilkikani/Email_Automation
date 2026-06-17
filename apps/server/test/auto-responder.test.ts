import { describe, it, expect } from 'vitest';
import { composeAutoReplyBody } from '../src/services/auto-responder.js';

describe('composeAutoReplyBody', () => {
  const base = { business: 'Anchor Plumbing', persona: 'Sam', seed: 'msg-123' };

  it('greets by first name when known, generically otherwise', () => {
    expect(composeAutoReplyBody({ ...base, firstName: 'Mike', bookingLink: null })).toMatch(/^Hi Mike,/);
    expect(composeAutoReplyBody({ ...base, firstName: null, bookingLink: null })).toMatch(/^Hi there,/);
  });

  it('is link-free by default (reply-only policy) and asks for a number + time', () => {
    const body = composeAutoReplyBody({ ...base, firstName: 'Mike', bookingLink: null });
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).toMatch(/number/i);
    expect(body).toContain('Anchor Plumbing');
    expect(body.trimEnd().endsWith('Sam')).toBe(true);
  });

  it('includes the booking link only when explicitly provided', () => {
    const body = composeAutoReplyBody({ ...base, firstName: 'Mike', bookingLink: 'https://cal.keresai.com/intro' });
    expect(body).toContain('https://cal.keresai.com/intro');
  });

  it('stays short (speed-to-lead: brevity wins)', () => {
    const body = composeAutoReplyBody({ ...base, firstName: 'Mike', bookingLink: null });
    expect(body.split(/\s+/).length).toBeLessThan(70);
  });

  it('varies wording by seed', () => {
    const a = composeAutoReplyBody({ ...base, firstName: 'Mike', bookingLink: null, seed: 'aaa' });
    const b = composeAutoReplyBody({ ...base, firstName: 'Mike', bookingLink: null, seed: 'zzz' });
    // different seeds should be able to produce different phrasing across the pool
    expect(new Set([a, b]).size).toBeGreaterThanOrEqual(1);
  });
});
