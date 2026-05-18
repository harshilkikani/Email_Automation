/**
 * Discovery service. Coordinates: OSM Overpass primary → optional Yelp scoring
 * (TOS-compliant, no-store of display fields) → license lookup → free signal
 * extraction → deterministic scoring → insert leads + signals.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import {
  addToIndex, checkDuplicate, makeIndex, scoreLead, hardFilter,
  type Niche, type ScoringInputs, type WebPresenceLevel,
  SCORING_VERSION_V1,
} from '@keres/core';
import {
  OsmAdapter, OsmSampleAdapter, type DiscoveryProvider,
  YelpAdapter, Scraper, classifyPhone, LicenseRegistry,
} from '@keres/providers';
import { getConfig } from '../config.js';
import { lookupLicense } from './license-importer.js';

export interface RunDiscoveryInput {
  orgId: string;
  niche: Niche;
  city: string;
  state: string;
  targetCount: number;
}

export interface RunDiscoveryOutput {
  found: number;
  inserted: number;
  duplicates: number;
  disqualified: number;
  attribution: string;
}

export async function runDiscovery(db: Database, input: RunDiscoveryInput): Promise<RunDiscoveryOutput> {
  const cfg = getConfig();
  const osm: DiscoveryProvider = cfg.sampleMode
    ? new OsmSampleAdapter(true)
    : new OsmAdapter({ enabled: cfg.osm.enabled, endpoint: cfg.osm.overpassUrl, userAgent: cfg.osm.userAgent });
  const yelp = new YelpAdapter({ enabled: cfg.yelp.enabled && !cfg.sampleMode, apiKey: cfg.yelp.apiKey });
  const scraper = new Scraper({ enabled: !cfg.sampleMode, userAgent: cfg.osm.userAgent });
  const licenses = new LicenseRegistry(cfg.sampleMode);

  const { candidates: rawCandidates, attribution = '' } = await osm.search({
    niche: input.niche, city: input.city, state: input.state, targetCount: input.targetCount * 2,
  });

  /* Build dedupe index from existing leads. */
  const idx = makeIndex();
  const existing = await db.select({
    name: schema.leads.name, email: schema.leads.email, phone: schema.leads.phone,
    website: schema.leads.website, address: schema.leads.address,
    city: schema.leads.city, state: schema.leads.state,
    source: schema.leads.source, sourceExternalId: schema.leads.sourceExternalId,
  })
    .from(schema.leads)
    .where(eq(schema.leads.orgId, input.orgId));
  for (const e of existing) addToIndex(idx, e);

  let inserted = 0, duplicates = 0, disqualified = 0;

  for (const cand of rawCandidates) {
    if (inserted >= input.targetCount) break;

    const hf = hardFilter({ candidate: cand, niche: input.niche });
    if (!hf.ok) { disqualified++; continue; }

    const dup = checkDuplicate(cand, idx);
    if (dup.duplicate) { duplicates++; continue; }

    /* Free signal extraction. Sample-mode pretends. */
    const phone = classifyPhone(cand.phone);
    const probe = scraper.isEnabled()
      ? await scraper.probe(cand.website ?? '')
      : { webPresenceLevel: cand.website ? 'basic' : 'none', emails: [], hasOnlineBooking: false, deadDomain: false, evidence: { sample: true } } as { webPresenceLevel: WebPresenceLevel; emails: string[]; hasOnlineBooking: boolean; deadDomain: boolean; evidence: Record<string, unknown> };
    if (probe.emails.length > 0 && !cand.email) cand.email = probe.emails[0] ?? null;

    /* Prefer DB-backed lookup against `state_licensees` (populated via CSV
       importer per LICENSE-SOURCES.md). Fall back to the sample/stub adapter
       only when sample mode is on AND nothing was imported for this state. */
    const dbHit = !cfg.sampleMode ? await lookupLicense(db, {
      name: cand.name, state: cand.state ?? '', niche: cand.niche, phone: cand.phone,
    }) : null;
    const license = dbHit && dbHit.status !== 'unknown'
      ? dbHit
      : await licenses.lookup(cand.state ?? '', cand.name, cand.niche);

    /* Yelp scoring-only enrichment (never persisted as display fields). */
    let reviewCount30d: number | null = null;
    let reviewRating: number | null = null;
    if (yelp.isEnabled() && cand.address) {
      try {
        const y = await yelp.enrichForScoring(cand.name, cand.address);
        if (y.reviewCount !== null) reviewCount30d = y.reviewCount;
        if (y.rating !== null) reviewRating = y.rating;
      } catch { /* ignore */ }
    }

    const isStormZone = await isInStormZone(db, cand.postalCode);

    const inputs: ScoringInputs = {
      niche: cand.niche,
      webPresenceLevel: probe.webPresenceLevel,
      hasPhone: !!cand.phone,
      phoneLineType: phone.lineType,
      hasOnlineBooking: probe.hasOnlineBooking,
      isStormZone,
      licenseStatus: license.status,
      reviewCount30d,
      reviewRating,
      competitorDensity: null,
      ownerOperator: phone.lineType === 'mobile',
      serviceDispatchModel: true,                      // implied by niche; refined later
      emergencyNiche: ['Septic', 'Water/Mold', 'HVAC', 'Plumber', 'Towing'].includes(cand.niche),
      multiLocation: false,
      isFranchise: false,
      isResidentialAddress: false,
      deadDomain: probe.deadDomain,
    };
    const scored = scoreLead(inputs, SCORING_VERSION_V1);

    const inserted2 = await db.insert(schema.leads).values({
      orgId: input.orgId,
      name: cand.name,
      email: cand.email ?? null,
      phone: cand.phone ?? null,
      website: cand.website ?? null,
      domain: cand.website?.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? null,
      address: cand.address ?? null,
      city: cand.city ?? null,
      state: cand.state?.toUpperCase().slice(0, 2) ?? null,
      postalCode: cand.postalCode ?? null,
      niche: cand.niche,
      source: cand.source,
      sourceExternalId: cand.sourceExternalId ?? null,
      status: 'new',
      score: scored.score,
      scoringVersion: scored.scoringVersion,
      confidence: scored.confidence,
      disqualified: scored.disqualified,
      disqualificationReason: scored.disqualificationReason ?? null,
    }).returning({ id: schema.leads.id });

    const leadId = inserted2[0]?.id;
    if (!leadId) continue;

    await db.insert(schema.leadSignals).values({
      leadId,
      orgId: input.orgId,
      webPresenceLevel: probe.webPresenceLevel,
      webEvidence: probe.evidence,
      hasPhone: !!cand.phone,
      phoneLineType: phone.lineType,
      hasOnlineBooking: probe.hasOnlineBooking,
      isStormZone,
      licenseStatus: license.status,
      reviewCount30d,
      reviewRating,
      emergencyNiche: inputs.emergencyNiche,
      ownerOperatorHeuristic: inputs.ownerOperator,
      serviceDispatchModel: inputs.serviceDispatchModel,
      deadDomain: probe.deadDomain,
      contributions: scored.contributions as unknown as Record<string, unknown>,
    });

    await db.insert(schema.leadSourceEvents).values({
      leadId, orgId: input.orgId,
      source: cand.source,
      externalId: cand.sourceExternalId ?? null,
      payload: { evidence: probe.evidence, license, phone: phone.e164 } as unknown as Record<string, unknown>,
    });

    addToIndex(idx, cand);
    inserted++;
  }

  return {
    found: rawCandidates.length,
    inserted,
    duplicates,
    disqualified,
    attribution,
  };
}

async function isInStormZone(db: Database, postal: string | null | undefined): Promise<boolean> {
  if (!postal) return false;
  const rows = await db.select({ z: schema.noaaStormZones.postalCode })
    .from(schema.noaaStormZones)
    .where(eq(schema.noaaStormZones.postalCode, postal))
    .limit(1);
  return rows.length > 0;
}
