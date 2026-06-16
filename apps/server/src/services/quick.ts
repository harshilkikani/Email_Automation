/**
 * "Scrape & Send" orchestrator — chains the existing pipeline into one step so
 * the simple UI can scrape a batch of businesses, personalize, and stage a
 * ready-to-send campaign. Sending itself still goes through the normal launch
 * gate + send_batch tick (caps, warmup, suppression all apply).
 */
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { defaultTemplateFor, composeOfferEmail, offerSubjects, OFFER_LABEL, cleanFirstName, type Niche, type ValidationOffer } from '@keres/core';
import { runDiscovery } from './discovery.js';
import { personalizeLead } from './personalization.js';
import { createCampaign, buildRecipients, renderPreview, resolveAudience, type AudienceFilter } from './campaigns.js';
import { isSendableStatus } from './verify.js';
import { promoteLicensees } from './licensees.js';

export interface QuickScrapeInput {
  orgId: string;
  niche: Niche;
  city: string;
  state: string;
  count: number;
  /** Number of follow-up touches after the first email (0 = single send). */
  followups?: number;
  /** Days between touches. */
  stepDelayDays?: number;
}

export interface QuickScrapeResult {
  campaignId: string;
  found: number;          // businesses returned by discovery
  inserted: number;       // new leads added this run (after dedup/filters)
  withEmail: number;      // of those, how many had a scrapeable email
  verified: number;       // of those, how many passed MX/syntax verification (= sendable)
  recipientCount: number; // recipients staged on the campaign
  recipients: Array<{ name: string; city: string | null; email: string | null; owner: string | null; opener: string | null; verified: boolean }>;
  sample: Awaited<ReturnType<typeof renderPreview>> | null;
}

export async function quickScrape(db: Database, input: QuickScrapeInput): Promise<QuickScrapeResult> {
  /* 1. Discover + scrape sites (captures contact emails into lead.email). */
  const disc = await runDiscovery(db, {
    orgId: input.orgId, niche: input.niche, city: input.city,
    state: input.state, targetCount: Math.max(1, Math.min(input.count, 100)),
  });

  /* Target every matching UNCONTACTED lead (new + already-saved), so a re-scrape
     of the same trade/city still surfaces leads instead of 0 after dedupe. */
  return stageAndReview(db, input, `${input.city}, ${input.state.toUpperCase()}`,
    { niche: input.niche, city: input.city, state: input.state, status: 'uncontacted' }, disc.found, disc.inserted);
}

/** Scrape & Send variant sourced from imported state-license lists (free niche data). */
export async function quickFromLicenses(db: Database, input: QuickScrapeInput): Promise<QuickScrapeResult & { needsFinder?: boolean }> {
  const r = await promoteLicensees(db, { orgId: input.orgId, niche: input.niche, state: input.state, count: input.count });
  const res = await stageAndReview(db, input, `${input.niche} licensees — ${input.state.toUpperCase()}`, { leadIds: r.leadIds }, r.considered, r.inserted);
  return { ...res, withEmail: r.websitesFound, needsFinder: r.needsFinder };
}

