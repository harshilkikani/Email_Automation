import { describe, it, expect } from 'vitest';
import {
  canUseHunter, canUseBouncer, canUsePlaces, canUseTwilioLookupAtIntake, canUseRuntimeAI,
  type ProviderBudgets,
} from '@keres/core/budget';

const freeBudgets: ProviderBudgets = {
  mode: 'free',
  hunterCreditsThisMonth: 0,
  hunterFreeMonthlyCredits: 50,
  bouncerCentsSpentThisMonth: 0,
  bouncerMonthlyBudgetCents: 500,
};

describe('budget guards', () => {
  it('Hunter blocked for low score', () => {
    const r = canUseHunter(freeBudgets, { leadScore: 80, scrapeFailed: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/below 95/);
  });
  it('Hunter blocked when scrape did not fail', () => {
    const r = canUseHunter(freeBudgets, { leadScore: 96, scrapeFailed: false });
    expect(r.ok).toBe(false);
  });
  it('Hunter allowed at score 95 with scrape fail and free credits remaining', () => {
    const r = canUseHunter(freeBudgets, { leadScore: 96, scrapeFailed: true });
    expect(r.ok).toBe(true);
  });
  it('Hunter blocked once free credits exhausted', () => {
    const r = canUseHunter({ ...freeBudgets, hunterCreditsThisMonth: 50 }, { leadScore: 96, scrapeFailed: true });
    expect(r.ok).toBe(false);
  });
  it('Bouncer blocked below score 80', () => {
    const r = canUseBouncer(freeBudgets, { leadScore: 70, freeChainResult: 'unverifiable_provider' });
    expect(r.ok).toBe(false);
  });
  it('Bouncer blocked if free chain was definitive', () => {
    const r = canUseBouncer(freeBudgets, { leadScore: 85, freeChainResult: 'valid' });
    expect(r.ok).toBe(false);
  });
  it('Bouncer allowed for ambiguous priority lead within budget', () => {
    const r = canUseBouncer(freeBudgets, { leadScore: 88, freeChainResult: 'unknown' });
    expect(r.ok).toBe(true);
  });
  it('Bouncer blocked when monthly budget exhausted', () => {
    const r = canUseBouncer({ ...freeBudgets, bouncerCentsSpentThisMonth: 500 }, { leadScore: 88, freeChainResult: 'unknown' });
    expect(r.ok).toBe(false);
  });
  it('Places is permanently blocked at MVP', () => {
    expect(canUsePlaces().ok).toBe(false);
  });
  it('Twilio Lookup at intake is permanently blocked', () => {
    expect(canUseTwilioLookupAtIntake().ok).toBe(false);
  });
  it('Runtime AI is permanently blocked', () => {
    expect(canUseRuntimeAI().ok).toBe(false);
  });
});
