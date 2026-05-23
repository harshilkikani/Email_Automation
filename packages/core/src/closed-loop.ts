/**
 * Closed-loop scoring core.
 *
 * Takes raw signal-outcome counts and proposes weight deltas. Pure: no DB,
 * no I/O. The server service in `apps/server/src/services/closed-loop.ts`
 * wires this up to email_events + inbound_messages.
 *
 * The "loop" goes:
 *
 *   email_events / inbound / suppressions
 *      ↓ aggregate per (signalKey, signalValue) over rolling window
 *   signalOutcomes rows
 *      ↓ compute lift (P(reply|signal=v) / P(reply|otherwise))
 *   LiftRow per (signalKey, signalValue)
 *      ↓ propose delta (only if N ≥ minObservations AND |lift - 1| ≥ threshold)
 *   ScoringProposal
 *      ↓ operator review → apply
 *   new ScoringVersion
 *      ↓ scoreLead uses the new weights on next discovery / refresh
 */
import { applyWeightDelta, type ScoringVersion, type ScoringWeights } from './scoring.js';
import type { Niche, WebPresenceLevel } from './types.js';

/** A row of pre-aggregated outcome counts. */
export interface SignalOutcomeAggregate {
  signalKey: string;
  signalValue: string;
  nObservations: number;     // total leads that had this (key,value)
  nSent: number;
  nReplied: number;
  nQualified: number;
  nBounced: number;
  nComplained: number;
  nUnsubscribed: number;
}

/** What we'll surface to operators when explaining a proposal. */
export interface ProposalEvidence {
  signalKey: string;
  signalValue: string;
  weightKey: keyof ScoringWeights;
  deltaPoints: number;
  liftReply: number | null;
  liftQualified: number | null;
  nObservations: number;
  nReplied: number;
  qualifiedRate: number;
}

export interface ProposalOptions {
  /** Minimum total observations per (signal, value) before considering it. */
  minObservations: number;
  /** |lift - 1| threshold below which the signal is "noise". */
  minLiftMagnitude: number;
  /** Hard cap on per-signal delta as fraction of current weight. Default 0.3 = ±30%. */
  perSignalCapFraction: number;
}

export const DEFAULT_PROPOSAL_OPTIONS: ProposalOptions = {
  minObservations: 30,
  minLiftMagnitude: 0.5,        // i.e. lift <= 0.5 or >= 1.5
  perSignalCapFraction: 0.3,
};

/**
 * Maps a (signalKey, signalValue) pair to the corresponding ScoringWeights
 * key. The closed loop only proposes changes for keys that map to a single
 * numeric weight (scalar weights). Composite ones (webPresence, nicheFit) are
 * mapped per-bucket so we can tune each bucket independently.
 */