/** Shared: resolve the audience, personalize it, stage a campaign, build review. */
async function stageAndReview(
  db: Database, input: QuickScrapeInput, label: string,
  audienceFilter: AudienceFilter, found: number, inserted: number,
): Promise<QuickScrapeResult> {
  const { orgId, niche } = input;
  /* Resolve the audience (already excludes no-email / unverified / suppressed). */
  const { leadIds } = await resolveAudience(db, orgId, audienceFilter);

  /* Personalize any audience lead that doesn't have an opener yet. */
  const need = leadIds.length
    ? await db.select({ id: schema.leadSignals.leadId })
        .from(schema.leadSignals)
        .where(and(inArray(schema.leadSignals.leadId, leadIds), isNull(schema.leadSignals.personalizedOpener)))
    : [];
  for (const { id } of need) {
    try { await personalizeLead(db, id); } catch { /* best-effort */ }
  }

  const tpl = defaultTemplateFor(niche);
  const { id: campaignId } = await createCampaign(db, {
    orgId,
    name: `${niche} — ${label} (${new Date().toISOString().slice(0, 10)})`,
    templateKey: tpl.key,
    /* Two subjects → renderEmail rotates them stably per lead, so a batch
       doesn't go out with one identical subject line (looks like a blast and
       tanks both deliverability and replies). */
    subjectA: tpl.subjectVariants[0] ?? 'quick question, {{business}}',
    subjectB: tpl.subjectVariants[1] ?? tpl.subjectVariants[0] ?? 'quick question about {{business}}',
    audienceFilter,
    sequenceSteps: 1 + Math.max(0, input.followups ?? 0),
    stepDelayDays: input.stepDelayDays ?? 3,
  });
  const recipientCount = leadIds.length ? await buildRecipients(db, campaignId) : 0;

  const leads = leadIds.length
    ? await db.select({ id: schema.leads.id, name: schema.leads.name, city: schema.leads.city, email: schema.leads.email, owner: schema.leads.ownerName, ev: schema.leads.emailVerificationStatus })
        .from(schema.leads).where(inArray(schema.leads.id, leadIds))
    : [];
  const openerRows = leadIds.length
    ? await db.select({ leadId: schema.leadSignals.leadId, opener: schema.leadSignals.personalizedOpener })
        .from(schema.leadSignals).where(inArray(schema.leadSignals.leadId, leadIds))
    : [];
  const openerById = new Map(openerRows.map(r => [r.leadId, r.opener]));

  const withEmail = leads.filter(l => l.email);
  const recipients = withEmail.map(l => ({
    name: l.name, city: l.city, email: l.email, owner: l.owner ?? null,
    opener: openerById.get(l.id) ?? null, verified: isSendableStatus(l.ev),
  }));
  const firstSendable = withEmail.find(l => isSendableStatus(l.ev)) ?? withEmail[0];

  let sample: QuickScrapeResult['sample'] = null;
  if (firstSendable) {
    try { sample = await renderPreview(db, campaignId, firstSendable.id); } catch { /* ignore */ }
  }

  return {
    campaignId, found, inserted,
    withEmail: withEmail.length,
    verified: recipients.filter(r => r.verified).length,
    recipientCount, recipients, sample,
  };
}

/* ────────────── Mass mode: niche-only auto-sweep + send to the whole pool ──────────────
 *
 * Instead of typing a city each time, the operator picks a niche and the system
 * sweeps a built-in list of US metros, accumulating every business it finds into
 * one growing lead pool. Each request handles a small batch of metros (discovery
 * enriches each lead inline — site crawl + owner-find + MX-verify — so we keep
 * batches small and let the client loop through the list, showing live progress).
 * Then one "Send to all" stages a campaign over the whole verified pool and the
 * normal drip (caps + warmup + send window) takes it from there. */

