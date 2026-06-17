/**
 * Owner enrichment via Hunter domain-search (the other half of the "reviews +
 * owner enrichment" roadmap item).
 *
 * Why Hunter, not Apollo: Apollo is LinkedIn/enterprise-sourced and covers
 * <25% of home services — it returns zero for most plumbers/HVAC/etc and burns
 * credits on bad data. Hunter indexes the company's own domain, so it actually
 * returns the owner's name + position for local businesses.
 *
 * Operator-controlled (admin endpoint, not an auto-tick) so paid credit spend
 * stays deliberate. Free site-crawl owner-finding (owner-finder.ts) still runs at
 * intake for $0; this only top-ups the highest-value leads it couldn't name —
 * the owner name in the greeting is worth ~142% more replies. We set the name
 * only (not the send-to email) to avoid touching dedupe/verification.
 */
import { and, desc, eq, gte, isNull, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import { HunterAdapter, type HunterOwnerCandidate } from '@keres/providers';
import { getConfig } from '../config.js';
import { obs } from '../observability.js';

/* Decision-maker titles, most senior first → higher rank. */
const OWNER_TITLES: RegExp[] = [
  /\bowner\b/i,
  /\b(founder|co-?founder)\b/i,
  /\b(president|principal|proprietor)\b/i,
  /\b(ceo|chief executive)\b/i,
  /\b(general manager|operations manager|\bgm\b)\b/i,
  /\b(manager|director|partner)\b/i,
];

/** Pure: pick the best named owner/decision-maker from Hunter candidates. */
export function pickHunterOwner(cands: HunterOwnerCandidate[]): (HunterOwnerCandidate & { name: string }) | null {
  let best: HunterOwnerCandidate | null = null;
  let bestRank = -1, bestConf = -1;
  for (const c of cands) {
    if (!c.firstName) continue;                 // need a name for the greeting
    let rank = 0;                               // a named person at the company beats nothing
    if (c.position) {
      for (let i = 0; i < OWNER_TITLES.length; i++) {
        if (OWNER_TITLES[i]!.test(c.position)) { rank = OWNER_TITLES.length - i + 1; break; }
      }
    }
    const conf = c.confidence ?? 0;
    if (rank > bestRank || (rank === bestRank && conf > bestConf)) { best = c; bestRank = rank; bestConf = conf; }
  }
  if (!best) return null;
  const name = [best.firstName, best.lastName].filter(Boolean).join(' ').trim();
  return name ? { ...best, name } : null;
}

function normalizeDomain(website: string): string {
  return website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';
}

export interface EnrichResult {
  skipped?: string;
  tried?: number;
  named?: number;
  creditsUsedThisMonth?: number;
  monthlyCap?: number;
}

/**
 * Enrich up to `limit` of the highest-value, un-named, website-having leads with
 * an owner name via Hunter. Respects the monthly free-credit cap, marks every
 * lead it attempts (success or not) so a credit is never spent twice.
 */
export async function enrichOwnersViaHunter(db: Database, log: FastifyBaseLogger, limit = 25): Promise<EnrichResult> {
  const cfg = getConfig();
  if (!cfg.hunter.enabled || !cfg.hunter.apiKey) return { skipped: 'hunter_disabled' };

  const org = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
  if (!org) return { skipped: 'no_org' };

  /* Monthly credit budget: count Hunter cost_events since the 1st (UTC). */
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const usedRow = (await db.select({ n: sql<number>`count(*)::int` })
    .from(schema.costEvents)
    .where(and(eq(schema.costEvents.provider, 'hunter'), gte(schema.costEvents.occurredAt, monthStart))))[0];
  const used = Number(usedRow?.n ?? 0);
  const remaining = Math.max(0, cfg.hunter.monthlyFreeCredits - used);
  if (remaining <= 0) return { skipped: 'monthly_credits_exhausted', creditsUsedThisMonth: used, monthlyCap: cfg.hunter.monthlyFreeCredits };

  const batch = Math.min(Math.max(1, limit), remaining);
  const leads = await db.select({ id: schema.leads.id, website: schema.leads.website })
    .from(schema.leads)
    .where(and(
      eq(schema.leads.orgId, org.id),
      isNull(schema.leads.deletedAt),
      isNull(schema.leads.ownerName),
      isNull(schema.leads.hunterEnrichedAt),
      isNotNull(schema.leads.website),
    ))
    .orderBy(desc(schema.leads.score))
    .limit(batch);

  const hunter = new HunterAdapter({ enabled: true, apiKey: cfg.hunter.apiKey });
  let tried = 0, named = 0;
  for (const l of leads) {
    tried++;
    let cands: HunterOwnerCandidate[] = [];
    try { cands = await hunter.domainSearch(normalizeDomain(l.website!)); }
    catch (e) { obs().captureException(e, { leadId: l.id, op: 'hunter_domain_search' }); }
    /* Log the credit spend regardless of outcome (a call was made). */
    await db.insert(schema.costEvents).values({
      orgId: org.id, provider: 'hunter', sku: 'owner_enrich', unitCount: 1, costCents: 0, leadId: l.id,
    }).catch(() => undefined);

    const owner = pickHunterOwner(cands);
    await db.update(schema.leads)
      .set({ hunterEnrichedAt: new Date(), ...(owner ? { ownerName: owner.name } : {}) })
      .where(eq(schema.leads.id, l.id));
    if (owner) named++;
  }

  log.info({ tried, named, used: used + tried, cap: cfg.hunter.monthlyFreeCredits }, 'owner enrichment (hunter)');
  return { tried, named, creditsUsedThisMonth: used + tried, monthlyCap: cfg.hunter.monthlyFreeCredits };
}
