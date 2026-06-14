import { describe, it, expect } from 'vitest';
import { isSendableStatus } from '../src/services/verify.js';

describe('isSendableStatus (MX-level send policy)', () => {
  it('sends to emails that passed the free checks', () => {
    for (const s of ['valid', 'role', 'catch_all', 'unverifiable_provider', 'unknown']) {
      expect(isSendableStatus(s)).toBe(true);
    }
  });
  it('blocks the genuine bounces', () => {
    expect(isSendableStatus('invalid')).toBe(false);
    expect(isSendableStatus('disposable')).toBe(false);
  });
  it('treats null as sendable (legacy un-verified leads keep working)', () => {
    expect(isSendableStatus(null)).toBe(true);
    expect(isSendableStatus(undefined)).toBe(true);
  });
});
