/**
 * Seedlist placement tracking.
 *
 * Each seedlist test send writes one `seedlist_tests` row per mailbox. The
 * operator later marks each row with what they observed in the actual inbox:
 *   primary | promotions | spam | missing
 *
 * The launch gate (seedlist_test_recent) is upgraded to require not only a
 * recent send but a recent **passing** placement (≥ 80% of observed rows in
 * the last N days were `primary`). If observations are still pending, the
 * gate stays in `warn` rather than blocking, because the operator may not
 * have logged placement yet.
 */
import { and, eq, gte } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';

export interface PlacementSummary {
  total: number;
  observed: number;
  primary: number;
  promotions: number;
  spam: number;
  missing: number;
  primaryPct: number;        // 0..1 over observed rows
  recommendation: 'pass' | 'warm-longer' | 'fix-dns' | 'reduce-cap' | 'pause' | 'needs-observation';
}

export async function summarisePlacement(db: Database, senderDomainId: string, windowDays: number): Promise<PlacementSummary> {
  const since = new Date(Date.now() - windowDays * 86400_000);
  const rows = await db.select().from(schema.seedlistTests)
    .where(and(eq(schema.seedlistTests.senderDomainId, senderDomainId), gte(schema.seedlistTests.sentAt, since)));
  const total = rows.length;
  let observed = 0, primary = 0, promotions = 0, spam = 0, missing = 0;
  for (const r of rows) {
    if (!r.observed) continue;
    observed++;
    if (r.observed === 'primary') primary++;
    else if (r.observed === 'promotions') promotions++;
    else if (r.observed === 'spam') spam++;
    else if (r.observed === 'missing') missing++;
  }
  const primaryPct = observed > 0 ? primary / observed : 0;

  let recommendation: PlacementSummary['recommendation'] = 'needs-observation';
  if (observed === 0)             recommendation = 'needs-observation';
  else if (spam / observed >= 0.4) recommendation = 'fix-dns';
  else if (missing / observed >= 0.4) recommendation = 'fix-dns';
  else if (primaryPct >= 0.8)      recommendation = 'pass';
  else if (primaryPct >= 0.5)      recommendation = 'warm-longer';
  else                              recommendation = 'pause';

  return { total, observed, primary, promotions, spam, missing, primaryPct, recommendation };
}

export interface WarmupGuidance {
  day: number;
  cap: number;
  note: string;
}

/** Conservative 30-day warmup ramp. The operator can raise it manually once
 *  placement is reliably >= 80% primary. */
export const WARMUP_RAMP: WarmupGuidance[] = [
  { day: 1, cap: 10, note: 'Seed-only. Send to your own controlled mailboxes.' },
  { day: 3, cap: 20, note: 'Seed + 1 friendly target.' },
  { day: 7, cap: 25, note: 'Begin reach test (100 / 7 days = 14/day). Monitor placement daily.' },
  { day: 14, cap: 50, note: 'If placement >= 80% primary, raise to 50.' },
  { day: 21, cap: 75, note: 'If complaint < 0.1% and bounce < 3%.' },
  { day: 30, cap: 100, note: 'Stable warmup complete. Engagement test (500 / 14 days = 35/day).' },
];

export function currentWarmupTarget(warmupDay: number): WarmupGuidance {
  let last = WARMUP_RAMP[0]!;
  for (const r of WARMUP_RAMP) {
    if (warmupDay >= r.day) last = r;
  }
  return last;
}