/** Built-in metro sweep list — broad US coverage so a niche-only search finds a lot. */
export const US_METROS: Array<{ city: string; state: string }> = [
  { city: 'New York', state: 'NY' }, { city: 'Los Angeles', state: 'CA' }, { city: 'Chicago', state: 'IL' },
  { city: 'Houston', state: 'TX' }, { city: 'Phoenix', state: 'AZ' }, { city: 'Philadelphia', state: 'PA' },
  { city: 'San Antonio', state: 'TX' }, { city: 'San Diego', state: 'CA' }, { city: 'Dallas', state: 'TX' },
  { city: 'Austin', state: 'TX' }, { city: 'San Jose', state: 'CA' }, { city: 'Fort Worth', state: 'TX' },
  { city: 'Jacksonville', state: 'FL' }, { city: 'Columbus', state: 'OH' }, { city: 'Charlotte', state: 'NC' },
  { city: 'Indianapolis', state: 'IN' }, { city: 'San Francisco', state: 'CA' }, { city: 'Seattle', state: 'WA' },
  { city: 'Denver', state: 'CO' }, { city: 'Nashville', state: 'TN' }, { city: 'Oklahoma City', state: 'OK' },
  { city: 'El Paso', state: 'TX' }, { city: 'Washington', state: 'DC' }, { city: 'Boston', state: 'MA' },
  { city: 'Las Vegas', state: 'NV' }, { city: 'Portland', state: 'OR' }, { city: 'Detroit', state: 'MI' },
  { city: 'Memphis', state: 'TN' }, { city: 'Louisville', state: 'KY' }, { city: 'Milwaukee', state: 'WI' },
  { city: 'Baltimore', state: 'MD' }, { city: 'Albuquerque', state: 'NM' }, { city: 'Tucson', state: 'AZ' },
  { city: 'Fresno', state: 'CA' }, { city: 'Sacramento', state: 'CA' }, { city: 'Kansas City', state: 'MO' },
  { city: 'Mesa', state: 'AZ' }, { city: 'Atlanta', state: 'GA' }, { city: 'Omaha', state: 'NE' },
  { city: 'Colorado Springs', state: 'CO' }, { city: 'Raleigh', state: 'NC' }, { city: 'Virginia Beach', state: 'VA' },
  { city: 'Miami', state: 'FL' }, { city: 'Oakland', state: 'CA' }, { city: 'Minneapolis', state: 'MN' },
  { city: 'Tulsa', state: 'OK' }, { city: 'Tampa', state: 'FL' }, { city: 'Arlington', state: 'TX' },
  { city: 'New Orleans', state: 'LA' }, { city: 'Wichita', state: 'KS' }, { city: 'Cleveland', state: 'OH' },
  { city: 'Charleston', state: 'SC' }, { city: 'Orlando', state: 'FL' }, { city: 'St. Louis', state: 'MO' },
  { city: 'Pittsburgh', state: 'PA' }, { city: 'Cincinnati', state: 'OH' }, { city: 'Salt Lake City', state: 'UT' },
  { city: 'Richmond', state: 'VA' }, { city: 'Boise', state: 'ID' }, { city: 'Des Moines', state: 'IA' },
  // ── extended coverage (mid-size metros) ──
  { city: 'Bakersfield', state: 'CA' }, { city: 'Aurora', state: 'CO' }, { city: 'Anaheim', state: 'CA' },
  { city: 'Riverside', state: 'CA' }, { city: 'Corpus Christi', state: 'TX' }, { city: 'Lexington', state: 'KY' },
  { city: 'Henderson', state: 'NV' }, { city: 'Stockton', state: 'CA' }, { city: 'Saint Paul', state: 'MN' },
  { city: 'Greensboro', state: 'NC' }, { city: 'Plano', state: 'TX' }, { city: 'Lincoln', state: 'NE' },
  { city: 'Buffalo', state: 'NY' }, { city: 'Fort Wayne', state: 'IN' }, { city: 'Jersey City', state: 'NJ' },
  { city: 'Durham', state: 'NC' }, { city: 'Madison', state: 'WI' }, { city: 'Lubbock', state: 'TX' },
  { city: 'Winston-Salem', state: 'NC' }, { city: 'Garland', state: 'TX' }, { city: 'Glendale', state: 'AZ' },
  { city: 'Reno', state: 'NV' }, { city: 'Chandler', state: 'AZ' }, { city: 'Norfolk', state: 'VA' },
  { city: 'Birmingham', state: 'AL' }, { city: 'Rochester', state: 'NY' }, { city: 'Scottsdale', state: 'AZ' },
  { city: 'Irving', state: 'TX' }, { city: 'Spokane', state: 'WA' }, { city: 'Knoxville', state: 'TN' },
  { city: 'Akron', state: 'OH' }, { city: 'Little Rock', state: 'AR' }, { city: 'Grand Rapids', state: 'MI' },
  { city: 'Mobile', state: 'AL' }, { city: 'Shreveport', state: 'LA' }, { city: 'Tallahassee', state: 'FL' },
  { city: 'Huntsville', state: 'AL' }, { city: 'Chattanooga', state: 'TN' }, { city: 'Fort Lauderdale', state: 'FL' },
  { city: 'Dayton', state: 'OH' }, { city: 'Spokane Valley', state: 'WA' }, { city: 'Savannah', state: 'GA' },
  // ── more metros (wave 2) ──
  { city: 'Chesapeake', state: 'VA' }, { city: 'Gilbert', state: 'AZ' }, { city: 'Irvine', state: 'CA' },
  { city: 'Fremont', state: 'CA' }, { city: 'Baton Rouge', state: 'LA' }, { city: 'Santa Ana', state: 'CA' },
  { city: 'Modesto', state: 'CA' }, { city: 'San Bernardino', state: 'CA' }, { city: 'Oxnard', state: 'CA' },
  { city: 'Huntington Beach', state: 'CA' }, { city: 'Garden Grove', state: 'CA' }, { city: 'Tempe', state: 'AZ' },
  { city: 'Cape Coral', state: 'FL' }, { city: 'Pembroke Pines', state: 'FL' }, { city: 'Hollywood', state: 'FL' },
  { city: 'Port St. Lucie', state: 'FL' }, { city: 'Gainesville', state: 'FL' }, { city: 'Clarksville', state: 'TN' },
  { city: 'Murfreesboro', state: 'TN' }, { city: 'Killeen', state: 'TX' }, { city: 'McKinney', state: 'TX' },
  { city: 'Frisco', state: 'TX' }, { city: 'Brownsville', state: 'TX' }, { city: 'Pasadena', state: 'TX' },
  { city: 'Mesquite', state: 'TX' }, { city: 'Denton', state: 'TX' }, { city: 'Waco', state: 'TX' },
  { city: 'Midland', state: 'TX' }, { city: 'Round Rock', state: 'TX' }, { city: 'Sugar Land', state: 'TX' },
  { city: 'Carrollton', state: 'TX' }, { city: 'Columbia', state: 'SC' }, { city: 'North Charleston', state: 'SC' },
  { city: 'Augusta', state: 'GA' }, { city: 'Columbus', state: 'GA' }, { city: 'Macon', state: 'GA' },
  { city: 'Athens', state: 'GA' }, { city: 'Cary', state: 'NC' }, { city: 'Wilmington', state: 'NC' },
  { city: 'Fayetteville', state: 'NC' }, { city: 'Newark', state: 'NJ' }, { city: 'Paterson', state: 'NJ' },
  { city: 'Toledo', state: 'OH' }, { city: 'Fort Collins', state: 'CO' }, { city: 'Lakewood', state: 'CO' },
  { city: 'Thornton', state: 'CO' }, { city: 'Pueblo', state: 'CO' }, { city: 'Provo', state: 'UT' },
  { city: 'West Valley City', state: 'UT' }, { city: 'Ogden', state: 'UT' }, { city: 'Eugene', state: 'OR' },
  { city: 'Salem', state: 'OR' }, { city: 'Hillsboro', state: 'OR' }, { city: 'Tacoma', state: 'WA' },
  { city: 'Vancouver', state: 'WA' }, { city: 'Bellevue', state: 'WA' }, { city: 'Everett', state: 'WA' },
  { city: 'Springfield', state: 'MO' }, { city: 'Independence', state: 'MO' }, { city: 'Overland Park', state: 'KS' },
  { city: 'Olathe', state: 'KS' }, { city: 'Topeka', state: 'KS' }, { city: 'Sioux Falls', state: 'SD' },
  { city: 'Fargo', state: 'ND' }, { city: 'Billings', state: 'MT' }, { city: 'Cedar Rapids', state: 'IA' },
  { city: 'Davenport', state: 'IA' }, { city: 'Green Bay', state: 'WI' }, { city: 'Kenosha', state: 'WI' },
  { city: 'Rockford', state: 'IL' }, { city: 'Naperville', state: 'IL' }, { city: 'Joliet', state: 'IL' },
  { city: 'Peoria', state: 'IL' }, { city: 'Evansville', state: 'IN' }, { city: 'South Bend', state: 'IN' },
  { city: 'Hartford', state: 'CT' }, { city: 'New Haven', state: 'CT' }, { city: 'Bridgeport', state: 'CT' },
  { city: 'Worcester', state: 'MA' }, { city: 'Springfield', state: 'MA' }, { city: 'Providence', state: 'RI' },
  { city: 'Manchester', state: 'NH' }, { city: 'Allentown', state: 'PA' }, { city: 'Erie', state: 'PA' },
  { city: 'Syracuse', state: 'NY' }, { city: 'Albany', state: 'NY' }, { city: 'Yonkers', state: 'NY' },
  // ── more metros (wave 3) ──
  { city: 'Oceanside', state: 'CA' }, { city: 'Santa Rosa', state: 'CA' }, { city: 'Elk Grove', state: 'CA' },
  { city: 'Corona', state: 'CA' }, { city: 'Lancaster', state: 'CA' }, { city: 'Salinas', state: 'CA' },
  { city: 'Hayward', state: 'CA' }, { city: 'Sunnyvale', state: 'CA' }, { city: 'Escondido', state: 'CA' },
  { city: 'Roseville', state: 'CA' }, { city: 'Visalia', state: 'CA' }, { city: 'Concord', state: 'CA' },
  { city: 'Temecula', state: 'CA' }, { city: 'Amarillo', state: 'TX' }, { city: 'Grand Prairie', state: 'TX' },
  { city: 'McAllen', state: 'TX' }, { city: 'College Station', state: 'TX' }, { city: 'Beaumont', state: 'TX' },
  { city: 'Tyler', state: 'TX' }, { city: 'League City', state: 'TX' }, { city: 'New Braunfels', state: 'TX' },
  { city: 'Georgetown', state: 'TX' }, { city: 'Temple', state: 'TX' }, { city: 'Longview', state: 'TX' },
  { city: 'St. Petersburg', state: 'FL' }, { city: 'Lakeland', state: 'FL' }, { city: 'Pompano Beach', state: 'FL' },
  { city: 'Coral Springs', state: 'FL' }, { city: 'Palm Bay', state: 'FL' }, { city: 'West Palm Beach', state: 'FL' },
  { city: 'Clearwater', state: 'FL' }, { city: 'Brandon', state: 'FL' }, { city: 'Kissimmee', state: 'FL' },
  { city: 'Sarasota', state: 'FL' }, { city: 'Boca Raton', state: 'FL' }, { city: 'Ocala', state: 'FL' },
  { city: 'Surprise', state: 'AZ' }, { city: 'Yuma', state: 'AZ' }, { city: 'Avondale', state: 'AZ' },
  { city: 'Goodyear', state: 'AZ' }, { city: 'Flagstaff', state: 'AZ' }, { city: 'Gastonia', state: 'NC' },
  { city: 'Asheville', state: 'NC' }, { city: 'Chapel Hill', state: 'NC' }, { city: 'Concord', state: 'NC' },
  { city: 'Sandy Springs', state: 'GA' }, { city: 'Roswell', state: 'GA' }, { city: 'Warner Robins', state: 'GA' },
  { city: 'Marietta', state: 'GA' }, { city: 'Albany', state: 'GA' }, { city: 'Renton', state: 'WA' },
  { city: 'Yakima', state: 'WA' }, { city: 'Federal Way', state: 'WA' }, { city: 'Bellingham', state: 'WA' },
  { city: 'Kennewick', state: 'WA' }, { city: 'Olympia', state: 'WA' }, { city: 'Centennial', state: 'CO' },
  { city: 'Boulder', state: 'CO' }, { city: 'Greeley', state: 'CO' }, { city: 'Longmont', state: 'CO' },
  { city: 'Loveland', state: 'CO' }, { city: 'Canton', state: 'OH' }, { city: 'Youngstown', state: 'OH' },
  { city: 'Parma', state: 'OH' }, { city: 'Hamilton', state: 'OH' }, { city: 'Johnson City', state: 'TN' },
  { city: 'Franklin', state: 'TN' }, { city: 'Jackson', state: 'TN' }, { city: 'Kingsport', state: 'TN' },
  { city: 'Carmel', state: 'IN' }, { city: 'Bloomington', state: 'IN' }, { city: 'Lafayette', state: 'IN' },
  { city: 'Noblesville', state: 'IN' }, { city: 'Roanoke', state: 'VA' }, { city: 'Lynchburg', state: 'VA' },
  { city: 'Alexandria', state: 'VA' }, { city: 'Hampton', state: 'VA' }, { city: 'Newport News', state: 'VA' },
  { city: 'Charlottesville', state: 'VA' }, { city: 'Bend', state: 'OR' }, { city: 'Medford', state: 'OR' },
  { city: 'Beaverton', state: 'OR' }, { city: 'Sparks', state: 'NV' }, { city: 'Sandy', state: 'UT' },
  { city: 'Orem', state: 'UT' }, { city: 'St. George', state: 'UT' }, { city: 'Lehi', state: 'UT' },
  { city: 'Layton', state: 'UT' }, { city: 'Las Cruces', state: 'NM' }, { city: 'Rio Rancho', state: 'NM' },
  { city: 'Santa Fe', state: 'NM' }, { city: 'Norman', state: 'OK' }, { city: 'Broken Arrow', state: 'OK' },
  { city: 'Edmond', state: 'OK' }, { city: 'Lafayette', state: 'LA' }, { city: 'Lake Charles', state: 'LA' },
  { city: 'Metairie', state: 'LA' }, { city: 'Greenville', state: 'SC' }, { city: 'Rock Hill', state: 'SC' },
  { city: 'Mount Pleasant', state: 'SC' }, { city: 'Spartanburg', state: 'SC' }, { city: 'Montgomery', state: 'AL' },
  { city: 'Tuscaloosa', state: 'AL' }, { city: 'Hoover', state: 'AL' }, { city: 'Jackson', state: 'MS' },
  { city: 'Gulfport', state: 'MS' }, { city: 'Fayetteville', state: 'AR' }, { city: 'Fort Smith', state: 'AR' },
  { city: 'Jonesboro', state: 'AR' }, { city: 'Bowling Green', state: 'KY' }, { city: 'Owensboro', state: 'KY' },
  { city: 'Rochester', state: 'MN' }, { city: 'Bloomington', state: 'MN' }, { city: 'Duluth', state: 'MN' },
  { city: 'Maple Grove', state: 'MN' }, { city: 'Appleton', state: 'WI' }, { city: 'Waukesha', state: 'WI' },
  { city: 'Eau Claire', state: 'WI' }, { city: 'Iowa City', state: 'IA' }, { city: 'Ames', state: 'IA' },
  { city: 'Lawrence', state: 'KS' }, { city: 'Nampa', state: 'ID' }, { city: 'Meridian', state: 'ID' },
  { city: 'Idaho Falls', state: 'ID' }, { city: 'Coeur d\'Alene', state: 'ID' }, { city: 'Missoula', state: 'MT' },
  { city: 'Bozeman', state: 'MT' }, { city: 'Schenectady', state: 'NY' }, { city: 'Utica', state: 'NY' },
  { city: 'White Plains', state: 'NY' }, { city: 'Edison', state: 'NJ' }, { city: 'Trenton', state: 'NJ' },
  { city: 'Clifton', state: 'NJ' }, { city: 'Reading', state: 'PA' }, { city: 'Bethlehem', state: 'PA' },
  { city: 'Harrisburg', state: 'PA' }, { city: 'Lowell', state: 'MA' }, { city: 'Cambridge', state: 'MA' },
  { city: 'Quincy', state: 'MA' }, { city: 'New Bedford', state: 'MA' }, { city: 'Stamford', state: 'CT' },
  { city: 'Waterbury', state: 'CT' }, { city: 'Norwalk', state: 'CT' }, { city: 'Frederick', state: 'MD' },
  { city: 'Rockville', state: 'MD' }, { city: 'Gaithersburg', state: 'MD' },
];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));

