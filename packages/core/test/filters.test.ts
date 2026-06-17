import { describe, it, expect } from 'vitest';
import { emailIntakeFilter } from '../src/index.js';

describe('emailIntakeFilter', () => {
  it('accepts a real-looking business email', () => {
    expect(emailIntakeFilter('owner@summitroofing.com').ok).toBe(true);
    expect(emailIntakeFilter('info@summitroofing.com').ok).toBe(true);   // role passes intake
  });

  it('rejects invalid syntax', () => {
    expect(emailIntakeFilter('not-an-email').ok).toBe(false);
    expect(emailIntakeFilter('a@b').ok).toBe(false);
  });

  it('rejects disposable domains', () => {
    expect(emailIntakeFilter('x@mailinator.com')).toEqual({ ok: false, reason: 'disposable_domain' });
  });

  it('rejects placeholder/example addresses that always bounce', () => {
    expect(emailIntakeFilter('user@domain.com').reason).toBe('placeholder_domain');
    expect(emailIntakeFilter('hello@example.com').reason).toBe('placeholder_domain');
    expect(emailIntakeFilter('j.doe@inbox.com').reason).toBe('placeholder_local');
    expect(emailIntakeFilter('firstname.lastname@realco.com').reason).toBe('placeholder_local');
    expect(emailIntakeFilter('youremail@gmail.com').reason).toBe('placeholder_local');
  });

  it('rejects asset filenames matched as emails', () => {
    expect(emailIntakeFilter('logo@2x.png').reason).toBe('asset_filename');
    expect(emailIntakeFilter('icon@sprite.svg').reason).toBe('asset_filename');
  });

  it('passes null through (no email is not a failure here)', () => {
    expect(emailIntakeFilter(null).ok).toBe(true);
  });
});
