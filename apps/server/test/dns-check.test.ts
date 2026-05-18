import { describe, it, expect, beforeEach } from 'vitest';
import { runDnsCheck } from '../src/services/sender.js';
import { resetConfigCache } from '../src/config.js';

beforeEach(() => {
  process.env.SAMPLE_MODE = 'false';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://x/y';
  process.env.AUTH_TOKEN = 'a-really-long-test-token-aaaaaaaaaaaa';
  process.env.AUTH_COOKIE_SECRET = 'a-really-long-test-cookie-secret-aaaaa';
  process.env.PUBLIC_BASE_URL = 'https://app.example.com';
  resetConfigCache();
});

function makeResolvers(over: Partial<{
  txt: Record<string, string[]>;
  cname: Record<string, string[]>;
  mx: Record<string, Array<{ priority: number; exchange: string }>>;
  unsubStatus: number;
}>) {
  return {
    resolveTxt: async (name: string) => {
      const r = over.txt?.[name];
      if (r === undefined) throw new Error('ENODATA');
      return r.map(s => [s]);
    },
    resolveCname: async (name: string) => {
      const r = over.cname?.[name];
      if (r === undefined) throw new Error('ENOTFOUND');
      return r;
    },
    resolveMx: async (name: string) => {
      const r = over.mx?.[name];
      if (r === undefined) throw new Error('ENODATA');
      return r;
    },
    fetchUrl: async (_url: string) => ({ status: over.unsubStatus ?? 200 }),
  };
}

describe('DNS check — all green', () => {
  it('passes when SPF includes ESP and all 3 DKIM CNAMEs resolve and DMARC present', async () => {
    const r = await runDnsCheck('outreach.example.com', {
      resolvers: makeResolvers({
        txt: {
          'outreach.example.com': ['v=spf1 include:amazonses.com -all'],
          '_dmarc.example.com': ['v=DMARC1; p=none; rua=mailto:rua@example.com'],
        },
        cname: {
          's1._domainkey.outreach.example.com': ['s1.example-ses.amazonses.com'],
          's2._domainkey.outreach.example.com': ['s2.example-ses.amazonses.com'],
          's3._domainkey.outreach.example.com': ['s3.example-ses.amazonses.com'],
        },
        mx: { 'outreach.example.com': [{ priority: 10, exchange: 'inbound.amazonses.com' }] },
        unsubStatus: 200,
      }),
    });
    expect(r.spf).toBe('pass');
    expect(r.dkim).toBe('pass');
    expect(r.dmarc).toBe('pass');
    expect(r.unsubscribeReachable).toBe('pass');
    expect(r.detail.dkim.passing).toEqual(['s1', 's2', 's3']);
    expect(r.detail.dkim.missing).toEqual([]);
  });
});

describe('DNS check — failure modes', () => {
  it('fails when only s1 DKIM resolves (s2/s3 missing)', async () => {
    const r = await runDnsCheck('outreach.example.com', {
      resolvers: makeResolvers({
        txt: { 'outreach.example.com': ['v=spf1 include:amazonses.com -all'], '_dmarc.example.com': ['v=DMARC1; p=none'] },
        cname: { 's1._domainkey.outreach.example.com': ['s1.amazonses.com'] },
        mx: { 'outreach.example.com': [{ priority: 10, exchange: 'm' }] },
        unsubStatus: 200,
      }),
    });
    expect(r.dkim).toBe('fail');
    expect(r.detail.dkim.missing).toEqual(['s2', 's3']);
  });
  it('fails SPF when include directive is missing', async () => {
    const r = await runDnsCheck('outreach.example.com', {
      resolvers: makeResolvers({
        txt: { 'outreach.example.com': ['v=spf1 -all'], '_dmarc.example.com': ['v=DMARC1; p=none'] },
        cname: {
          's1._domainkey.outreach.example.com': ['s1.x'],
          's2._domainkey.outreach.example.com': ['s2.x'],
          's3._domainkey.outreach.example.com': ['s3.x'],
        },
        mx: { 'outreach.example.com': [{ priority: 10, exchange: 'm' }] },
        unsubStatus: 200,
      }),
    });
    expect(r.spf).toBe('fail');
    expect(r.detail.spf.includesEsp).toBe(false);
  });
  it('fails DMARC when no DMARC TXT exists', async () => {
    const r = await runDnsCheck('outreach.example.com', {
      resolvers: makeResolvers({
        txt: { 'outreach.example.com': ['v=spf1 include:amazonses.com -all'] },
        cname: {
          's1._domainkey.outreach.example.com': ['s1.x'],
          's2._domainkey.outreach.example.com': ['s2.x'],
          's3._domainkey.outreach.example.com': ['s3.x'],
        },
        mx: { 'outreach.example.com': [{ priority: 10, exchange: 'm' }] },
        unsubStatus: 200,
      }),
    });
    expect(r.dmarc).toBe('fail');
  });
  it('marks unsubscribe unreachable on non-2xx', async () => {
    const r = await runDnsCheck('outreach.example.com', {
      resolvers: makeResolvers({
        txt: { 'outreach.example.com': ['v=spf1 include:amazonses.com -all'], '_dmarc.example.com': ['v=DMARC1; p=none'] },
        cname: {
          's1._domainkey.outreach.example.com': ['s1.x'],
          's2._domainkey.outreach.example.com': ['s2.x'],
          's3._domainkey.outreach.example.com': ['s3.x'],
        },
        mx: { 'outreach.example.com': [{ priority: 10, exchange: 'm' }] },
        unsubStatus: 500,
      }),
    });
    expect(r.unsubscribeReachable).toBe('fail');
    expect(r.detail.unsubscribe.status).toBe(500);
  });
});

describe('DNS check — sample mode returns all-green non-real', () => {
  it('returns deterministic pass with real=false', async () => {
    process.env.SAMPLE_MODE = 'true';
    resetConfigCache();
    const r = await runDnsCheck('any.example.com');
    expect(r.real).toBe(false);
    expect(r.spf).toBe('pass');
    expect(r.dkim).toBe('pass');
  });
});