export interface SweepInput {
  orgId: string;
  niche: Niche;
  /** Index into US_METROS to start from (for the client's loop). */
  cursor?: number;
  /** Metros to process this request (kept small — discovery enriches inline). */
  batch?: number;
  /** Target leads per metro. */
  perMetro?: number;
}

export interface SweepResult {
  added: number;            // new leads inserted this batch
  foundThisBatch: number;   // businesses discovery returned this batch
  metrosSwept: string[];    // "City, ST" handled this batch
  cursor: number;           // where this batch started
  nextCursor: number | null;// next index, or null when the whole list is done
  done: boolean;
  totalMetros: number;
  poolCount: number;        // sendable (verified, uncontacted) leads for this niche
}

/** Sweep one small batch of metros for a niche, accumulating leads into the pool. */
export async function quickSweep(db: Database, input: SweepInput): Promise<SweepResult> {
  const batch = clamp(input.batch ?? 2, 1, 6);
  const perMetro = clamp(input.perMetro ?? 8, 1, 25);
  const start = clamp(input.cursor ?? 0, 0, US_METROS.length);
  const slice = US_METROS.slice(start, start + batch);

  let added = 0, found = 0;
  const metrosSwept: string[] = [];
  for (const m of slice) {
    metrosSwept.push(`${m.city}, ${m.state}`);
    try {
      const r = await runDiscovery(db, {
        orgId: input.orgId, niche: input.niche, city: m.city, state: m.state, targetCount: perMetro,
      });
      added += r.inserted; found += r.found;
    } catch { /* one metro failing (timeout/empty) shouldn't stop the sweep */ }
  }

  const nextIdx = start + slice.length;
  const done = nextIdx >= US_METROS.length;
  /* Pool = everything sendable & uncontacted for this niche, across all cities. */
  const { leadIds } = await resolveAudience(db, input.orgId, { niche: input.niche, status: 'uncontacted' });

  return {
    added, foundThisBatch: found, metrosSwept,
    cursor: start, nextCursor: done ? null : nextIdx, done,
    totalMetros: US_METROS.length,
    poolCount: leadIds.length,
  };
}

