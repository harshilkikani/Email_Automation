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
    const r = await v.verify('jsmith@gmail.com');
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
  it('marks valid when the real mailbox is accepted but a bogus one is not', async () => {
    const v = new FreeVerifier({
      resolveMx: async () => ['mail.business.com'],
      enableSmtp: true,
      smtpProbe: async (email) => !email.startsWith('kr-verify-'),   // real accepted, bogus rejected
    });
    const r = await v.verify('owner@business.com');
    expect(r.status).toBe('valid');
  });
  it('detects catch-all when a guaranteed-nonexistent mailbox is also accepted', async () => {
    const probed: string[] = [];
    const v = new FreeVerifier({
      resolveMx: async () => ['mail.catchall.com'],
      enableSmtp: true,
      smtpProbe: async (email) => { probed.push(email); return true; },   // accepts everything
    });
    const r = await v.verify('owner@catchall.com');
    expect(r.status).toBe('catch_all');
    expect(probed.some(e => e.startsWith('kr-verify-'))).toBe(true);   // it actually probed a bogus addr
  });
  it('does not waste a second probe when the real mailbox is rejected', async () => {
    let calls = 0;
    const v = new FreeVerifier({
      resolveMx: async () => ['mail.business.com'],
      enableSmtp: true,
      smtpProbe: async () => { calls++; return false; },
    });
    const r = await v.verify('ghost@business.com');
    expect(r.status).toBe('invalid');
    expect(calls).toBe(1);
  });
});
