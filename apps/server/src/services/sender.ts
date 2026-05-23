/**
 * Sender-domain DNS + deliverability checks.
 *
 * Production check covers:
 *   - SPF presence + include of the configured ESP (defaults to amazonses.com)
 *   - DKIM: all 3 SES Easy DKIM CNAME selectors (s1, s2, s3) must resolve.
 *     If `sender_domains.dkim_selectors` lists explicit selectors, those are
 *     used as the authoritative set. Otherwise the three SES selectors are
 *     used. Supplemental common selectors (`default`, `mail`, `selector1`,
 *     `selector2`, `google`) are probed as **diagnostic** information only —
 *     never as proof of SES readiness.
 *   - DMARC: presence, p= value, alignment hint.
 *   - MX: optional (only required for inbound subdomain).
 *   - Unsubscribe endpoint reachability: GET /api/unsubscribe/health returns 200.
 *
 * Sample-mode returns a deterministic all-green result for the eyeball demo.
 * Any production launch gate must pass the *real* check, never the sample one.
 */
import { promises as dns } from 'node:dns';
import { request } from 'undici';
import { getConfig } from '../config.js';

export type DnsState = 'pass' | 'fail' | 'pending';

export interface DnsCheckSummary {
  spf: DnsState;
  dkim: DnsState;
  dmarc: DnsState;
  mx: DnsState;
  unsubscribeReachable: DnsState;
  dmarcPolicy: 'none' | 'quarantine' | 'reject' | null;
  detail: {
    spf: { records: string[]; includesEsp: boolean; expectedInclude: string };
    dkim: {
      requiredSelectors: string[];
      passing: string[];
      missing: string[];
      supplemental: Array<{ selector: string; resolved: boolean }>;
    };
    dmarc: { records: string[]; alignment: 'aligned' | 'misaligned' | 'unknown' };
    mx: { records: string[] };
    unsubscribe: { url: string; status: number | null; error?: string };
  };
  /** Wall-clock when the check finished. */
  checkedAt: string;
  /** Was this a real DNS lookup (false → sample mode). */
  real: boolean;
}

const DEFAULT_SES_SELECTORS = ['s1', 's2', 's3'];
const SUPPLEMENTAL_SELECTORS = ['default', 'mail', 'selector1', 'selector2', 'google'];

export interface DnsCheckOptions {
  /** Override the expected SPF include (default `amazonses.com`). */
  expectedSpfInclude?: string;
  /**
   * Authoritative DKIM selectors to require. When empty, SES's three
   * selectors are used. The DB stores these in `sender_domains.dkim_selectors`.
   */
  requiredDkimSelectors?: string[];
  /** Public base URL to probe for `/api/unsubscribe/health`. */
  publicBaseUrl?: string;
  /** Skip the real network check and return a deterministic sample result. */
  sampleMode?: boolean;
  /** Used by tests to inject lookups. */
  resolvers?: {
    resolveTxt?: (name: string) => Promise<string[][]>;
    resolveCname?: (name: string) => Promise<string[]>;
    resolveMx?: (name: string) => Promise<Array<{ priority: number; exchange: string }>>;
    fetchUrl?: (url: string) => Promise<{ status: number }>;
  };
}

const SPF_RE = /^v=spf1\b/i;