/**
 * Primary flow: "Get N leads anywhere." Niche only — no city/state. Picks a
 * RANDOM starting metro and pulls from a few cities until ~N new businesses land
 * in the pool (random start + per-org dedupe means repeat clicks explore new
 * cities instead of re-scraping the same one). Stages a review over the whole
 * uncontacted pool so the operator can eyeball the batch and send (drip-safe).
 */
export async function quickGet(db: Database, input: {
  orgId: string; niche: Niche; count?: number; followups?: number; stepDelayDays?: number;
}): Promise<QuickScrapeResult> {
  const target = clamp(input.count ?? 15, 5, 50);
  /* Per-site enrichment (crawl + owner-find + MX-verify) dominates latency, so
     bound the whole batch by a wall-clock budget — a click is always snappy,
     and yields "up to N" (click again for more). Small perMetro keeps each
     metro short so we can sample several. */
  const perMetro = 6;
  const maxMetros = 6;
  const BUDGET_MS = 30_000;
  const start = Math.floor(Math.random() * US_METROS.length);
  const t0 = Date.now();

  let added = 0, found = 0;
  for (let k = 0; k < maxMetros && added < target; k++) {
    if (Date.now() - t0 > BUDGET_MS) break;        // keep the request snappy
    const m = US_METROS[(start + k) % US_METROS.length]!;
    try {
      const r = await runDiscovery(db, {
        orgId: input.orgId, niche: input.niche, city: m.city, state: m.state, targetCount: perMetro,
      });
      added += r.inserted; found += r.found;
    } catch { /* one metro failing shouldn't abort the batch */ }
  }

  const qi: QuickScrapeInput = {
    orgId: input.orgId, niche: input.niche, city: '', state: '', count: target,
    followups: input.followups, stepDelayDays: input.stepDelayDays,
  };
  return stageAndReview(db, qi, `${input.niche} — anywhere`,
    { niche: input.niche, status: 'uncontacted' }, found, added);
}

