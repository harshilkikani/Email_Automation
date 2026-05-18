import { describe, it, expect } from 'vitest';
import { lintEmail, highestSeverity } from '@keres/email/linter';

const baseInput = {
  subject: 'quick question, Acme Roofing',
  body: 'Saw Acme Roofing — quick one. We set up a 24/7 AI phone agent that answers every call and books the estimate.\n\nUnsubscribe (one click): https://app.keres.com/unsubscribe/abc.def',
  identityHasPhysicalAddress: true,
  unsubscribeUrlPresent: true,
  canSpamFooterPresent: true,
};

describe('linter', () => {
  it('passes a clean email with no errors', () => {
    const issues = lintEmail(baseInput);
    expect(highestSeverity(issues)).not.toBe('error');
  });
  it('errors on missing physical address', () => {
    const issues = lintEmail({ ...baseInput, identityHasPhysicalAddress: false });
    expect(issues.some(i => i.code === 'no_physical_address')).toBe(true);
    expect(highestSeverity(issues)).toBe('error');
  });
  it('errors on missing unsubscribe link', () => {
    const issues = lintEmail({ ...baseInput, unsubscribeUrlPresent: false });
    expect(issues.some(i => i.code === 'no_unsub_link')).toBe(true);
  });
  it('errors on missing CAN-SPAM footer', () => {
    const issues = lintEmail({ ...baseInput, canSpamFooterPresent: false });
    expect(issues.some(i => i.code === 'no_can_spam_footer')).toBe(true);
  });
  it('errors on deceptive subject (Re:)', () => {
    const issues = lintEmail({ ...baseInput, subject: 'Re: previous thread' });
    expect(issues.some(i => i.code === 'deceptive_subject')).toBe(true);
  });
  it('errors on unresolved template tokens', () => {
    const issues = lintEmail({ ...baseInput, body: 'Saw {{business}} in {{city}}' });
    expect(issues.some(i => i.code === 'unresolved_token')).toBe(true);
  });
  it('warns on spammy phrasing', () => {
    const issues = lintEmail({ ...baseInput, body: baseInput.body + '\n\nClick here for $$$ free money!' });
    expect(issues.some(i => i.code === 'spam_trigger')).toBe(true);
  });
});
