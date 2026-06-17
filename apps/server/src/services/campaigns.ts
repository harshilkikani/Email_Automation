/**
 * Campaign service: render preview, launch (queue recipients), pause/resume,
 * suppression-aware recipient resolution, validation-stratified builder.
 */
import { and, eq, isNull, inArray, sql, gte } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import {
  bucketFor, REACH_SAMPLE, ENGAGEMENT_SAMPLE, stratifiedSample,
  defaultTemplateFor, renderEmail, pickSignoffName, TEMPLATES, type Template,
} from '@keres/core';
import { finalRender, lintEmail } from '@keres/email';
import { isSendableStatus } from './verify.js';
import { getFocus, recipientPriority } from './focus.js';
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
  sequenceSteps?: number;
  stepDelayDays?: number;
  senderDomainId?: string;
  validationExperimentId?: string;
}

export interface AudienceFilter {
  niche?: string;
  state?: string;
  city?: string;
  minScore?: number;
  status?: 'all' | 'uncontacted' | 'new';
  /** Cap the number of recipients staged (the highest-score leads are kept). */
  limit?: number;
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
    sequenceSteps: Math.max(1, Math.min(input.sequenceSteps ?? 1, 5)),
    stepDelayDays: Math.max(1, Math.min(input.stepDelayDays ?? 3, 30)),
    senderDomainId: input.senderDomainId ?? null,
    validationExperimentId: input.validationExperimentId ?? null,
  }).returning({ id: schema.campaigns.id });
  return { id: row[0]!.id };
}

/** Every email address we've already SENT to (any campaign) — a hard guard so
    no address is ever contacted twice, even if a lead's status update failed. */
async function alreadySentEmails(db: Database, orgId: string): Promise<Set<string>> {
  const rows = await db.select({ email: schema.leads.email })
    .from(schema.emailEvents)
    .innerJoin(schema.leads, eq(schema.leads.id, schema.emailEvents.leadId))
    .where(and(eq(schema.emailEvents.orgId, orgId), eq(schema.emailEvents.eventType, 'send')));
  return new Set(rows.map(r => (r.email ?? '').toLowerCase()).filter(Boolean));
}

/** Every DOMAIN we've already sent to — so we never email two addresses at the
    same company (a different kind of duplicate than the same address twice). */
async function alreadySentDomains(db: Database, orgId: string): Promise<Set<string>> {
  const rows = await db.select({ domain: schema.leads.domain })
    .from(schema.emailEvents)
    .innerJoin(schema.leads, eq(schema.leads.id, schema.emailEvents.leadId))
    .where(and(eq(schema.emailEvents.orgId, orgId), eq(schema.emailEvents.eventType, 'send')));
  return new Set(rows.map(r => (r.domain ?? '').toLowerCase()).filter(Boolean));
}

/** Keep at most one lead per email AND per domain, skipping anything already
    sent — the single choke point that guarantees no duplicate ever gets emailed. */
function pickUncontacted<T extends { id: string; email: string | null; ev: string | null; domain?: string | null }>(
  rows: T[], sentEmails: Set<string>, sentDomains: Set<string>,
): T[] {
  const seenEmail = new Set<string>(), seenDomain = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (!r.email || !isSendableStatus(r.ev)) continue;
    const email = r.email.toLowerCase();
    const domain = (r.domain ?? '').toLowerCase();
    if (sentEmails.has(email) || seenEmail.has(email)) continue;
    if (domain && (sentDomains.has(domain) || seenDomain.has(domain))) continue;
    seenEmail.add(email); if (domain) seenDomain.add(domain);
    out.push(r);
  }
  return out;
}

