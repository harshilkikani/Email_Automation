/**
 * Campaign service: render preview, launch (queue recipients), pause/resume,
 * suppression-aware recipient resolution, validation-stratified builder.
 */
import { and, eq, isNull, inArray, sql, gte } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import {
  bucketFor, REACH_SAMPLE, ENGAGEMENT_SAMPLE, stratifiedSample,
  defaultTemplateFor, renderEmail, TEMPLATES, type Template,
} from '@keres/core';
import { finalRender, lintEmail } from '@keres/email';
import { getConfig } from '../config.js';
import { canSend, type GateInput, type GateResult } from './gates.js';

export interface CampaignDraftInput {
  orgId: string;
  name: string;
  kind?: 'standard' | 'validation_reach' | 'validation_engagement' | 'validation_refine';
  templateKey: string;
  subjectA?: string;
  subjectB?: string;
  audienceFilter: AudienceFilter;
  senderDomainId?: string;
  validationExperimentId?: string;
}

export interface AudienceFilter {
  niche?: string;
  state?: string;
  city?: string;
  minScore?: number;
  status?: 'all' | 'uncontacted' | 'new';
  leadIds?: string[];
  stratified?: keyof typeof REACH_SAMPLE | keyof typeof ENGAGEMENT_SAMPLE | 'reach' | 'engagement';
  insertSeedlist?: boolean;
}

export async function createCampaign(db: Database, input: CampaignDraftInput): Promise<{ id: string }> {
  const row = await db.insert(schema.campaigns).values({
    orgId: input.orgId,
    name: input.name,
    kind: input.kind ?? 'standard',
    templateKey: input.templateKey,
    subjectA: input.subjectA ?? '',
    subjectB: input.subjectB ?? null,
    audienceFilter: input.audienceFilter as unknown as Record<string, unknown>,
    senderDomainId: input.senderDomainId ?? null,
    validationExperimentId: input.validationExperimentId ?? null,
  }).returning({ id: schema.campaigns.id });
  return { id: row[0]!.id };
}

export async function resolveAudience(
  db: Database, orgId: string, filter: AudienceFilter,
): Promise<{ leadIds: string[]; bucketByLeadId: Record<string, string | null> }> {
  if (filter.leadIds && filter.leadIds.length > 0) {
    const buckets: Record<string, string | null> = {};
    for (const id of filter.leadIds) buckets[id] = null;
    return { leadIds: filter.leadIds, bucketByLeadId: buckets };
  }
  const conds = [eq(schema.leads.orgId, orgId), isNull(schema.leads.deletedAt), eq(schema.leads.disqualified, false)];
  if (filter.niche) conds.push(eq(schema.leads.niche, filter.niche));
  if (filter.state) conds.push(eq(schema.leads.state, filter.state.toUpperCase().slice(0, 2)));
  if (filter.city)  conds.push(eq(schema.leads.city, filter.city));
  if (filter.minScore !== undefined) conds.push(gte(schema.leads.score, filter.minScore));
  if (filter.status === 'uncontacted') conds.push(inArray(schema.leads.status, ['new', 'uncontacted']));
  else if (filter.status === 'new') conds.push(eq(schema.leads.status, 'new'));

  const rows = await db.select({ id: schema.leads.id, score: schema.leads.score, email: schema.leads.email })
    .from(schema.leads)
    .where(and(...conds));

  const withEmail = rows.filter(r => r.email);

  if (filter.stratified === 'reach' || filter.stratified === 'engagement') {
    const spec = filter.stratified === 'reach' ? REACH_SAMPLE : ENGAGEMENT_SAMPLE;
    const sample = stratifiedSample(withEmail.map(r => ({ id: r.id, score: r.score })), spec);
    const buckets: Record<string, string | null> = {};
    const idList: string[] = [];
    for (const b of ['top', 'mid', 'bottom', 'control'] as const) {
      for (const l of sample[b]) { buckets[l.id] = b; idList.push(l.id); }
    }
    return { leadIds: idList, bucketByLeadId: buckets };
  }
  const buckets: Record<string, string | null> = {};
  for (const r of withEmail) buckets[r.id] = bucketFor(r.score);
  return { leadIds: withEmail.map(r => r.id), bucketByLeadId: buckets };
}