/**
 * Validation campaign: pitch an ALTERNATE offer (insurance-claim supplement, or
 * get-paid/liens) to a niche's pool, so we can A/B its reply rate against the
 * core AI-solutions pitch. Overwrites each lead's stored body with the offer
 * copy + tags the variant `offer`, then sends through the normal gated pipeline.
 */
export async function stageValidationOffer(db: Database, input: {
  orgId: string; offer: ValidationOffer; niche: Niche; count?: number; followups?: number; stepDelayDays?: number;
}): Promise<QuickScrapeResult> {
  const { orgId, niche, offer } = input;
  const { leadIds: poolIds } = await resolveAudience(db, orgId, { niche, status: 'uncontacted' });
  const leadIds = poolIds.slice(0, clamp(input.count ?? 25, 1, 100));

  if (leadIds.length) {
    const genLeads = await db.select({ id: schema.leads.id, name: schema.leads.name, city: schema.leads.city, owner: schema.leads.ownerName })
      .from(schema.leads).where(inArray(schema.leads.id, leadIds));
    for (const l of genLeads) {
      const ownerFirst = cleanFirstName(l.owner);
      const { body, variant } = composeOfferEmail({ offer, business: l.name, city: l.city ?? '', ownerFirst, seed: l.id });
      await db.update(schema.leadSignals).set({
        personalizedBody: body,
        personalizedOpener: null,
        personalizationFact: offer,
        personalizationModel: 'offer',
        personalizationVariant: variant as unknown as Record<string, unknown>,
        personalizationAt: new Date(),
      }).where(eq(schema.leadSignals.leadId, l.id));
    }
  }

  const tpl = defaultTemplateFor(niche);
  const [sa, sb] = offerSubjects(offer);
  const { id: campaignId } = await createCampaign(db, {
    orgId, name: `${OFFER_LABEL[offer]} — ${niche} (${new Date().toISOString().slice(0, 10)})`,
    templateKey: tpl.key, subjectA: sa, subjectB: sb,
    audienceFilter: { leadIds }, sequenceSteps: 1 + Math.max(0, input.followups ?? 0), stepDelayDays: input.stepDelayDays ?? 3,
  });
  const recipientCount = leadIds.length ? await buildRecipients(db, campaignId) : 0;

  const leads = leadIds.length
    ? await db.select({ id: schema.leads.id, name: schema.leads.name, city: schema.leads.city, email: schema.leads.email, owner: schema.leads.ownerName, ev: schema.leads.emailVerificationStatus })
        .from(schema.leads).where(inArray(schema.leads.id, leadIds))
    : [];
  const withEmail = leads.filter(l => l.email);
  const recipients = withEmail.map(l => ({ name: l.name, city: l.city, email: l.email, owner: l.owner ?? null, opener: OFFER_LABEL[offer], verified: isSendableStatus(l.ev) }));
  const firstSendable = withEmail.find(l => isSendableStatus(l.ev)) ?? withEmail[0];
  let sample: QuickScrapeResult['sample'] = null;
  if (firstSendable) { try { sample = await renderPreview(db, campaignId, firstSendable.id); } catch { /* ignore */ } }

  return {
    campaignId, found: leadIds.length, inserted: 0, withEmail: withEmail.length,
    verified: recipients.filter(r => r.verified).length, recipientCount, recipients, sample,
  };
}

