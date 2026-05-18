import { describe, it, expect } from 'vitest';
import { canSend } from '../src/services/gates.js';

function baseOrg() {
  return {
    id: 'o', slug: 'o', name: 'Keres', timezone: 'America/Chicago',
    fromName: 'Keres', fromEmail: 'k@k.com', replyTo: 'r@k.com',
    physicalAddress: '1 Main St Austin TX', outreachSubdomain: 'outreach.k.com',
    defaultBookingLink: 'https://cal.k', productionAccessConfirmed: true,
    budgetMode: 'free', createdAt: new Date(), updatedAt: new Date(),
  } as any;
}
function baseDomain() {
  return {
    id: 'd', orgId: 'o', domain: 'outreach.k.com', sesConfigurationSet: 's',
    spfStatus: 'pass', dkimStatus: 'pass', dmarcStatus: 'pass', mxStatus: 'pass',
    dmarcPolicy: 'none', unsubReachable: true,
    lastCheckedAt: new Date(), warmupState: 'warmed', warmupDay: 14,
    dailySendBudget: 50, perDomainCap: 10, sendsToday: 0, isActive: true,
    createdAt: new Date(),
  } as any;
}
function baseCamp() { return { id: 'c', orgId: 'o', name: 'test' } as any; }

describe('canSend gates', () => {
  it('passes when everything is green', () => {
    const r = canSend({
      org: baseOrg(), domain: baseDomain(), campaign: baseCamp(),
      stats: { sent: 0, bounced: 0, complained: 0 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: true,
    });
    expect(r.ok).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it('blocks if SES production access not confirmed', () => {
    const org = baseOrg(); org.productionAccessConfirmed = false;
    const r = canSend({ org, domain: baseDomain(), campaign: baseCamp(),
      stats: { sent: 0, bounced: 0, complained: 0 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: true });
    expect(r.ok).toBe(false);
    expect(r.blockers.some(b => b.code === 'no_production_access')).toBe(true);
  });

  it('blocks if physical address missing', () => {
    const org = baseOrg(); org.physicalAddress = '';
    const r = canSend({ org, domain: baseDomain(), campaign: baseCamp(),
      stats: { sent: 0, bounced: 0, complained: 0 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: true });
    expect(r.blockers.some(b => b.code === 'no_physical_address')).toBe(true);
  });

  it('blocks if any DNS check is not passing', () => {
    const dom = baseDomain(); dom.dkimStatus = 'fail';
    const r = canSend({ org: baseOrg(), domain: dom, campaign: baseCamp(),
      stats: { sent: 0, bounced: 0, complained: 0 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: true });
    expect(r.blockers.some(b => b.code === 'dkim_not_passing')).toBe(true);
  });

  it('blocks when 24h bounce rate ≥ threshold', () => {
    const r = canSend({ org: baseOrg(), domain: baseDomain(), campaign: baseCamp(),
      stats: { sent: 100, bounced: 5, complained: 0 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: true });
    expect(r.blockers.some(b => b.code === 'bounce_rate_high')).toBe(true);
  });

  it('blocks when complaint rate ≥ 0.1%', () => {
    const r = canSend({ org: baseOrg(), domain: baseDomain(), campaign: baseCamp(),
      stats: { sent: 1000, bounced: 0, complained: 2 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: true });
    expect(r.blockers.some(b => b.code === 'complaint_rate_high')).toBe(true);
  });

  it('blocks if daily cap exceeded', () => {
    const dom = baseDomain(); dom.sendsToday = 50;
    const r = canSend({ org: baseOrg(), domain: dom, campaign: baseCamp(),
      stats: { sent: 0, bounced: 0, complained: 0 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: true });
    expect(r.blockers.some(b => b.code === 'daily_cap_exceeded')).toBe(true);
  });
});
