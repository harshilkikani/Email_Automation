/**
 * Tests for `scripts/domain-plan.ts`.
 *
 * Verify derivation rules and rendered output. The renderer is checked for
 * the presence of safety language and the required record types — not for
 * exact whitespace, so cosmetic changes won't break the suite.
 */
import { describe, it, expect } from 'vitest';
import { derivePlan, renderPlan } from '../../../scripts/domain-plan.js';

describe('domain:plan derivation', () => {
  it('builds the canonical addresses from minimal input', () => {
    const p = derivePlan({ rootDomain: 'example.com' });
    expect(p.input.rootDomain).toBe('example.com');
    expect(p.input.outreachSubdomain).toBe('outreach');
    expect(p.outreachDomain).toBe('outreach.example.com');
    expect(p.fromEmail).toBe('hello@outreach.example.com');
    expect(p.replyToEmail).toBe('replies@outreach.example.com');
    expect(p.input.sesRegion).toBe('us-east-1');
  });

  it('honors overridden subdomain + local parts', () => {
    const p = derivePlan({
      rootDomain: 'example.com',
      outreachSubdomain: 'mail',
      fromLocalPart: 'hi',
      replyToLocalPart: 'inbox',
      sesRegion: 'us-west-2',
    });
    expect(p.outreachDomain).toBe('mail.example.com');
    expect(p.fromEmail).toBe('hi@mail.example.com');
    expect(p.replyToEmail).toBe('inbox@mail.example.com');
  });

  it('lowercases and trims input', () => {
    const p = derivePlan({ rootDomain: '  EXAMPLE.com  ', outreachSubdomain: ' OutReach ' });
    expect(p.input.rootDomain).toBe('example.com');
    expect(p.outreachDomain).toBe('outreach.example.com');
  });

  it('throws on missing or invalid root domain', () => {
    expect(() => derivePlan({})).toThrow(/ROOT_DOMAIN is required/);
    expect(() => derivePlan({ rootDomain: 'not a domain' })).toThrow(/not a valid domain/);
    expect(() => derivePlan({ rootDomain: 'no-tld' })).toThrow(/not a valid domain/);
  });

  it('throws on bad subdomain label', () => {
    expect(() => derivePlan({ rootDomain: 'example.com', outreachSubdomain: 'bad.label' }))
      .toThrow(/not a valid DNS label/);
    expect(() => derivePlan({ rootDomain: 'example.com', outreachSubdomain: '-bad' }))
      .toThrow(/not a valid DNS label/);
  });

  it('throws on bad local-part', () => {
    expect(() => derivePlan({ rootDomain: 'example.com', fromLocalPart: 'spaces are bad' }))
      .toThrow(/not a valid mailbox local-part/);
  });
});

describe('domain:plan DNS records', () => {
  it('emits SPF, DMARC, MAIL FROM MX, and 3 DKIM placeholders', () => {
    const p = derivePlan({ rootDomain: 'example.com' });
    const types = p.records.map(r => `${r.type}:${r.name}`);
    expect(types.some(t => t.startsWith('TXT:outreach.example.com'))).toBe(true);
    expect(types.some(t => t.startsWith('TXT:_dmarc.example.com'))).toBe(true);
    expect(types.some(t => t.startsWith('MX:outreach.example.com'))).toBe(true);
    const dkim = p.records.filter(r => r.source === 'from-ses-later' && r.type === 'CNAME');
    expect(dkim.length).toBe(3);
    for (const r of dkim) {
      expect(r.value).toMatch(/dkim\.amazonses\.com$/);
      expect(r.name).toMatch(/_domainkey\.outreach\.example\.com$/);
    }
  });

  it('SPF policy starts hard-fail (-all) on the primary record', () => {
    const p = derivePlan({ rootDomain: 'example.com' });
    const spf = p.records.find(r => r.type === 'TXT' && r.name === 'outreach.example.com'
      && r.value.startsWith('v=spf1 include:amazonses.com'));
    expect(spf).toBeTruthy();
    /* The primary SPF must be the strict one. */
    const strict = p.records.find(r => r.type === 'TXT' && r.name === 'outreach.example.com' && r.value.endsWith(' -all'));
    expect(strict).toBeTruthy();
  });

  it('DMARC starts at p=none and references monitoring mailboxes on the root', () => {
    const p = derivePlan({ rootDomain: 'example.com' });
    const dmarc = p.records.find(r => r.type === 'TXT' && r.name === '_dmarc.example.com');
    expect(dmarc?.value).toMatch(/v=DMARC1; p=none;/);
    expect(dmarc?.value).toMatch(/rua=mailto:dmarc-rua@example\.com/);
  });

  it('SES MAIL FROM MX uses the configured region', () => {
    const p = derivePlan({ rootDomain: 'example.com', sesRegion: 'us-west-2' });
    const mx = p.records.find(r => r.type === 'MX' && r.source === 'now');
    expect(mx?.value).toBe('feedback-smtp.us-west-2.amazonses.com');
    expect(mx?.priority).toBe(10);
  });

  it('marks Postmark inbound as a "defer until needed" record', () => {
    const p = derivePlan({ rootDomain: 'example.com' });
    const pmk = p.records.find(r => r.value === 'inbound.postmarkapp.com');
    expect(pmk).toBeTruthy();
    expect(pmk?.source).toBe('from-postmark-later');
  });

  it('emits an app-host CNAME only when APP_DOMAIN differs from the Fly hostname', () => {
    const noAppRecord = derivePlan({ rootDomain: 'example.com' }).records
      .find(r => r.value === 'keres-ops.fly.dev');
    expect(noAppRecord).toBeUndefined();
    const withAppRecord = derivePlan({ rootDomain: 'example.com', appDomain: 'ops.example.com' }).records
      .find(r => r.value === 'keres-ops.fly.dev');
    expect(withAppRecord).toBeTruthy();
    expect(withAppRecord?.proxied).toBe(false);
  });
});

describe('domain:plan rendered output', () => {
  /* The renderer's contract is: contains the addresses + the safety language. */
  const text = renderPlan(derivePlan({ rootDomain: 'example.com' }));
  /* strip ANSI for easier matching */
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');

  it('shows derived values', () => {
    expect(plain).toContain('ROOT_DOMAIN          = example.com');
    expect(plain).toContain('OUTREACH_DOMAIN      = outreach.example.com');
    expect(plain).toContain('FROM_EMAIL           = hello@outreach.example.com');
  });

  it('emits the SPF, DMARC, MAIL-FROM MX, and DKIM placeholders', () => {
    expect(plain).toMatch(/v=spf1 include:amazonses\.com -all/);
    expect(plain).toMatch(/v=DMARC1; p=none/);
    expect(plain).toMatch(/feedback-smtp\.us-east-1\.amazonses\.com/);
    expect(plain).toMatch(/<TOKEN1>\.dkim\.amazonses\.com/);
  });

  it('includes the explicit "do not yet" safety list', () => {
    expect(plain).toContain('do not set ENABLE_SES=true');
    expect(plain).toContain('do not mark DNS verified');
    expect(plain).toContain('do not run a seedlist test');
    expect(plain).toContain('do not launch any campaign');
    expect(plain).toContain('do not enable Postmark outbound');
    expect(plain).toContain('do not enable Hunter, Bouncer, Yelp');
    expect(plain).toContain('do not allocate a dedicated SES IP');
  });
});
