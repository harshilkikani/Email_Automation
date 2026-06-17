/**
 * Focus mode — concentrate the limited daily sends on the best-fit prospects.
 *
 * Three tiers, all pure ORDERING (no lead is ever excluded — the pool keeps every
 * trade and metro; lower-priority leads just send later):
 *   1. focus trades   — when set, those trades jump to the front of the queue.
 *   2. real signal    — leads where we found a concrete, addressable gap (no
 *                       website / low rating / few reviews / no booking) convert
 *                       far better (signal-anchored opener), so they send first.
 *   3. lead score     — best-fit leads within a tier send before weaker ones.
 *
 * Magnitudes keep the tiers from colliding (score is capped at 99,999):
 *   priority = focus(1e7) + signal(1e5) + score.
 * The send loop orders by `priority DESC`; setFocus re-stamps the whole queue.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';

export const FOCUS_BOOST = 10_000_000;   // focus trades dominate
export const SIGNAL_BOOST = 100_000;     // > max score, so any signal lead outranks a no-signal one

/** Pure: send-order priority for a recipient. Higher = sent sooner. */
export function recipientPriority(score: number, niche: string, focusNiches: string[], hasSignal = false): number {
  const focused = focusNiches.length > 0 && focusNiches.includes(niche);
  const s = Math.max(0, Math.min(Math.round(score || 0), 99_999));
  return (focused ? FOCUS_BOOST : 0) + (hasSignal ? SIGNAL_BOOST : 0) + s;
}

export async function getFocus(db: Database, orgId: string): Promise<string[]> {
  const org = (await db.select({ f: schema.organizations.focusNiches })
    .from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0];
  return org?.f ?? [];
}

/**
 * Set the focus trades and re-prioritize every still-queued recipient so the
 * change takes effect on the next send tick (nothing is dropped — only reordered).
 */
export async function setFocus(db: Database, orgId: string, niches: string[]): Promise<{ niches: string[]; repriced: number }> {
  const clean = [...new Set(niches.map(n => n.trim()).filter(Boolean))];
  await db.update(schema.organizations).set({ focusNiches: clean, updatedAt: new Date() })
    .where(eq(schema.organizations.id, orgId));

  /* Re-stamp priority for pending/queued recipients: focus + signal + lead score
     (matches recipientPriority). A "signal" lead has a concrete derived gap. */
  const focusArr = sql`ARRAY[${sql.join(clean.map(n => sql`${n}`), sql`, `)}]::text[]`;
  const res = await db.execute(sql`
    UPDATE campaign_recipients cr
    SET priority = (CASE WHEN ${clean.length > 0 ? sql`l.niche = ANY(${focusArr})` : sql`false`} THEN ${FOCUS_BOOST} ELSE 0 END)
                 + (CASE WHEN s.personalization_fact IS NOT NULL AND s.personalization_fact <> 'generic' THEN ${SIGNAL_BOOST} ELSE 0 END)
                 + GREATEST(0, LEAST(l.score, 99999))
    FROM leads l
    LEFT JOIN lead_signals s ON s.lead_id = l.id
    WHERE cr.lead_id = l.id
      AND cr.org_id = ${orgId}
      AND cr.state IN ('pending','queued')
  `);
  const repriced = (res as unknown as { rowCount?: number }).rowCount ?? 0;
  return { niches: clean, repriced };
}