export async function resolveAudience(
  db: Database, orgId: string, filter: AudienceFilter,
): Promise<{ leadIds: string[]; bucketByLeadId: Record<string, string | null> }> {
  const [sent, sentDomains] = await Promise.all([alreadySentEmails(db, orgId), alreadySentDomains(db, orgId)]);
  if (filter.leadIds && filter.leadIds.length > 0) {
    /* Even an explicit lead list only emails verified, not-yet-emailed, deduped addresses. */
    const rows = await db.select({ id: schema.leads.id, email: schema.leads.email, ev: schema.leads.emailVerificationStatus, domain: schema.leads.domain })
      .from(schema.leads).where(inArray(schema.leads.id, filter.leadIds));
    const buckets: Record<string, string | null> = {};
    const idList: string[] = [];
    for (const r of pickUncontacted(rows, sent, sentDomains)) { buckets[r.id] = null; idList.push(r.id); }
    return { leadIds: idList, bucketByLeadId: buckets };
  }
  const conds = [eq(schema.leads.orgId, orgId), isNull(schema.leads.deletedAt), eq(schema.leads.disqualified, false)];
  if (filter.niche) conds.push(eq(schema.leads.niche, filter.niche));
  if (filter.state) conds.push(eq(schema.leads.state, filter.state.toUpperCase().slice(0, 2)));
  if (filter.city)  conds.push(eq(schema.leads.city, filter.city));
  if (filter.minScore !== undefined) conds.push(gte(schema.leads.score, filter.minScore));
  if (filter.status === 'uncontacted') conds.push(inArray(schema.leads.status, ['new', 'uncontacted']));
  else if (filter.status === 'new') conds.push(eq(schema.leads.status, 'new'));

  const rows = await db.select({ id: schema.leads.id, score: schema.leads.score, email: schema.leads.email, ev: schema.leads.emailVerificationStatus, domain: schema.leads.domain })
    .from(schema.leads)
    .where(and(...conds));

  const withEmail = pickUncontacted(rows, sent, sentDomains);

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
  /* Honor a batch cap: keep the highest-score leads so "send to N" means N best,
     not the whole pool. Without this the niche/status filter stages everything. */
  let selected = withEmail;
  if (filter.limit && filter.limit > 0 && selected.length > filter.limit) {
    selected = [...selected].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, filter.limit);
  }
  const buckets: Record<string, string | null> = {};
  for (const r of selected) buckets[r.id] = bucketFor(r.score);
  return { leadIds: selected.map(r => r.id), bucketByLeadId: buckets };
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
    status: schema.leads.status, score: schema.leads.score, niche: schema.leads.niche,
  }).from(schema.leads).where(inArray(schema.leads.id, audience.leadIds));
  const focusNiches = await getFocus(db, camp.orgId);

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
  const recipientRows = leads.filter(l => {
    if (!l.email) return false;
    if (['bounced', 'unsubscribed', 'dnc'].includes(l.status)) return false;
    if (suppressedEmails.has(l.email.toLowerCase())) return false;
    if (l.dedupDomain && suppressedDomains.has(l.dedupDomain.toLowerCase())) return false;
    return true;
  }).map(l => ({
    orgId: camp.orgId,
    campaignId,
    leadId: l.id,
    priority: recipientPriority(l.score, l.niche, focusNiches),
    bucket: (audience.bucketByLeadId[l.id] ?? null) as string | null,
    state: 'pending' as const,
  }));

  const CHUNK = 500;
  for (let i = 0; i < recipientRows.length; i += CHUNK) {
    await db.insert(schema.campaignRecipients)
      .values(recipientRows.slice(i, i + CHUNK))
      .onConflictDoNothing({ target: [schema.campaignRecipients.campaignId, schema.campaignRecipients.leadId] });
  }
  let inserted = recipientRows.length;

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

  const cfg = getConfig();
  /* Match what sender-pipeline actually sends: rotated persona + cached opener. */
  const persona = pickSignoffName(leadId, cfg.org.signoffNames) ?? org.fromName ?? cfg.org.fromName;
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
    fromName: persona,
    fromSignoff: org.name,
    opener: signals?.personalizedOpener ?? undefined,
    body: signals?.personalizedBody ?? undefined,
    /* Use the campaign's own subjects (e.g. offer subjects) so the preview matches
       what sender-pipeline actually sends, not the niche template default. */
    subjectOverrides: [camp.subjectA, camp.subjectB].filter((s): s is string => !!s && s.trim().length > 0),
  });

  const finalOut = finalRender({
    rendered,
    to: lead.email ?? '',
    leadEmail: lead.email ?? '',
    orgScopeKey: camp.orgId,
    campaignId: camp.id,
    identity: {
      fromName: persona,
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
  /* Mirror the launch gate: when the campaign has no explicit sender domain,
     fall back to the org's first registered domain so the same DNS/warmup
     checks apply (otherwise auto-pause would block every quick campaign with
     `no_sender_domain`). */
  const domain = (camp.senderDomainId
    ? (await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.id, camp.senderDomainId)).limit(1))[0]
    : (await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.orgId, camp.orgId)).limit(1))[0]) ?? null;

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
    requireSesProductionAccess: getConfig().ses.enabled,
  } as GateInput);
}