export async function buildRecipients(db: Database, campaignId: string): Promise<number> {
  const camp = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1))[0];
  if (!camp) throw new Error('campaign_not_found');
  const filter = (camp.audienceFilter ?? {}) as AudienceFilter;
  const audience = await resolveAudience(db, camp.orgId, filter);
  if (audience.leadIds.length === 0) return 0;

  /* Exclude suppressed (email or domain). */
  const leads = await db.select({
    id: schema.leads.id, email: schema.leads.email, dedupDomain: schema.leads.dedupDomain,
    status: schema.leads.status, score: schema.leads.score,
  }).from(schema.leads).where(inArray(schema.leads.id, audience.leadIds));

  const suppressedEmails = new Set<string>();
  const suppressedDomains = new Set<string>();
  const supRows = await db.select({ email: schema.suppressions.email, domain: schema.suppressions.domain })
    .from(schema.suppressions)
    .where(sql`${schema.suppressions.scopeKey} IN (${camp.orgId}, 'GLOBAL')`);
  for (const s of supRows) {
    if (s.email) suppressedEmails.add(s.email.toLowerCase());
    if (s.domain) suppressedDomains.add(s.domain.toLowerCase());
  }

  /* Bulk insert recipients, skipping suppression / non-contactable status. */
  let inserted = 0;
  for (const l of leads) {
    if (!l.email) continue;
    if (['bounced', 'unsubscribed', 'dnc'].includes(l.status)) continue;
    if (suppressedEmails.has(l.email.toLowerCase())) continue;
    if (l.dedupDomain && suppressedDomains.has(l.dedupDomain.toLowerCase())) continue;
    await db.insert(schema.campaignRecipients).values({
      orgId: camp.orgId, campaignId, leadId: l.id,
      bucket: audience.bucketByLeadId[l.id] ?? null,
      state: 'pending',
    }).onConflictDoNothing({ target: [schema.campaignRecipients.campaignId, schema.campaignRecipients.leadId] });
    inserted++;
  }

  /* Seedlist insertion for validation campaigns. */
  if (filter.insertSeedlist || camp.kind !== 'standard') {
    for (const email of getConfig().seedlistEmails) {
      const placeholderLeadId = await ensureSeedLead(db, camp.orgId, email);
      await db.insert(schema.campaignRecipients).values({
        orgId: camp.orgId, campaignId, leadId: placeholderLeadId,
        bucket: 'seedlist', state: 'pending',
      }).onConflictDoNothing({ target: [schema.campaignRecipients.campaignId, schema.campaignRecipients.leadId] });
      inserted++;
    }
  }

  await db.update(schema.campaigns)
    .set({ recipientCount: inserted })
    .where(eq(schema.campaigns.id, campaignId));
  return inserted;
}

async function ensureSeedLead(db: Database, orgId: string, email: string): Promise<string> {
  const existing = await db.select({ id: schema.leads.id })
    .from(schema.leads)
    .where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.email, email)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await db.insert(schema.leads).values({
    orgId, name: `Seed: ${email}`, email,
    niche: 'Septic', source: 'seedlist',
    status: 'uncontacted', score: 100,
  }).returning({ id: schema.leads.id });
  return inserted[0]!.id;
}

