/**
 * Pure launch-gate tests — exercises every blocker without needing a live DB.
 *
 * Strategy: build a minimal in-memory Drizzle stand-in by calling the
 * `canSend` legacy gate function directly (which is what `evaluateLaunchGate`
 * eventually wraps for the per-campaign checks). For the higher-level
 * `evaluateLaunchGate` checks (sample mode, sender identity, SES production
 * access), we use Vitest's `vi.mock` to replace the DB. To keep the test
 * deterministic and fast, we test the wrapper function on its own pure
 * surface: `canSend` from `services/gates.ts`. That's the function each
 * `evaluateLaunchGate` decision delegates to for the per-campaign blockers
 * we don't already cover in `gates.test.ts`.
 *
 * The end-to-end smoke covers `evaluateLaunchGate` against a Postgres DB
 * (the `smoke.test.ts` file).
 */
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
    dkimSelectors: ['s1','s2','s3'], spfExpectedInclude: 'amazonses.com',
    spfStatus: 'pass', dkimStatus: 'pass', dmarcStatus: 'pass', mxStatus: 'pass',
    dmarcPolicy: 'none', unsubReachable: true, unsubLastStatus: 200,
    lastCheckDetail: null,
    lastCheckedAt: new Date(),
    lastSeedlistTestAt: new Date(), lastSeedlistPassAt: new Date(),
    warmupState: 'warmed', warmupDay: 14,
    dailySendBudget: 50, perDomainCap: 10, sendsToday: 0, sendsTodayDate: null, isActive: true,
    createdAt: new Date(),
  } as any;
}
function baseCamp() { return { id: 'c', orgId: 'o', name: 'test', recipientCount: 100, status: 'draft' } as any; }

describe('canSend hard blockers', () => {
  it('blocks when production access not confirmed', () => {
    const o = baseOrg(); o.productionAccessConfirmed = false;
    const r = canSend({ org: o, domain: baseDomain(), campaign: baseCamp(),
      stats: { sent: 0, bounced: 0, complained: 0 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: true });
    expect(r.blockers.some(b => b.code === 'no_production_access')).toBe(true);
  });
  it('blocks when unsubscribe endpoint unreachable', () => {
    const r = canSend({ org: baseOrg(), domain: baseDomain(), campaign: baseCamp(),
      stats: { sent: 0, bounced: 0, complained: 0 },
      bouncePausePct: 4, complaintPausePct: 0.1, unsubscribeReachable: false });
    expect(r.blockers.some(b => b.code === 'unsub_unreachable')).toBe(true);
  });
});
