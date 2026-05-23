/**
 * Per-mailbox warmup curve math + domain reputation blending.
 *
 * Pure. The server service in apps/server/src/services/warmup-engine.ts
 * applies these to real sender_mailboxes and sender_reputation_daily rows.
 */

export interface WarmupPlan {
  /** Ordered daily caps; index = warmupDay (0-based). Final value = steady state. */
  dailyCaps: number[];
  pauseBouncePct: number;
  pauseComplaintPct: number;
  minReputationToAdvance: number;
}

/** A conservative default ramp: 28 days from 20/day to 1400/day. */
export const DEFAULT_CONSERVATIVE_PLAN: WarmupPlan = {
  dailyCaps: [
    20, 30, 50, 75, 100, 125, 150, 180, 210, 240,
    275, 310, 350, 400, 450, 500, 560, 620, 680, 750,
    820, 900, 975, 1050, 1125, 1200, 1300, 1400,
  ],
  pauseBouncePct: 4,
  pauseComplaintPct: 0.1,
  minReputationToAdvance: 40,
};

export function dailyCapFor(plan: WarmupPlan, warmupDay: number): number {
  const idx = Math.max(0, Math.min(plan.dailyCaps.length - 1, warmupDay));
  return plan.dailyCaps[idx] ?? 0;
}

/** Whether the mailbox is at steady state (final ramp step). */
export function isWarmed(plan: WarmupPlan, warmupDay: number): boolean {
  return warmupDay >= plan.dailyCaps.length - 1;
}

/**
 * Daily reputation snapshot used to score a single day. Plug a window of these
 * into `domainReputationScore` to get the live mailbox/domain reputation.
 */
export interface DailySnapshot {
  date: string;            // YYYY-MM-DD
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  seedlistInbox: number;   // count of seedlist sends landing in primary/promotions
  seedlistSpam: number;
}

export interface ReputationContext {
  /** Mailbox/domain age in days. Older = more trust headroom. */
  ageDays: number;
  /** Recent window snapshots — typically the last 7 days. */
  recent: DailySnapshot[];
}

/**
 * Blend recent activity into a 0–100 reputation score. Component weights:
 *   - bounceRate:      40 pts (penalty)
 *   - complaintRate:   30 pts (penalty)
 *   - seedlistSpamRate:15 pts (penalty)
 *   - age:             15 pts (bonus, ramps to full at 60 days)
 *
 * A mailbox with zero sends in the window inherits a neutral 50 (we don't
 * punish or reward lack of data — the warmup engine handles that separately).
 */
export function domainReputationScore(ctx: ReputationContext): number {
  const recent = ctx.recent;
  const totals = recent.reduce((acc, r) => ({
    sent: acc.sent + r.sent,
    delivered: acc.delivered + r.delivered,
    bounced: acc.bounced + r.bounced,
    complained: acc.complained + r.complained,
    unsubscribed: acc.unsubscribed + r.unsubscribed,
    seedlistInbox: acc.seedlistInbox + r.seedlistInbox,
    seedlistSpam: acc.seedlistSpam + r.seedlistSpam,
  }), { sent: 0, delivered: 0, bounced: 0, complained: 0, unsubscribed: 0, seedlistInbox: 0, seedlistSpam: 0 });
  if (totals.sent === 0) return 50;

  const bouncePct = (totals.bounced / totals.sent) * 100;
  const complaintPct = (totals.complained / totals.sent) * 100;
  const seedlistTotal = totals.seedlistInbox + totals.seedlistSpam;
  const seedlistSpamPct = seedlistTotal > 0 ? (totals.seedlistSpam / seedlistTotal) * 100 : 0;

  /* Penalties: scale linearly from ok→bad. */
  const bouncePenalty    = Math.min(40, bouncePct * 10);          // 4% bounce = 40 pt penalty
  const complaintPenalty = Math.min(30, complaintPct * 300);      // 0.1% complaint = 30 pt penalty
  const spamPenalty      = Math.min(15, seedlistSpamPct * 1.5);   // 10% spam-folder = 15 pt penalty

  /* Age bonus: ramps to 15 at 60 days. */
  const ageBonus = Math.min(15, (ctx.ageDays / 60) * 15);

  const score = 100 - bouncePenalty - complaintPenalty - spamPenalty - ageBonus * 0 + ageBonus;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Decide whether a mailbox should advance to the next warmup day, hold, or
 * pause. Returns the recommended action; callers persist it.
 */
export type WarmupAction =
  | { action: 'advance'; nextDay: number; newCap: number }
  | { action: 'hold'; reason: string }
  | { action: 'pause'; reason: string };

export function decideWarmupAction(
  plan: WarmupPlan,
  currentDay: number,
  reputation: number,
  recent24h: { sent: number; bounced: number; complained: number },
): WarmupAction {
  /* Hard pause on a single-day breach of the bounce/complaint thresholds. */
  if (recent24h.sent >= 25) {
    const bouncePct = (recent24h.bounced / recent24h.sent) * 100;
    const complaintPct = (recent24h.complained / recent24h.sent) * 100;
    if (bouncePct > plan.pauseBouncePct) {
      return { action: 'pause', reason: `bounce_rate_24h_${bouncePct.toFixed(1)}%>${plan.pauseBouncePct}%` };
    }
    if (complaintPct > plan.pauseComplaintPct) {
      return { action: 'pause', reason: `complaint_rate_24h_${complaintPct.toFixed(2)}%>${plan.pauseComplaintPct}%` };
    }
  }
  if (reputation < plan.minReputationToAdvance) {
    return { action: 'hold', reason: `reputation_${reputation}<${plan.minReputationToAdvance}` };
  }
  if (isWarmed(plan, currentDay)) {
    return { action: 'hold', reason: 'already_warmed' };
  }
  const nextDay = currentDay + 1;
  return { action: 'advance', nextDay, newCap: dailyCapFor(plan, nextDay) };
}

/** Hourly token-bucket: how many sends remain per the daily cap, smoothed across 16 active hours. */
export function hourlyTokensFor(dailyCap: number): number {
  /* Default: 16 active hours/day → cap / 16, rounded up. */
  return Math.max(1, Math.ceil(dailyCap / 16));
}
