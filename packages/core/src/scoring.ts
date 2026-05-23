/**
 * Deterministic, versioned, audit-trailed scoring.
 *
 * Returns a 0-100 score plus a `contributions` array so the UI can render a
 * "why score" drawer per lead. Hard-filter signals short-circuit to score 0
 * with `disqualified=true`.
 */
import type {
  Niche, ScoringInputs, ScoringResult, ScoringContribution,
  ScoringVersion, ScoringWeights,
} from './types.js';

export type { ScoringVersion, ScoringWeights, ScoringInputs, ScoringResult, ScoringContribution };

export const STORM_NICHES: ReadonlySet<Niche> = new Set(['Roofer', 'Water/Mold']);
export const EMERGENCY_NICHES: ReadonlySet<Niche> = new Set([
  'Septic', 'Water/Mold', 'HVAC', 'Plumber', 'Towing',
]);

export const DEFAULT_WEIGHTS_V1: ScoringWeights = {
  webPresence: { none: 35, social_only: 28, gbp_only: 22, basic: 8, modern: 0, unknown: 5 },
  nicheFit: {
    Septic: 10, 'Water/Mold': 10, HVAC: 9, Plumber: 9,
    Roofer: 8, Electrician: 6, Towing: 7, 'Real Estate': 4,
  },
  phonePresent: 8,
  phoneLineLandlineOrVoip: 4,
  licenseActive: 10,
  licenseExpired: -25,
  stormBumpForStormNiches: 15,
  reviewVelocityLow: 8,
  reviewVelocityHigh: -4,
  hasOnlineBookingPenalty: -10,
  competitorDensityHigh: 5,
  ownerOperator: 6,
  serviceDispatchModel: 5,
  emergencyNiche: 6,
  multiLocationPenalty: -8,
  franchisePenalty: -50,
  residentialPenalty: -40,
  deadDomainPenalty: -10,
};

export const SCORING_VERSION_V1: ScoringVersion = {
  id: 1,
  weights: DEFAULT_WEIGHTS_V1,
  notes: 'Initial v1 weights (v3 Appendix B + v3.2 additions)',
};

