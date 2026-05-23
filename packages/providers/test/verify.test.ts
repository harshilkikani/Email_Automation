import { describe, it, expect } from 'vitest';
import { FreeVerifier } from '@keres/providers';

describe('FreeVerifier', () => {
  it('rejects bad syntax', async () => {
    const v = new FreeVerifier();
    const r = await v.verify('not-an-email');
    expect(r.status).toBe('invalid');
  });
  it('flags disposable domains', async () => {
    const v = new FreeVerifier();
    const r = await v.verify('me@mailinator.com');
    expect(r.status).toBe('disposable');
  });
  it('marks Gmail as unverifiable_provider', async () => {
    const v = new FreeVerifier({ resolveMx: async () => ['gmail-smtp-in.l.google.com'] });
    const r = await v.verify('user@gmail.com');
    expect(r.status).toBe('unverifiable_provider');
  });
  it('returns invalid when no MX records', async () => {
    const v = new FreeVerifier({ resolveMx: async () => [] });
    const r = await v.verify('user@deaddomain.zzz');
    expect(r.status).toBe('invalid');
  });
  it('returns role when local part is info/sales/etc', async () => {
    const v = new FreeVerifier({ resolveMx: async () => ['mail.business.com'] });
    const r = await v.verify('info@business.com');
    expect(['role', 'unknown']).toContain(r.status);
  });
});