export async function runDnsCheck(domain: string, opts: DnsCheckOptions = {}): Promise<DnsCheckSummary> {
  const cfg = getConfig();
  const sample = opts.sampleMode ?? cfg.sampleMode;
  if (sample) {
    return sampleResult(domain);
  }

  const resolvers = {
    resolveTxt: opts.resolvers?.resolveTxt ?? (n => dns.resolveTxt(n)),
    resolveCname: opts.resolvers?.resolveCname ?? (n => dns.resolveCname(n)),
    resolveMx: opts.resolvers?.resolveMx ?? (n => dns.resolveMx(n)),
    fetchUrl: opts.resolvers?.fetchUrl ?? defaultFetchUrl,
  };

  const expectedInclude = opts.expectedSpfInclude ?? 'amazonses.com';
  const required = (opts.requiredDkimSelectors && opts.requiredDkimSelectors.length > 0)
    ? opts.requiredDkimSelectors
    : DEFAULT_SES_SELECTORS;
  const publicBaseUrl = opts.publicBaseUrl ?? cfg.publicBaseUrl;

  /* SPF */
  let spfRecords: string[] = [];
  let spfState: DnsState = 'pending';
  let includesEsp = false;
  try {
    const txt = await resolvers.resolveTxt(domain);
    spfRecords = txt.map(parts => parts.join(''));
    const spfLine = spfRecords.find(l => SPF_RE.test(l));
    includesEsp = !!spfLine && spfLine.toLowerCase().includes(`include:${expectedInclude.toLowerCase()}`);
    spfState = spfLine && includesEsp ? 'pass' : 'fail';
  } catch { spfState = 'fail'; }

  /* DKIM — all required selectors must resolve to a CNAME. */
  const passing: string[] = [];
  const missing: string[] = [];
  for (const sel of required) {
    try {
      const cname = await resolvers.resolveCname(`${sel}._domainkey.${domain}`);
      if (cname.length > 0) passing.push(sel);
      else missing.push(sel);
    } catch { missing.push(sel); }
  }
  const dkimState: DnsState = missing.length === 0 ? 'pass' : 'fail';

  /* Supplemental selectors (diagnostic only). */
  const supplemental: Array<{ selector: string; resolved: boolean }> = [];
  for (const sel of SUPPLEMENTAL_SELECTORS) {
    if (required.includes(sel)) continue;
    try {
      const cname = await resolvers.resolveCname(`${sel}._domainkey.${domain}`);
      supplemental.push({ selector: sel, resolved: cname.length > 0 });
    } catch {
      supplemental.push({ selector: sel, resolved: false });
    }
  }

  /* DMARC */
  let dmarcRecords: string[] = [];
  let dmarcState: DnsState = 'pending';
  let dmarcPolicy: DnsCheckSummary['dmarcPolicy'] = null;
  let alignment: 'aligned' | 'misaligned' | 'unknown' = 'unknown';
  try {
    const dmarcTxt = await resolvers.resolveTxt(`_dmarc.${rootDomain(domain)}`);
    dmarcRecords = dmarcTxt.map(parts => parts.join(''));
    const dmarcLine = dmarcRecords.find(l => /v=DMARC1/i.test(l));
    if (dmarcLine) {
      dmarcState = 'pass';
      const m = dmarcLine.match(/p=(none|quarantine|reject)/i);
      dmarcPolicy = (m?.[1]?.toLowerCase() ?? null) as DnsCheckSummary['dmarcPolicy'];
      const adkim = (dmarcLine.match(/adkim=([rs])/i)?.[1] ?? 'r').toLowerCase();
      const aspf = (dmarcLine.match(/aspf=([rs])/i)?.[1] ?? 'r').toLowerCase();
      alignment = (adkim === 'r' && aspf === 'r') ? 'aligned' : (adkim === aspf ? 'aligned' : 'misaligned');
    } else { dmarcState = 'fail'; }
  } catch { dmarcState = 'fail'; }

  /* MX (informational — most outreach subdomains don't need an MX). */
  let mxRecords: string[] = [];
  let mxState: DnsState = 'pending';
  try {
    const mx = await resolvers.resolveMx(domain);
    mxRecords = mx.map(m => `${m.priority} ${m.exchange}`);
    mxState = mx.length > 0 ? 'pass' : 'fail';
  } catch { mxState = 'fail'; }

  /* Unsubscribe endpoint reachability. */
  const unsubUrl = `${publicBaseUrl.replace(/\/$/, '')}/api/unsubscribe/health`;
  let unsubReachable: DnsState = 'pending';
  let unsubStatus: number | null = null;
  let unsubError: string | undefined;
  try {
    const r = await resolvers.fetchUrl(unsubUrl);
    unsubStatus = r.status;
    unsubReachable = r.status >= 200 && r.status < 400 ? 'pass' : 'fail';
  } catch (e: any) {
    unsubReachable = 'fail';
    unsubError = e?.message ?? String(e);
  }

  return {
    spf: spfState, dkim: dkimState, dmarc: dmarcState, mx: mxState,
    unsubscribeReachable: unsubReachable, dmarcPolicy,
    detail: {
      spf: { records: spfRecords, includesEsp, expectedInclude },
      dkim: { requiredSelectors: required, passing, missing, supplemental },
      dmarc: { records: dmarcRecords, alignment },
      mx: { records: mxRecords },
      unsubscribe: { url: unsubUrl, status: unsubStatus, error: unsubError },
    },
    checkedAt: new Date().toISOString(),
    real: true,
  };
}

function rootDomain(d: string): string {
  /* Best-effort: DMARC is typically published at the organizational root.
     Strip everything left of the last two labels. Works for simple TLDs. */
  const parts = d.split('.').filter(Boolean);
  if (parts.length <= 2) return d;
  return parts.slice(-2).join('.');
}

async function defaultFetchUrl(url: string): Promise<{ status: number }> {
  const r = await request(url, {
    method: 'GET',
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
  });
  return { status: r.statusCode };
}

function sampleResult(domain: string): DnsCheckSummary {
  return {
    spf: 'pass', dkim: 'pass', dmarc: 'pass', mx: 'pass',
    unsubscribeReachable: 'pass', dmarcPolicy: 'none',
    detail: {
      spf: { records: ['v=spf1 include:amazonses.com -all'], includesEsp: true, expectedInclude: 'amazonses.com' },
      dkim: { requiredSelectors: DEFAULT_SES_SELECTORS, passing: DEFAULT_SES_SELECTORS, missing: [],
        supplemental: SUPPLEMENTAL_SELECTORS.map(s => ({ selector: s, resolved: false })) },
      dmarc: { records: [`v=DMARC1; p=none; rua=mailto:postmaster@${domain}`], alignment: 'aligned' },
      mx: { records: ['10 inbound-smtp.us-east-1.amazonaws.com'] },
      unsubscribe: { url: 'http://sample/api/unsubscribe/health', status: 200 },
    },
    checkedAt: new Date().toISOString(),
    real: false,
  };
}