export const QUALIFIED_THRESHOLD = 60;
export const PRIORITY_THRESHOLD = 80;
export const TOP_THRESHOLD = 95;

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function scoreLead(inputs: ScoringInputs, version: ScoringVersion = SCORING_VERSION_V1): ScoringResult {
  const contributions: ScoringContribution[] = [];
  let score = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  const W = version.weights;

  /* ─── Hard filters: short-circuit to 0 ─── */
  if (inputs.isFranchise) {
    return disqualified('is_franchise', 'Franchise / chain operator — wrong ICP', version.id);
  }
  if (inputs.isResidentialAddress) {
    return disqualified('residential_address', 'Address looks residential — likely not a real business', version.id);
  }
  if (!inputs.hasPhone) {
    return disqualified('no_phone', 'No phone in listing — cannot upsell AI receptionist', version.id);
  }

  /* ─── Positive / negative signals ─── */
  const wp = W.webPresence[inputs.webPresenceLevel] ?? 0;
  contributions.push({
    signal: 'web_presence_level',
    value: inputs.webPresenceLevel, points: wp,
    confidence: inputs.webPresenceLevel === 'unknown' ? 0.4 : 0.85,
  });
  score += wp;
  confidenceSum += contributions.at(-1)!.confidence; confidenceCount++;

  if (inputs.hasPhone) {
    contributions.push({ signal: 'has_phone', value: true, points: W.phonePresent, confidence: 0.95 });
    score += W.phonePresent;
    if (inputs.phoneLineType === 'landline' || inputs.phoneLineType === 'voip') {
      contributions.push({
        signal: 'phone_line_type', value: inputs.phoneLineType,
        points: W.phoneLineLandlineOrVoip, confidence: 0.7,
      });
      score += W.phoneLineLandlineOrVoip;
    }
    confidenceSum += 0.95; confidenceCount++;
  }

  if (inputs.licenseStatus === 'active') {
    contributions.push({ signal: 'license_status', value: 'active', points: W.licenseActive, confidence: 0.9 });
    score += W.licenseActive;
    confidenceSum += 0.9; confidenceCount++;
  } else if (inputs.licenseStatus === 'expired' || inputs.licenseStatus === 'suspended') {
    contributions.push({
      signal: 'license_status', value: inputs.licenseStatus,
      points: W.licenseExpired, confidence: 0.85,
    });
    score += W.licenseExpired;
    confidenceSum += 0.85; confidenceCount++;
  }

  if (inputs.isStormZone && STORM_NICHES.has(inputs.niche)) {
    contributions.push({
      signal: 'storm_zone_bump', value: true,
      points: W.stormBumpForStormNiches, confidence: 0.6,
    });
    score += W.stormBumpForStormNiches;
  }

  if (inputs.reviewCount30d !== null) {
    if (inputs.reviewCount30d <= 1) {
      contributions.push({
        signal: 'review_velocity_low', value: inputs.reviewCount30d,
        points: W.reviewVelocityLow, confidence: 0.7,
      });
      score += W.reviewVelocityLow;
    } else if (inputs.reviewCount30d >= 8) {
      contributions.push({
        signal: 'review_velocity_high', value: inputs.reviewCount30d,
        points: W.reviewVelocityHigh, confidence: 0.5,
      });
      score += W.reviewVelocityHigh;
    }
  }

  if (inputs.hasOnlineBooking) {
    contributions.push({
      signal: 'has_online_booking', value: true,
      points: W.hasOnlineBookingPenalty, confidence: 0.8,
    });
    score += W.hasOnlineBookingPenalty;
  }

  if ((inputs.competitorDensity ?? 0) > 50) {
    contributions.push({
      signal: 'competitor_density_high', value: inputs.competitorDensity,
      points: W.competitorDensityHigh, confidence: 0.5,
    });
    score += W.competitorDensityHigh;
  }

  if (inputs.ownerOperator) {
    contributions.push({ signal: 'owner_operator_heuristic', value: true, points: W.ownerOperator, confidence: 0.6 });
    score += W.ownerOperator;
  }
  if (inputs.serviceDispatchModel) {
    contributions.push({ signal: 'service_dispatch_model', value: true, points: W.serviceDispatchModel, confidence: 0.7 });
    score += W.serviceDispatchModel;
  }
  if (inputs.emergencyNiche || EMERGENCY_NICHES.has(inputs.niche)) {
    contributions.push({
      signal: 'emergency_niche', value: true,
      points: W.emergencyNiche, confidence: 0.85,
    });
    score += W.emergencyNiche;
  }
  if (inputs.multiLocation) {
    contributions.push({ signal: 'multi_location', value: true, points: W.multiLocationPenalty, confidence: 0.6 });
    score += W.multiLocationPenalty;
  }
  if (inputs.deadDomain) {
    contributions.push({ signal: 'dead_domain', value: true, points: W.deadDomainPenalty, confidence: 0.8 });
    score += W.deadDomainPenalty;
  }

  const nicheFit = W.nicheFit[inputs.niche] ?? 0;
  contributions.push({ signal: 'niche_fit', value: inputs.niche, points: nicheFit, confidence: 0.9 });
  score += nicheFit;

  const finalScore = clamp(Math.round(score), 0, 100);
  const confidence = confidenceCount === 0 ? 0.5 : confidenceSum / confidenceCount;

  return {
    score: finalScore,
    contributions,
    disqualified: false,
    confidence: Math.round(confidence * 100) / 100,
    scoringVersion: version.id,
  };
}

function disqualified(reason: string, message: string, version: number): ScoringResult {
  return {
    score: 0,
    contributions: [{ signal: reason, value: true, points: 0, confidence: 1.0, evidence: { message } }],
    disqualified: true,
    disqualificationReason: message,
    confidence: 1.0,
    scoringVersion: version,
  };
}

/** Tier classification used by enrichment budget guards. */
export function tierFor(score: number): 'discard' | 'qualified' | 'priority' | 'top' {
  if (score < QUALIFIED_THRESHOLD) return 'discard';
  if (score < PRIORITY_THRESHOLD) return 'qualified';
  if (score < TOP_THRESHOLD) return 'priority';
  return 'top';
}

export function enrichmentBudgetFor(score: number) {
  return {
    shouldScrapeContact: score >= QUALIFIED_THRESHOLD,
    shouldUseHunterFallback: score >= TOP_THRESHOLD,                 // tightened to 95 per v3.1
    shouldUseBouncerForAmbiguous: score >= PRIORITY_THRESHOLD,        // 80
    shouldUsePlacesGapFill: false,                                    // disabled by default
  };
}

/**
 * Apply a weight delta plan to a scoring version. Each per-signal change is capped
 * at +/-30% per the validation plan rules.
 */
export function applyWeightDelta(version: ScoringVersion, deltas: Partial<Record<keyof ScoringWeights, number>>): ScoringVersion {
  const next: ScoringWeights = JSON.parse(JSON.stringify(version.weights));
  for (const [key, delta] of Object.entries(deltas) as [keyof ScoringWeights, number][]) {
    const current = next[key];
    if (typeof current !== 'number') continue;
    const cap = Math.abs(current) * 0.3;
    const capped = clamp(delta, -cap, cap);
    (next as unknown as Record<string, number>)[key] = current + capped;
  }
  return { id: version.id + 1, weights: next, notes: `Auto-derived from v${version.id} via observed lift` };
}