export async function renderPreview(db: Database, campaignId: string, leadId: string): Promise<{
  subject: string;
  body: string;
  unsubscribeUrl: string;
  rawMessage: string;
  lint: ReturnType<typeof lintEmail>;
}> {
  const camp = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1))[0];
  if (!camp) throw new Error('campaign_not_found');
  const org = (await db.select().from(schema.organizations).where(eq(schema.organizations.id, camp.orgId)).limit(1))[0];
  if (!org) throw new Error('org_not_found');
  const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1))[0];
  if (!lead) throw new Error('lead_not_found');
  const signals = (await db.select().from(schema.leadSignals).where(eq(schema.leadSignals.leadId, leadId)).limit(1))[0];

  const tpl: Template = TEMPLATES[camp.templateKey] ?? defaultTemplateFor(lead.niche as 'Septic');
  const rendered = renderEmail(tpl, {
    leadId,
    business: lead.name,
    city: lead.city ?? '',
    signals: {
      webPresenceLevel: (signals?.webPresenceLevel ?? 'unknown') as 'unknown',
      isStormZone: signals?.isStormZone ?? false,
      niche: lead.niche as 'Septic',
      hasOnlineBooking: signals?.hasOnlineBooking ?? false,
    },
    fromName: org.fromName ?? getConfig().org.fromName,
    fromSignoff: org.name,
  });

  const cfg = getConfig();
  const finalOut = finalRender({
    rendered,
    to: lead.email ?? '',
    leadEmail: lead.email ?? '',
    orgScopeKey: camp.orgId,
    campaignId: camp.id,
    identity: {
      fromName: org.fromName ?? cfg.org.fromName,
      fromEmail: org.fromEmail ?? cfg.org.fromEmail,
      replyTo: org.replyTo ?? cfg.org.replyTo,
      unsubMailto: org.replyTo ?? cfg.org.replyTo,
      publicBaseUrl: cfg.publicBaseUrl,
      physicalAddress: org.physicalAddress ?? cfg.org.physicalAddress,
      orgName: org.name,
    },
    signingSecret: cfg.unsubscribeSigningSecret,
    messageId: `<preview-${campaignId}-${leadId}@${cfg.org.outreachSubdomain}>`,
  });

  const lint = lintEmail({
    subject: finalOut.subject,
    body: finalOut.bodyWithFooter,
    recipientCount: camp.recipientCount,
    identityHasPhysicalAddress: !!org.physicalAddress,
    unsubscribeUrlPresent: finalOut.bodyWithFooter.includes(finalOut.unsubscribeUrl),
    canSpamFooterPresent: finalOut.bodyWithFooter.includes('Unsubscribe (one click)'),
  });

  return {
    subject: finalOut.subject,
    body: finalOut.bodyWithFooter,
    unsubscribeUrl: finalOut.unsubscribeUrl,
    rawMessage: finalOut.rawMessage,
    lint,
  };
}

export interface LaunchGateContext {
  bouncePausePct: number;
  complaintPausePct: number;
}

export async function gateCampaign(db: Database, campaignId: string, ctx: LaunchGateContext): Promise<GateResult> {
  const camp = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1))[0];
  if (!camp) return { ok: false, blockers: [{ code: 'no_campaign', message: 'Campaign not found' }], warnings: [] };
  const org = (await db.select().from(schema.organizations).where(eq(schema.organizations.id, camp.orgId)).limit(1))[0];
  if (!org) return { ok: false, blockers: [{ code: 'no_org', message: 'Org not found' }], warnings: [] };
  const domain = camp.senderDomainId
    ? (await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.id, camp.senderDomainId)).limit(1))[0] ?? null
    : null;

  /* Last-24h stats from email_events. */
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const events = await db.select({
    type: schema.emailEvents.eventType, count: sql<number>`count(*)::int`,
  })
    .from(schema.emailEvents)
    .where(and(
      eq(schema.emailEvents.orgId, camp.orgId),
      gte(schema.emailEvents.occurredAt, since),
    ))
    .groupBy(schema.emailEvents.eventType);

  const stats = { sent: 0, bounced: 0, complained: 0 };
  for (const e of events) {
    if (e.type === 'send') stats.sent += Number(e.count);
    if (e.type === 'bounce') stats.bounced += Number(e.count);
    if (e.type === 'complaint') stats.complained += Number(e.count);
  }

  return canSend({
    org, domain: domain as GateInput['domain'], campaign: camp,
    stats,
    bouncePausePct: ctx.bouncePausePct,
    complaintPausePct: ctx.complaintPausePct,
    unsubscribeReachable: domain?.unsubReachable ?? true,
  } as GateInput);
}
