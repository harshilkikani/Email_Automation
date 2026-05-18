/**
 * Validation Mode math.
 *
 *  - Stratified sampling per VALIDATION-PLAN.md (Top 80–100, Mid 60–79,
 *    Bottom 40–59, Control 20–39).
 *  - Signal-outcome lift computation (P(reply|signal=true) / P(reply|signal=false)).
 *  - Kill-criterion checks per phase.
 *
 * Random sampling uses a seeded PRNG so re-running a stratification produces
 * the same buckets — important for reproducibility during validation review.
 */

import type { ReplyIntent } from './types.js';
import { applyWeightDelta, type ScoringVersion, type ScoringWeights } from './scoring.js';

export type Bucket = 'top' | 'mid' | 'bottom' | 'control' | 'seedlist';

export const REACH_SAMPLE = { top: 40, mid: 30, bottom: 20, control: 10 } as const;
export const ENGAGEMENT_SAMPLE = { top: 200, mid: 150, bottom: 100, control: 50 } as const;

export interface BucketableLead {
  id: string;
  score: number;
}

export function bucketFor(score: number): Bucket | null {
  if (score >= 80 && score <= 100) return 'top';
  if (score >= 60 && score <= 79) return 'mid';
  if (score >= 40 && score <= 59) return 'bottom';
  if (score >= 20 && score <= 39) return 'control';
  return null;
}

/** Mulberry32 — fast deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stratified sample with a deterministic seed (so reviewers can re-create). */
export function stratifiedSample(
  leads: BucketableLead[],
  spec: Record<'top' | 'mid' | 'bottom' | 'control', number>,
  seed = 17,
): Record<'top' | 'mid' | 'bottom' | 'control', BucketableLead[]> {
  const buckets: Record<'top' | 'mid' | 'bottom' | 'control', BucketableLead[]> = {
    top: [], mid: [], bottom: [], control: [],
  };
  for (const l of leads) {
    const b = bucketFor(l.score);
    if (b && b !== 'seedlist') buckets[b].push(l);
  }
  const rand = mulberry32(seed);
  const shuffle = <T,>(a: T[]): T[] => {
    const arr = a.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  };
  return {
    top: shuffle(buckets.top).slice(0, spec.top),
    mid: shuffle(buckets.mid).slice(0, spec.mid),
    bottom: shuffle(buckets.bottom).slice(0, spec.bottom),
    control: shuffle(buckets.control).slice(0, spec.control),
  };
}

/* ─── Eyeball review verdict ─── */
export type Rating = 'A' | 'B' | 'C' | 'D';
export type EyeballVerdict = 'pass' | 'tune' | 'stop';

export function eyeballVerdict(ratings: Rating[]): { verdict: EyeballVerdict; aPlusBPct: number } {
  if (ratings.length === 0) return { verdict: 'tune', aPlusBPct: 0 };
  const ab = ratings.filter(r => r === 'A' || r === 'B').length;
  const pct = ab / ratings.length;
  if (pct >= 0.7) return { verdict: 'pass', aPlusBPct: pct };
  if (pct >= 0.5) return { verdict: 'tune', aPlusBPct: pct };
  return { verdict: 'stop', aPlusBPct: pct };
}

/* ─── Reach / engagement kill criteria ─── */
export interface PhaseStats {
  sent: number;
  delivered: number;
  bounced: number;
  complaints: number;
  inboxPlacement: number;        // 0–1 from seedlist observations
  replies: number;
  byBucket?: {
    top: { sent: number; replied: number; qualified: number };
    mid: { sent: number; replied: number; qualified: number };
    bottom: { sent: number; replied: number; qualified: number };
    control: { sent: number; replied: number; qualified: number };
  };
}

export type ReachVerdict = 'continue' | 'fix_dns' | 'fix_verification' | 'audit_copy' | 'paused';

export function reachVerdict(s: PhaseStats): { verdict: ReachVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const bounceRate = s.sent > 0 ? s.bounced / s.sent : 0;

  if (s.inboxPlacement < 0.7) {
    reasons.push(`Inbox placement ${(s.inboxPlacement * 100).toFixed(0)}% < 70%`);
    return { verdict: 'fix_dns', reasons };
  }
  if (bounceRate > 0.08) {
    reasons.push(`Bounce rate ${(bounceRate * 100).toFixed(1)}% > 8%`);
    return { verdict: 'fix_verification', reasons };
  }
  if (s.sent >= 50 && s.replies === 0) {
    reasons.push('0 replies after 50 sends');
    return { verdict: 'audit_copy', reasons };
  }
  return { verdict: 'continue', reasons };
}

export type EngagementVerdict = 'scale' | 'no_lift' | 'icp_broken' | 'junk_replies' | 'paused';

