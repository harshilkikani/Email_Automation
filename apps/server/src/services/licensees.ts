/**
 * Turn a free state-licensing-board list (state_licensees) into emailable,
 * verified leads: for each licensed business we find its website via the enabled
 * discovery provider (Places/Foursquare, searched by name), scrape a contact
 * email, MX-verify it, and insert a lead. Needs a discovery provider with a key
 * to resolve names → websites; produces 0 without one.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { scoreLead, SCORING_VERSION_V1, type Niche } from '@keres/core';
import { PlacesAdapter, FoursquareAdapter, Scraper, type DiscoveryProvider } from '@keres/providers';
import { getVerifier, isSendableStatus } from './verify.js';
import { getConfig } from '../config.js';

export interface PromoteLicenseesInput {
  orgId: string; niche: Niche; state: string; count: number;
}
export interface PromoteLicenseesResult {
  leadIds: string[]; considered: number; websitesFound: number; inserted: number; needsFinder: boolean;
}

export async function promoteLicensees(db: Database, input: PromoteLicenseesInput): Promise<PromoteLicenseesResult> {
  const cfg = getConfig();
  const places = new PlacesAdapter({ enabled: cfg.places.enabled && !cfg.sampleMode, apiKey: cfg.places.apiKey });
  const fsq = new FoursquareAdapter({ enabled: cfg.foursquare.enabled && !cfg.sampleMode, apiKey: cfg.foursquare.apiKey, baseUrl: cfg.foursquare.baseUrl });
  const finder: DiscoveryProvider | null = places.isEnabled() ? places : fsq.isEnabled() ? fsq : null;
  if (!finder) return { leadIds: [], considered: 0, websitesFound: 0, inserted: 0, needsFinder: true };

  const scraper = new Scraper({ enabled: !cfg.sampleMode, userAgent: cfg.osm.userAgent });
  const verifier = getVerifier();
  const state = input.state.toUpperCase();

  const lic = await db.select().from(schema.stateLicensees)
    .where(and(eq(schema.stateLicensees.state, state), eq(schema.stateLicensees.niche, input.niche), eq(schema.stateLicensees.status, 'active')))
    .limit(Math.max(1, Math.min(input.count, 100)));

  const leadIds: string[] = [];
  let websitesFound = 0, costCents = 0;
  for (const l of lic) {
    if (leadIds.length >= input.count) break;
    /* Skip if we already have a lead with this name. */
    const existing = (await db.select({ id: schema.leads.id }).from(schema.leads)
      .where(and(eq(schema.leads.orgId, input.orgId), eq(schema.leads.name, l.name))).limit(1))[0];
    if (existing) continue;

    /* Resolve name → website via the finder (keyword = business name). */
    let website: string | null = null;
    try {
      const r = await finder.search({ niche: input.niche, city: l.city ?? '', state, targetCount: 1, keyword: l.name });
      website = r.candidates[0]?.website ?? null;
      costCents += (r as { costCents?: number }).costCents ?? 0;
    } catch { /* skip on finder error */ }
    if (!website) continue;
    websitesFound++;

    /* Scrape + MX-verify an email. */
    let email: string | null = null;
    try { const probe = await scraper.probe(website); email = probe.emails[0] ?? null; } catch { /* none */ }
    if (!email) continue;
    let status = 'unknown', source = 'skipped';
    try { const v = await verifier.verify(email); status = v.status; source = v.source; } catch { /* keep unknown */ }
    if (!isSendableStatus(status)) continue;

    const scored = scoreLead({
      niche: input.niche, webPresenceLevel: 'basic', hasPhone: !!l.phone,
      phoneLineType: 'unknown', hasOnlineBooking: false, isStormZone: false,
      licenseStatus: 'active', reviewCount30d: null, reviewRating: null, competitorDensity: null,
      ownerOperator: false, serviceDispatchModel: true,
      emergencyNiche: ['Septic', 'Water/Mold', 'HVAC', 'Plumber', 'Towing'].includes(input.niche),
      multiLocation: false, isFranchise: false, isResidentialAddress: false, deadDomain: false,
    }, SCORING_VERSION_V1);

    const ins = await db.insert(schema.leads).values({
      orgId: input.orgId, name: l.name, email, phone: l.phone,
      website, domain: website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0],
      city: l.city, state, postalCode: l.postalCode, niche: input.niche, source: 'license', status: 'new',
      emailVerificationStatus: status, emailVerificationSource: source,
      score: scored.score, scoringVersion: scored.scoringVersion, confidence: scored.confidence, disqualified: false,
    }).returning({ id: schema.leads.id }).catch(() => [] as { id: string }[]);
    const leadId = ins[0]?.id;
    if (!leadId) continue;
    await db.insert(schema.leadSignals).values({
      leadId, orgId: input.orgId, webPresenceLevel: 'basic', hasOnlineBooking: false, licenseStatus: 'active',
    }).onConflictDoNothing();
    leadIds.push(leadId);
  }

  if (costCents > 0) {
    await db.insert(schema.costEvents).values({
      orgId: input.orgId, provider: finder.name, sku: 'find_place', unitCount: lic.length, costCents,
    }).catch(() => undefined);
  }
  return { leadIds, considered: lic.length, websitesFound, inserted: leadIds.length, needsFinder: false };
}
