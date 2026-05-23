import { describe, expect, it } from 'vitest';
import {
  scoreLead, SCORING_VERSION_V1, applyWeightDelta, tierFor, enrichmentBudgetFor,
  type ScoringInputs,
} from '@keres/core/scoring';

const baseInputs: ScoringInputs = {
  niche: 'Septic',
  webPresenceLevel: 'none',
  hasPhone: true,
  phoneLineType: 'landline',
  hasOnlineBooking: false,
  isStormZone: false,
  licenseStatus: 'active',
  reviewCount30d: 0,
  reviewRating: 4.5,
  competitorDensity: 30,
  ownerOperator: true,
  serviceDispatchModel: true,
  emergencyNiche: true,
  multiLocation: false,
  isFranchise: false,
  isResidentialAddress: false,
  deadDomain: false,
};

describe('scoring', () => {
  it('no-website septic with phone + active license scores high', () => {
    const r = scoreLead(baseInputs);
    expect(r.disqualified).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.contributions.find(c => c.signal === 'web_presence_level')?.points).toBe(35);
    expect(r.contributions.find(c => c.signal === 'license_status' && c.value === 'active')?.points).toBe(10);
  });
  it('disqualifies franchise immediately', () => {
    const r = scoreLead({ ...baseInputs, isFranchise: true });
    expect(r.disqualified).toBe(true);
    expect(r.disqualificationReason).toMatch(/Franchise/);
    expect(r.score).toBe(0);
  });
  it('disqualifies residential address', () => {
    const r = scoreLead({ ...baseInputs, isResidentialAddress: true });
    expect(r.disqualified).toBe(true);
    expect(r.score).toBe(0);
  });
  it('disqualifies missing phone', () => {
    const r = scoreLead({ ...baseInputs, hasPhone: false });
    expect(r.disqualified).toBe(true);
  });
  it('storm zone bumps storm-niches only', () => {
    const a = scoreLead({ ...baseInputs, niche: 'Roofer', isStormZone: true });
    const b = scoreLead({ ...baseInputs, niche: 'Roofer', isStormZone: false });
    expect(a.score).toBeGreaterThan(b.score);
    const c = scoreLead({ ...baseInputs, niche: 'Electrician', isStormZone: true });
    const d = scoreLead({ ...baseInputs, niche: 'Electrician', isStormZone: false });
    expect(c.score).toBe(d.score);
  });
  it('expired license penalises heavily', () => {
    const r = scoreLead({ ...baseInputs, licenseStatus: 'expired' });
    expect(r.score).toBeLessThan(60);
  });
  it('modern website + online booking pulls score down', () => {
    const r = scoreLead({ ...baseInputs, webPresenceLevel: 'modern', hasOnlineBooking: true });
    expect(r.score).toBeLessThan(50);
  });
  it('tier classification', () => {
    expect(tierFor(10)).toBe('discard');
    expect(tierFor(60)).toBe('qualified');
    expect(tierFor(85)).toBe('priority');
    expect(tierFor(99)).toBe('top');
  });
  it('enrichment budget tightens as score drops', () => {
    expect(enrichmentBudgetFor(40).shouldScrapeContact).toBe(false);
    expect(enrichmentBudgetFor(70).shouldScrapeContact).toBe(true);
    expect(enrichmentBudgetFor(70).shouldUseHunterFallback).toBe(false);
    expect(enrichmentBudgetFor(95).shouldUseHunterFallback).toBe(true);
  });
});

describe('scoring versions', () => {
  it('applyWeightDelta caps changes at ±30%', () => {
    const next = applyWeightDelta(SCORING_VERSION_V1, { phonePresent: 1000 });
    expect(next.weights.phonePresent).toBeCloseTo(SCORING_VERSION_V1.weights.phonePresent * 1.3, 5);
    expect(next.id).toBe(SCORING_VERSION_V1.id + 1);
  });
  it('preserves contributions audit trail', () => {
    const r = scoreLead(baseInputs);
    expect(r.contributions.length).toBeGreaterThan(0);
    expect(r.contributions.every(c => typeof c.points === 'number')).toBe(true);
  });
});
