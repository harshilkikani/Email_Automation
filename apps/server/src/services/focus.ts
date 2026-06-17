/**
 * Focus mode — concentrate the limited daily sends on the best-fit prospects.
 *
 * Two levers, both pure ORDERING (no lead is ever excluded or deleted — the
 * pool keeps every trade and metro; lower-priority leads just send later):
 *   1. lead score      — best-fit leads in any trade send before weaker ones.
 *   2. focus trades    — when set, those trades jump to the front of the queue.
 *
 * The send loop orders queued recipients by `priority DESC`. `priority` is
 * stamped at buildRecipients time and re-stamped here when focus changes, so a
 * focus switch re-orders the existing queue immediately.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';

/** Focus-trade boost dominates the 0–100 score so focus leads always sort first. */
export const FOCUS_BOOST = 100_000;

/** Pure: send-order priority for a recipient. Higher = sent sooner. */
export function recipientPriority(score: number, niche: string, focusNiches: string[]): number {
  const focused = focusNiches.length > 0 && focusNiches.includes(niche);
  const s = Math.max(0, Math.min(Math.round(score || 0), 99_999));
  return (focused ? FOCUS_BOOST : 0) + s;
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

  /* Re-stamp priority for pending/queued recipients: focus-trade boost + lead score. */
  const focusArr = sql`ARRAY[${sql.join(clean.map(n => sql`${n}`), sql`, `)}]::text[]`;
  const res = await db.execute(sql`
    UPDATE campaign_recipients cr
    SET priority = (CASE WHEN ${clean.length > 0 ? sql`l.niche = ANY(${focusArr})` : sql`false`} THEN ${FOCUS_BOOST} ELSE 0 END)
                 + GREATEST(0, LEAST(l.score, 99999))
    FROM leads l
    WHERE cr.lead_id = l.id
      AND cr.org_id = ${orgId}
      AND cr.state IN ('pending','queued')
  `);
  const repriced = (res as unknown as { rowCount?: number }).rowCount ?? 0;
  return { niches: clean, repriced };
}
