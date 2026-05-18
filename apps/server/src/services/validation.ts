/**
 * Validation Mode services:
 *  - create experiment
 *  - record review (A/B/C/D) for an eyeball experiment
 *  - build stratified validation campaign
 *  - compute current results vs kill-criteria
 */
import { and, eq, sql, inArray } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import {
  bucketFor, eyeballVerdict, reachVerdict, engagementVerdict,
  REACH_SAMPLE, ENGAGEMENT_SAMPLE, stratifiedSample, computeLift,
  type Niche, type Rating,
} from '@keres/core';
import { createCampaign, buildRecipients } from './campaigns.js';

export interface CreateExperimentInput {
  orgId: string;
  name: string;
  phase: 'eyeball' | 'reach' | 'engagement' | 'refine';
  niche: Niche;
  cities: string[];
  templateKey?: string;
}

export async function createExperiment(db: Database, input: CreateExperimentInput): Promise<{ id: string }> {
  const r = await db.insert(schema.validationExperiments).values({
    orgId: input.orgId, name: input.name, phase: input.phase,
    niche: input.niche, cities: input.cities, templateKey: input.templateKey ?? null,
    status: 'running',
  }).returning({ id: schema.validationExperiments.id });
  return { id: r[0]!.id };
}

export async function recordReview(db: Database, experimentId: string, leadId: string, rating: Rating, reasonTags: string[] = [], notes?: string): Promise<void> {
  const e = (await db.select().from(schema.validationExperiments).where(eq(schema.validationExperiments.id, experimentId)).limit(1))[0];
  if (!e) throw new Error('experiment_not_found');
  await db.insert(schema.validationReviews).values({
    orgId: e.orgId, experimentId, leadId, rating, reasonTags, notes: notes ?? null,
  }).onConflictDoUpdate({
    target: [schema.validationReviews.experimentId, schema.validationReviews.leadId],
    set: { rating, reasonTags, notes: notes ?? null, reviewedAt: new Date() },
  });
}

export async function eyeballSummary(db: Database, experimentId: string) {
  const reviews = await db.select({ rating: schema.validationReviews.rating })
    .from(schema.validationReviews)
    .where(eq(schema.validationReviews.experimentId, experimentId));
  const verdict = eyeballVerdict(reviews.map(r => r.rating as Rating));
  return verdict;
}

export interface BuildStratifiedInput {
  orgId: string;
  experimentId: string;
  templateKey: string;
  size: 'reach' | 'engagement';
  senderDomainId?: string;
}

export async function buildStratifiedCampaign(db: Database, input: BuildStratifiedInput): Promise<{ campaignId: string; recipientCount: number }> {
  const exp = (await db.select().from(schema.validationExperiments).where(eq(schema.validationExperiments.id, input.experimentId)).limit(1))[0];
  if (!exp) throw new Error('experiment_not_found');

  const { id } = await createCampaign(db, {
    orgId: input.orgId,
    name: `${exp.name} — ${input.size}`,
    kind: input.size === 'reach' ? 'validation_reach' : 'validation_engagement',
    templateKey: input.templateKey,
    subjectA: '',
    audienceFilter: {
      niche: exp.niche,
      stratified: input.size,
      insertSeedlist: true,
    },
    senderDomainId: input.senderDomainId,
    validationExperimentId: input.experimentId,
  });
  const recipientCount = await buildRecipients(db, id);
  await db.update(schema.validationExperiments).set({ campaignId: id }).where(eq(schema.validationExperiments.id, input.experimentId));
  return { campaignId: id, recipientCount };
}

export async function experimentResults(db: Database, experimentId: string) {
  const e = (await db.select().from(schema.validationExperiments).where(eq(schema.validationExperiments.id, experimentId)).limit(1))[0];
  if (!e) throw new Error('experiment_not_found');
  if (!e.campaignId) return null;
  const ev = await db.select({
    type: schema.emailEvents.eventType, count: sql<number>`count(*)::int`,
  })
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.campaignId, e.campaignId))
    .groupBy(schema.emailEvents.eventType);
  const bucketStats = await db.select({
    bucket: schema.campaignRecipients.bucket,
    state: schema.campaignRecipients.state,
    count: sql<number>`count(*)::int`,
  })
    .from(schema.campaignRecipients)
    .where(eq(schema.campaignRecipients.campaignId, e.campaignId))
    .groupBy(schema.campaignRecipients.bucket, schema.campaignRecipients.state);

  const stats = {
    sent: ev.find(x => x.type === 'send')?.count ?? 0,
    delivered: ev.find(x => x.type === 'delivered')?.count ?? 0,
    bounced: ev.find(x => x.type === 'bounce')?.count ?? 0,
    complaints: ev.find(x => x.type === 'complaint')?.count ?? 0,
    replies: ev.find(x => x.type === 'reply')?.count ?? 0,
    inboxPlacement: 1,                   // seedlist UI sets this manually for now
  };

  const byBucketEmpty = { top: { sent: 0, replied: 0, qualified: 0 }, mid: { sent: 0, replied: 0, qualified: 0 }, bottom: { sent: 0, replied: 0, qualified: 0 }, control: { sent: 0, replied: 0, qualified: 0 } };
  const byBucket = byBucketEmpty;
  for (const row of bucketStats) {
    const b = row.bucket as 'top' | 'mid' | 'bottom' | 'control' | 'seedlist' | null;
    if (b === null || b === 'seedlist') continue;
    if (row.state === 'sent' || row.state === 'delivered' || row.state === 'replied' || row.state === 'bounced' || row.state === 'complained') byBucket[b].sent += row.count;
    if (row.state === 'replied') byBucket[b].replied += row.count;
  }

  /* Qualified count per bucket via inbound_messages join. */
  const qualifiedRows = await db.select({
    bucket: schema.campaignRecipients.bucket,
    intent: schema.inboundMessages.autoIntent,
    count: sql<number>`count(*)::int`,
  })
    .from(schema.inboundMessages)
    .innerJoin(schema.campaignRecipients, eq(schema.campaignRecipients.id, schema.inboundMessages.recipientId))
    .where(eq(schema.campaignRecipients.campaignId, e.campaignId))
    .groupBy(schema.campaignRecipients.bucket, schema.inboundMessages.autoIntent);
  for (const q of qualifiedRows) {
    const b = q.bucket as 'top' | 'mid' | 'bottom' | 'control' | 'seedlist' | null;
    if (b === null || b === 'seedlist') continue;
    if (q.intent === 'interested' || q.intent === 'conditional' || q.intent === 'referral') byBucket[b].qualified += q.count;
  }

  const verdict = e.phase === 'reach'
    ? reachVerdict({ ...stats, byBucket })
    : e.phase === 'engagement'
    ? engagementVerdict({ ...stats, byBucket })
    : null;

  return { experiment: e, stats: { ...stats, byBucket }, verdict };
}
