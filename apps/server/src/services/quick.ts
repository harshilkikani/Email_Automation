/**
 * "Scrape & Send" orchestrator — chains the existing pipeline into one step so
 * the simple UI can scrape a batch of businesses, personalize, and stage a
 * ready-to-send campaign. Sending itself still goes through the normal launch
 * gate + send_batch tick (caps, warmup, suppression all apply).
 */
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { defaultTemplateFor, type Niche } from '@keres/core';
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
    subjectA: tpl.subjectVariants[0] ?? 'Quick question, {{business}}',
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