export function engagementVerdict(s: PhaseStats): { verdict: EngagementVerdict; topReply: number; gap: number; qualifiedPct: number } {
  const b = s.byBucket;
  if (!b) return { verdict: 'no_lift', topReply: 0, gap: 0, qualifiedPct: 0 };
  const topReply = b.top.sent > 0 ? b.top.replied / b.top.sent : 0;
  const midReply = b.mid.sent > 0 ? b.mid.replied / b.mid.sent : 0;
  const gap = topReply - midReply;
  const totalReplied = b.top.replied + b.mid.replied + b.bottom.replied + b.control.replied;
  const totalQualified = b.top.qualified + b.mid.qualified + b.bottom.qualified + b.control.qualified;
  const qualifiedPct = totalReplied > 0 ? totalQualified / totalReplied : 0;
  const bounceRate = s.sent > 0 ? s.bounced / s.sent : 0;
  if (bounceRate > 0.05) return { verdict: 'paused', topReply, gap, qualifiedPct };
  if (topReply >= 0.05 && gap >= 0.03 && qualifiedPct >= 0.3) {
    return { verdict: 'scale', topReply, gap, qualifiedPct };
  }
  if (topReply >= 0.05 && gap < 0.03) return { verdict: 'no_lift', topReply, gap, qualifiedPct };
  if (topReply < 0.03) return { verdict: 'icp_broken', topReply, gap, qualifiedPct };
  if (qualifiedPct < 0.2) return { verdict: 'junk_replies', topReply, gap, qualifiedPct };
  return { verdict: 'no_lift', topReply, gap, qualifiedPct };
}

/* ─── Signal-outcome lift ─── */
export interface SignalOutcomeRow {
  leadId: string;
  signals: Record<string, boolean | number | null>;
  replied: boolean;
  intent?: ReplyIntent;
  bucket: Bucket;
}

export interface LiftRow {
  signal: string;
  pReplyTrue: number;
  pReplyFalse: number;
  liftReply: number;
  pQualifiedTrue: number;
  pQualifiedFalse: number;
  liftQualified: number;
  nTrue: number;
  nFalse: number;
}

const QUALIFIED_INTENTS: ReplyIntent[] = ['interested', 'conditional', 'referral'];

export function computeLift(rows: SignalOutcomeRow[], signalKeys: string[]): LiftRow[] {
  return signalKeys.map(key => {
    let nT = 0, rT = 0, qT = 0, nF = 0, rF = 0, qF = 0;
    for (const r of rows) {
      const v = r.signals[key];
      const isTrue = typeof v === 'boolean' ? v : (typeof v === 'number' ? v > 0 : false);
      const qualified = r.replied && r.intent !== undefined && QUALIFIED_INTENTS.includes(r.intent);
      if (isTrue) {
        nT++; if (r.replied) rT++; if (qualified) qT++;
      } else {
        nF++; if (r.replied) rF++; if (qualified) qF++;
      }
    }
    const pReplyTrue  = nT > 0 ? rT / nT : 0;
    const pReplyFalse = nF > 0 ? rF / nF : 0;
    const pQualifiedTrue  = nT > 0 ? qT / nT : 0;
    const pQualifiedFalse = nF > 0 ? qF / nF : 0;
    const liftReply     = pReplyFalse > 0 ? pReplyTrue / pReplyFalse : (pReplyTrue > 0 ? Infinity : 0);
    const liftQualified = pQualifiedFalse > 0 ? pQualifiedTrue / pQualifiedFalse : (pQualifiedTrue > 0 ? Infinity : 0);
    return {
      signal: key, pReplyTrue, pReplyFalse, liftReply,
      pQualifiedTrue, pQualifiedFalse, liftQualified, nTrue: nT, nFalse: nF,
    };
  });
}

/**
 * From observed lift, propose a delta plan capped at ±30% per signal.
 * Mapping: signal key → weight key in ScoringWeights. Unmapped signals are ignored.
 */
export function deriveWeightPlan(
  lift: LiftRow[],
  signalToWeight: Partial<Record<string, keyof ScoringWeights>>,
  version: ScoringVersion,
): { plan: Partial<Record<keyof ScoringWeights, number>>; nextVersion: ScoringVersion } {
  const plan: Partial<Record<keyof ScoringWeights, number>> = {};
  for (const row of lift) {
    const wkey = signalToWeight[row.signal];
    if (!wkey) continue;
    const cur = version.weights[wkey];
    if (typeof cur !== 'number') continue;
    let multiplier = 0;
    if (row.liftReply >= 2)  multiplier = 0.15;            // strong positive
    else if (row.liftReply >= 1.2) multiplier = 0.07;       // mild positive
    else if (row.liftReply < 1 && row.liftReply > 0) multiplier = -0.2;  // negative
    else multiplier = -0.07;
    const delta = Math.round(cur * multiplier);
    if (delta !== 0) plan[wkey] = delta;
  }
  const nextVersion = applyWeightDelta(version, plan);
  return { plan, nextVersion };
}
