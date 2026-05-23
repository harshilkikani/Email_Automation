import { describe, it, expect } from 'vitest';
import { signUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } from '@keres/email/unsubscribe';

const SECRET = 'unit-test-secret';

describe('unsubscribe tokens', () => {
  it('round-trip succeeds', () => {
    const tok = signUnsubscribeToken({ email: 'lead@example.com', scope: 'org-1' }, SECRET);
    const v = verifyUnsubscribeToken(tok, SECRET);
    expect(v).not.toBeNull();
    expect(v!.email).toBe('lead@example.com');
    expect(v!.scope).toBe('org-1');
  });
  it('rejects wrong secret', () => {
    const tok = signUnsubscribeToken({ email: 'lead@example.com', scope: 'org-1' }, SECRET);
    expect(verifyUnsubscribeToken(tok, 'wrong')).toBeNull();
  });
  it('rejects tampered token', () => {
    const tok = signUnsubscribeToken({ email: 'lead@example.com', scope: 'org-1' }, SECRET);
    const [body, sig] = tok.split('.');
    expect(verifyUnsubscribeToken(`${body}AA.${sig}`, SECRET)).toBeNull();
  });
  it('rejects expired token', () => {
    const tok = signUnsubscribeToken({ email: 'lead@example.com', scope: 'org-1' }, SECRET, -1);
    expect(verifyUnsubscribeToken(tok, SECRET)).toBeNull();
  });
  it('unsubscribeUrl builds correctly', () => {
    expect(unsubscribeUrl('https://app.keres.com', 'abc.def')).toBe('https://app.keres.com/unsubscribe/abc.def');
  });
});
