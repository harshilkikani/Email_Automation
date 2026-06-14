/**
 * "Scrape & Send" orchestrator — chains the existing pipeline into one step so
 * the simple UI can scrape a batch of businesses, personalize, and stage a
 * ready-to-send campaign. Sending itself still goes through the normal launch
 * gate + send_batch tick (caps, warmup, suppression all apply).
 */
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { inArray, sql } from 'drizzle-orm';
import { defaultTemplateFor, type Niche } from '@keres/core';
import { runDiscovery } from './discovery.js';
import { personalizeLead } from './personalization.js';
import { createCampaign, buildRecipients, renderPreview } from './campaigns.js';

export interface QuickScrapeInput {
  orgId: string;
  niche: Niche;
  city: string;
  state: string;
  count: number;
}

export interface QuickScrapeResult {
  campaignId: string;
  found: number;          // businesses returned by discovery
  inserted: number;       // new leads added this run (after dedup/filters)
  withEmail: number;      // of those, how many had a scrapeable email (= sendable)
  recipientCount: number; // recipients staged on the campaign
  recipients: Array<{ name: string; city: string | null; email: string | null; opener: string | null }>;
  sample: Awaited<ReturnType<typeof renderPreview>> | null;
}

export async function quickScrape(db: Database, input: QuickScrapeInput): Promise<QuickScrapeResult> {
  /* 1. Discover + scrape sites (captures contact emails into lead.email). */
  const disc = await runDiscovery(db, {
    orgId: input.orgId, niche: input.niche, city: input.city,
    state: input.state, targetCount: Math.max(1, Math.min(input.count, 100)),
  });

  /* 2. Fact-grounded opener per new lead (deterministic; no Ollama needed). */
  for (const id of disc.leadIds) {
    try { await personalizeLead(db, id); } catch { /* best-effort */ }
  }

  /* 3. Stage a campaign targeting exactly this scraped batch. */
  const tpl = defaultTemplateFor(input.niche);
  const today = new Date().toISOString().slice(0, 10);
  const { id: campaignId } = await createCampaign(db, {
    orgId: input.orgId,
    name: `${input.niche} — ${input.city}, ${input.state.toUpperCase()} (${today})`,
    templateKey: tpl.key,
    subjectA: tpl.subjectVariants[0] ?? 'Quick question, {{business}}',
    audienceFilter: { leadIds: disc.leadIds },
  });
  const recipientCount = disc.leadIds.length ? await buildRecipients(db, campaignId) : 0;

  /* 4. Build the review list (+ a rendered sample of the first sendable one). */
  const leads = disc.leadIds.length
    ? await db.select({ id: schema.leads.id, name: schema.leads.name, city: schema.leads.city, email: schema.leads.email })
        .from(schema.leads).where(inArray(schema.leads.id, disc.leadIds))
    : [];
  const openerRows = disc.leadIds.length
    ? await db.select({ leadId: schema.leadSignals.leadId, opener: schema.leadSignals.personalizedOpener })
        .from(schema.leadSignals).where(inArray(schema.leadSignals.leadId, disc.leadIds))
    : [];
  const openerById = new Map(openerRows.map(r => [r.leadId, r.opener]));

  const withEmail = leads.filter(l => l.email);
  const recipients = withEmail.map(l => ({
    name: l.name, city: l.city, email: l.email, opener: openerById.get(l.id) ?? null,
  }));

  let sample: QuickScrapeResult['sample'] = null;
  if (withEmail[0]) {
    try { sample = await renderPreview(db, campaignId, withEmail[0].id); } catch { /* ignore */ }
  }

  return {
    campaignId,
    found: disc.found,
    inserted: disc.inserted,
    withEmail: withEmail.length,
    recipientCount,
    recipients,
    sample,
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