export function weightKeyFor(signalKey: string, signalValue: string): keyof ScoringWeights | null {
  switch (signalKey) {
    case 'web_presence_level': {
      const bucket = signalValue as WebPresenceLevel;
      /* Web-presence weights are stored as an object — we treat the bucket as
         a composite key the proposer can still adjust by emitting a delta plan
         that targets a sub-key. To stay schema-compatible with applyWeightDelta
         (which only accepts top-level keys), we synthesize an injection through
         applyCompositeDelta below. */
      return ('webPresence' + capitalize(bucket)) as keyof ScoringWeights;
    }
    case 'has_phone':                return 'phonePresent';
    case 'phone_line_type':          return 'phoneLineLandlineOrVoip';
    case 'license_status': {
      if (signalValue === 'active')                       return 'licenseActive';
      if (signalValue === 'expired' || signalValue === 'suspended') return 'licenseExpired';
      return null;
    }
    case 'is_storm_zone':            return 'stormBumpForStormNiches';
    case 'review_velocity_low':      return 'reviewVelocityLow';
    case 'review_velocity_high':     return 'reviewVelocityHigh';
    case 'has_online_booking':       return 'hasOnlineBookingPenalty';
    case 'competitor_density_high':  return 'competitorDensityHigh';
    case 'owner_operator_heuristic': return 'ownerOperator';
    case 'service_dispatch_model':   return 'serviceDispatchModel';
    case 'emergency_niche':          return 'emergencyNiche';
    case 'multi_location':           return 'multiLocationPenalty';
    case 'dead_domain':              return 'deadDomainPenalty';
    case 'niche_fit': {
      /* Synthetic sub-key; handled by applyCompositeDelta. */
      return ('nicheFit' + capitalize(signalValue)) as keyof ScoringWeights;
    }
    default:
      return null;
  }
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Compute lift for one signal-outcome row. Returns null when we can't compute one. */
export function liftFor(
  positive: SignalOutcomeAggregate,
  negative: SignalOutcomeAggregate,
): { liftReply: number | null; liftQualified: number | null } {
  const posReply = positive.nSent > 0 ? positive.nReplied / positive.nSent : 0;
  const negReply = negative.nSent > 0 ? negative.nReplied / negative.nSent : 0;
  const posQual  = positive.nSent > 0 ? positive.nQualified / positive.nSent : 0;
  const negQual  = negative.nSent > 0 ? negative.nQualified / negative.nSent : 0;
  const liftReply     = negReply > 0 ? posReply / negReply : (posReply > 0 ? null : null);
  const liftQualified = negQual  > 0 ? posQual  / negQual  : (posQual  > 0 ? null : null);
  return { liftReply, liftQualified };
}

/**
 * Given per-(signal, value) aggregates, propose weight deltas. The shape of
 * each delta is a *signed integer*: positive when the signal correlates with
 * higher reply rate (we should boost the weight), negative when it correlates
 * with lower reply (we should reduce or invert it).
 *
 * Magnitude is `current_weight * multiplier`, where multiplier scales with
 * |lift - 1| and is capped at perSignalCapFraction. Signals where the
 * "positive" cohort has fewer than `minObservations` are skipped.
 */
export interface Proposal {
  baseVersionId: number;
  deltas: Partial<Record<string, number>>;     // weightKey -> deltaPoints
  evidence: ProposalEvidence[];
  /** When non-empty, the nextVersion that would result if applied. */
  nextVersion: ScoringVersion | null;
}

export function proposeWeightChanges(
  aggregates: SignalOutcomeAggregate[],
  baseVersion: ScoringVersion,
  options: Partial<ProposalOptions> = {},
): Proposal {
  const opts = { ...DEFAULT_PROPOSAL_OPTIONS, ...options };
  /* Group by signalKey so we can compute "everything else" as the negative cohort. */
  const byKey = new Map<string, SignalOutcomeAggregate[]>();
  for (const a of aggregates) {
    if (!byKey.has(a.signalKey)) byKey.set(a.signalKey, []);
    byKey.get(a.signalKey)!.push(a);
  }
  const deltas: Partial<Record<string, number>> = {};
  const evidence: ProposalEvidence[] = [];

  for (const [key, rows] of byKey) {
    /* Compute the per-value summary, with negative cohort = sum of *other* values. */
    for (const positive of rows) {
      if (positive.nObservations < opts.minObservations) continue;
      const others = rows.filter(r => r !== positive);
      const negative: SignalOutcomeAggregate = sumOf(others);
      if (negative.nSent < opts.minObservations) continue;

      const { liftReply, liftQualified } = liftFor(positive, negative);
      if (liftReply === null) continue;
      const magnitude = Math.abs(liftReply - 1);
      if (magnitude < opts.minLiftMagnitude) continue;

      const weightKey = weightKeyFor(key, positive.signalValue);
      if (!weightKey) continue;
      const current = readWeight(baseVersion.weights, weightKey);
      if (current === null) continue;

      /* Multiplier scales with lift magnitude, capped at `perSignalCapFraction`. */
      const sign = liftReply > 1 ? 1 : -1;
      const scaled = Math.min(magnitude / 2, opts.perSignalCapFraction);
      const delta = Math.round(current * sign * scaled);
      if (delta === 0) continue;

      /* Aggregate by weightKey since two rows could map to the same key (rare). */
      const prior = deltas[weightKey as string] ?? 0;
      deltas[weightKey as string] = clampToFraction(current, prior + delta, opts.perSignalCapFraction);
      evidence.push({
        signalKey: key,
        signalValue: positive.signalValue,
        weightKey,
        deltaPoints: delta,
        liftReply,
        liftQualified,
        nObservations: positive.nObservations,
        nReplied: positive.nReplied,
        qualifiedRate: positive.nSent > 0 ? positive.nQualified / positive.nSent : 0,
      });
    }
  }

  /* If any deltas hit a *composite* weight key (webPresenceX / nicheFitY) we
     need a custom merger, since applyWeightDelta only knows top-level keys.
     We split into top-level vs composite below. */
  const topLevel: Partial<Record<keyof ScoringWeights, number>> = {};
  const composite: Array<{ parent: 'webPresence' | 'nicheFit'; bucket: string; delta: number }> = [];
  for (const [k, v] of Object.entries(deltas)) {
    if (typeof v !== 'number') continue;
    if (k.startsWith('webPresence') && k !== 'webPresence') {
      composite.push({ parent: 'webPresence', bucket: lowerFirst(k.slice('webPresence'.length)), delta: v });
    } else if (k.startsWith('nicheFit') && k !== 'nicheFit') {
      composite.push({ parent: 'nicheFit', bucket: capitalize(k.slice('nicheFit'.length)), delta: v });
    } else {
      topLevel[k as keyof ScoringWeights] = v;
    }
  }
  const nextVersion = Object.keys(topLevel).length === 0 && composite.length === 0
    ? null
    : applyCompositeDelta(applyWeightDelta(baseVersion, topLevel), composite);

  return {
    baseVersionId: baseVersion.id,
    deltas,
    evidence,
    nextVersion,
  };
}

function applyCompositeDelta(
  version: ScoringVersion,
  composites: Array<{ parent: 'webPresence' | 'nicheFit'; bucket: string; delta: number }>,
): ScoringVersion {
  if (composites.length === 0) return version;
  const next: ScoringWeights = JSON.parse(JSON.stringify(version.weights));
  for (const c of composites) {
    if (c.parent === 'webPresence') {
      const bucket = c.bucket as WebPresenceLevel;
      const cur = next.webPresence[bucket] ?? 0;
      const cap = Math.abs(cur || 1) * 0.3;
      const capped = clamp(c.delta, -cap, cap);
      next.webPresence[bucket] = cur + capped;
    } else if (c.parent === 'nicheFit') {
      const bucket = c.bucket as Niche;
      const cur = next.nicheFit[bucket] ?? 0;
      const cap = Math.abs(cur || 1) * 0.3;
      const capped = clamp(c.delta, -cap, cap);
      next.nicheFit[bucket] = cur + capped;
    }
  }
  return { id: version.id, weights: next, notes: version.notes };
}

function readWeight(weights: ScoringWeights, key: keyof ScoringWeights): number | null {
  if (key in weights) {
    const v = (weights as unknown as Record<string, unknown>)[key as string];
    if (typeof v === 'number') return v;
  }
  /* Composite keys: webPresenceX / nicheFitY → read the inner map value. */
  const k = String(key);
  if (k.startsWith('webPresence')) {
    const bucket = lowerFirst(k.slice('webPresence'.length)) as WebPresenceLevel;
    const v = weights.webPresence[bucket];
    return typeof v === 'number' ? v : null;
  }
  if (k.startsWith('nicheFit')) {
    const bucket = capitalize(k.slice('nicheFit'.length)) as Niche;
    const v = weights.nicheFit[bucket];
    return typeof v === 'number' ? v : null;
  }
  return null;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function clampToFraction(current: number, candidate: number, fraction: number): number {
  const cap = Math.abs(current || 1) * fraction;
  return clamp(candidate, -cap, cap);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sumOf(rows: SignalOutcomeAggregate[]): SignalOutcomeAggregate {
  const seed: SignalOutcomeAggregate = {
    signalKey: rows[0]?.signalKey ?? '',
    signalValue: '__other__',
    nObservations: 0, nSent: 0, nReplied: 0, nQualified: 0,
    nBounced: 0, nComplained: 0, nUnsubscribed: 0,
  };
  for (const r of rows) {
    seed.nObservations += r.nObservations;
    seed.nSent += r.nSent;
    seed.nReplied += r.nReplied;
    seed.nQualified += r.nQualified;
    seed.nBounced += r.nBounced;
    seed.nComplained += r.nComplained;
    seed.nUnsubscribed += r.nUnsubscribed;
  }
  return seed;
}

/**
 * Extract the canonical (signalKey, signalValue) pairs for a given lead +
 * signals row. The server aggregator calls this once per recipient. Mirrors
 * the structure of scoring.ts so what we tune ↔ what scoring reads.
 */
export interface LeadSignalSnapshot {
  niche: Niche;
  webPresenceLevel: WebPresenceLevel;
  hasPhone: boolean;
  phoneLineType?: string | null;
  hasOnlineBooking: boolean;
  isStormZone: boolean;
  licenseStatus?: string | null;
  reviewCount30d?: number | null;
  competitorDensity?: number | null;
  ownerOperator?: boolean;
  serviceDispatchModel?: boolean;
  emergencyNiche?: boolean;
  multiLocation?: boolean;
  deadDomain?: boolean;
}

export function snapshotSignals(s: LeadSignalSnapshot): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  out.push({ key: 'niche_fit', value: s.niche });
  out.push({ key: 'web_presence_level', value: s.webPresenceLevel });
  out.push({ key: 'has_phone', value: String(s.hasPhone) });
  if (s.phoneLineType) out.push({ key: 'phone_line_type', value: s.phoneLineType });
  out.push({ key: 'has_online_booking', value: String(s.hasOnlineBooking) });
  out.push({ key: 'is_storm_zone', value: String(s.isStormZone) });
  if (s.licenseStatus) out.push({ key: 'license_status', value: s.licenseStatus });
  if (s.reviewCount30d != null) {
    out.push({ key: 'review_velocity', value: s.reviewCount30d <= 1 ? 'low' : s.reviewCount30d >= 8 ? 'high' : 'mid' });
  }
  if (s.competitorDensity != null && s.competitorDensity > 50) {
    out.push({ key: 'competitor_density_high', value: 'true' });
  }
  if (s.ownerOperator)        out.push({ key: 'owner_operator_heuristic', value: 'true' });
  if (s.serviceDispatchModel) out.push({ key: 'service_dispatch_model', value: 'true' });
  if (s.emergencyNiche)       out.push({ key: 'emergency_niche', value: 'true' });
  if (s.multiLocation)        out.push({ key: 'multi_location', value: 'true' });
  if (s.deadDomain)           out.push({ key: 'dead_domain', value: 'true' });
  return out;
}
