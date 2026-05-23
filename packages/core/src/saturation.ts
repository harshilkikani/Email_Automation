/**
 * Market saturation math. Pure — server services pass in raw counts and dates.
 *
 *   saturation_pct = sentLeads_decayed / eligibleLeads * 100
 *
 *   sentLeads_decayed = Σ ( e^(-Δt_days / τ) ) over each prior send
 *
 * where τ (decayTauDays) controls how quickly an old send "ages out". Default
 * τ = 14 means a send from 14 days ago counts as 1/e ≈ 0.37 of a fresh send.
 *
 * Two caps:
 *   - hardCapPct: block all further sends in the geo until decay drops below.
 *   - softCapPct: deboost the score by a fraction (smoothly ramping from 0 at
 *     softCapPct to 0.5 at hardCapPct).
 */

export interface SaturationConfig {
  rollingDays: number;
  hardCapPct: number;
  softCapPct: number;
  decayTauDays: number;
}

export const DEFAULT_SATURATION_CONFIG: SaturationConfig = {
  rollingDays: 30,
  hardCapPct: 60,
  softCapPct: 30,
  decayTauDays: 14,
};

/** Raw send event over the rolling window: (leadId, sentAt). */
export interface SaturationEvent {
  leadId: string;
  sentAt: Date;
}

/**
 * Compute the saturation percentage given the raw events + eligible-lead count
 * in the (niche, geo) cell.
 */
export function computeSaturationPct(
  events: SaturationEvent[],
  eligibleLeads: number,
  now: Date,
  tauDays: number,
): number {
  if (eligibleLeads <= 0) return 0;
  /* Decay each send and count distinct leads (so 3 follow-ups to the same lead
     don't compound). */
  const perLead = new Map<string, number>();
  for (const ev of events) {
    const dtDays = Math.max(0, (now.getTime() - ev.sentAt.getTime()) / 86400_000);
    const decayed = Math.exp(-dtDays / tauDays);
    const prior = perLead.get(ev.leadId) ?? 0;
    perLead.set(ev.leadId, Math.max(prior, decayed));   // take the freshest of any duplicates
  }
  let total = 0;
  for (const v of perLead.values()) total += v;
  return Math.min(100, (total / eligibleLeads) * 100);
}

/** Soft-deboost: 0 below softCap, ramps to 0.5 at hardCap. */
export function softDeboost(saturationPct: number, cfg: SaturationConfig): number {
  if (saturationPct <= cfg.softCapPct) return 0;
  if (saturationPct >= cfg.hardCapPct) return 0.5;
  const ratio = (saturationPct - cfg.softCapPct) / (cfg.hardCapPct - cfg.softCapPct);
  return Math.max(0, Math.min(0.5, ratio * 0.5));
}

/** Hard-block when saturation exceeds hardCapPct (or eligible=0 with sends). */
export function shouldBlock(saturationPct: number, cfg: SaturationConfig): boolean {
  return saturationPct >= cfg.hardCapPct;
}
