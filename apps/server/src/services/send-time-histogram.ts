/**
 * Layer 7 — Adaptive Send-Time Histogram, read side.
 *
 * The branch already populates `send_time_histograms` from a scheduler tick
 * (`tickSendTimeHistogram`, every 12 h) by aggregating reply outcomes from
 * `campaign_recipients` over the last 90 days. What the branch was missing
 * was the *consumer*: nothing in the send loop ever queried the table.
 *
 * This module provides that consumer. It returns, for a given
 * (orgId, niche), the UTC hour within the configured send window that has
 * the highest observed reply rate — given enough observations to be
 * statistically meaningful. The send loop uses this to push a recipient's
 * `nextSendAt` forward to that hour when it would otherwise fire too early.
 *
 * Conservative defaults:
 *   - `MIN_OBSERVATIONS_PER_HOUR` = 50. Below this, the hour is ignored —
 *     we'd rather send "whenever" than pick a hour with one lucky reply.
 *   - The returned hour must lie inside `[sendWindow.startHour, sendWindow.endHour)`.
 *     A high-reply hour outside the window can't be honoured anyway.
 *   - Returns `null` when there's no statistically meaningful signal so the
 *     caller falls back to "send now" — the cold-start case.
 */
import { and, eq, gte, lt } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';

export const MIN_OBSERVATIONS_PER_HOUR = 50;

export interface SendWindow {
  startHour: number;  // inclusive, UTC 0-23
  endHour: number;    // exclusive, UTC 0-24
}

/**
 * Return the UTC hour within `window` with the highest reply rate for
 * (orgId, niche). Returns `null` when no hour has at least
 * MIN_OBSERVATIONS_PER_HOUR samples.
 */
export async function getPreferredHour(
  db: Database,
  orgId: string,
  niche: string,
  window: SendWindow,
): Promise<number | null> {
  const rows = await db.select({
    utcHour: schema.sendTimeHistograms.utcHour,
    replyRate: schema.sendTimeHistograms.replyRate,
    nSent: schema.sendTimeHistograms.nSent,
  })
    .from(schema.sendTimeHistograms)
    .where(and(
      eq(schema.sendTimeHistograms.orgId, orgId),
      eq(schema.sendTimeHistograms.niche, niche),
      gte(schema.sendTimeHistograms.utcHour, window.startHour),
      lt(schema.sendTimeHistograms.utcHour, window.endHour),
      gte(schema.sendTimeHistograms.nSent, MIN_OBSERVATIONS_PER_HOUR),
    ));
  if (rows.length === 0) return null;
  let best: typeof rows[number] | null = null;
  for (const r of rows) {
    if (!best || Number(r.replyRate) > Number(best.replyRate)) best = r;
  }
  return best ? Number(best.utcHour) : null;
}

/**
 * Bulk variant: returns a Map keyed by `${orgId}|${niche}` for the input set.
 * Avoids N round-trips during a single send batch.
 */
export async function getPreferredHoursBulk(
  db: Database,
  pairs: Array<{ orgId: string; niche: string }>,
  window: SendWindow,
): Promise<Map<string, number>> {
  const seen = new Set<string>();
  const unique: Array<{ orgId: string; niche: string }> = [];
  for (const p of pairs) {
    const key = `${p.orgId}|${p.niche}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  const result = new Map<string, number>();
  /* Fan-out the queries; with typical (1 org × few niches) cardinality this
     is well under 10 round-trips. A future optimization could fetch the
     entire org's histogram once and filter in-memory. */
  await Promise.all(unique.map(async ({ orgId, niche }) => {
    const h = await getPreferredHour(db, orgId, niche, window);
    if (h !== null) result.set(`${orgId}|${niche}`, h);
  }));
  return result;
}

/**
 * Pure helper: given the current UTC time and a preferred hour within the
 * send window, return a `Date` at which a recipient should next be tried.
 *
 * Rules:
 *   - If `preferredHour` is null → null (no deferral, send now).
 *   - If `currentHour` >= preferredHour → null (we're already at or past it).
 *   - Otherwise → a Date set to today's preferred hour, minute 0.
 *
 * `pure`: takes the wall clock as a parameter so unit tests are deterministic.
 */
export function deferralTarget(
  now: Date,
  preferredHour: number | null,
  window: SendWindow,
): Date | null {
  if (preferredHour === null) return null;
  if (preferredHour < window.startHour || preferredHour >= window.endHour) return null;
  const currentHour = now.getUTCHours();
  if (currentHour >= preferredHour) return null;
  const target = new Date(now);
  target.setUTCHours(preferredHour, 0, 0, 0);
  return target;
}