/** Stage a campaign over the ENTIRE verified, uncontacted pool for a niche. */
export async function quickPoolStage(db: Database, input: {
  orgId: string; niche: Niche; followups?: number; stepDelayDays?: number;
}): Promise<QuickScrapeResult> {
  const qi: QuickScrapeInput = {
    orgId: input.orgId, niche: input.niche, city: '', state: '', count: 0,
    followups: input.followups, stepDelayDays: input.stepDelayDays,
  };
  return stageAndReview(db, qi, `${input.niche} — entire pool`,
    { niche: input.niche, status: 'uncontacted' }, 0, 0);
}

/** Live sending progress for a campaign (for the simple UI's progress view). */
export async function quickStatus(db: Database, campaignId: string): Promise<{
  status: string | null; total: number; sent: number; failed: number; pending: number;
}> {
  const camp = (await db.select({ status: schema.campaigns.status })
    .from(schema.campaigns).where(sql`${schema.campaigns.id} = ${campaignId}`).limit(1))[0];
  const rows = await db.select({ state: schema.campaignRecipients.state, n: sql<number>`count(*)::int` })
    .from(schema.campaignRecipients)
    .where(sql`${schema.campaignRecipients.campaignId} = ${campaignId}`)
    .groupBy(schema.campaignRecipients.state);
  let total = 0, sent = 0, failed = 0;
  for (const r of rows) {
    const n = Number(r.n); total += n;
    if (r.state === 'sent') sent += n;
    else if (r.state === 'failed') failed += n;
  }
  return { status: camp?.status ?? null, total, sent, failed, pending: total - sent - failed };
}
