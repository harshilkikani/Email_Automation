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
import { US_METROS } from '../data/us-metros.js';

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
    { niche: input.niche, city: input.city, state: input.state, status: 'uncontacted', limit: clamp(input.count ?? 15, 1, 100) }, disc.found, disc.inserted);
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

/* Built-in metro sweep list — now ../data/us-metros.ts (all 50 states + DC, ~1,024
   metros). Imported above and re-exported so existing importers keep working. */
export { US_METROS };

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
  const target = clamp(input.count ?? 15, 1, 50);
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
    { niche: input.niche, status: 'uncontacted', limit: target }, found, added);
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
