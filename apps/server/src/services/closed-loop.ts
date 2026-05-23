/**
 * Closed-loop scoring service — wires the pure logic in `@keres/core`
 * (`closed-loop.ts`) up to the database.
 *
 * Daily flow:
 *   1. aggregateSignalOutcomes() walks campaign_recipients ⨝ leads ⨝
 *      lead_signals ⨝ inbound_messages over the rolling window and upserts
 *      signal_outcomes rows.
 *   2. proposeScoringChanges() reads the current scoring_versions head,
 *      asks core.proposeWeightChanges, and writes a scoring_proposals row.
 *   3. applyScoringProposal() (operator-triggered or auto if --auto-apply)
 *      writes the next scoring_versions row + audit event + marks the
 *      proposal applied.
 */
import { and, eq, sql, desc, max, inArray } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import {
  proposeWeightChanges, snapshotSignals,
  type SignalOutcomeAggregate, type Proposal,
  type LeadSignalSnapshot,
  DEFAULT_PROPOSAL_OPTIONS,
} from '@keres/core';
import type { ScoringVersion } from '@keres/core';
import { writeAudit } from './audit.js';
import { withSpan, obs } from '../observability.js';
import { getConfig } from '../config.js';

const DEFAULT_WINDOW_DAYS = 30;

/* ────────── Aggregation ────────── */

interface RecipientRow {
  recipientId: string;
  leadId: string;
  state: string;
  bounced: boolean;
  complained: boolean;
  unsubscribed: boolean;
  replied: boolean;
  qualified: boolean;
  isWon: boolean;
  wonRevenueUsd: number | null;
  niche: string;
  webPresenceLevel: string | null;
  hasPhone: boolean | null;
  phoneLineType: string | null;
  hasOnlineBooking: boolean | null;
  isStormZone: boolean | null;
  licenseStatus: string | null;
  reviewCount30d: number | null;
  competitorDensity: number | null;
  ownerOperator: boolean | null;
  serviceDispatchModel: boolean | null;
  emergencyNiche: boolean | null;
  multiLocation: boolean | null;
  deadDomain: boolean | null;
}

const QUALIFIED_INTENTS = new Set(['interested', 'conditional', 'referral']);
const SENT_STATES = new Set(['sent', 'delivered', 'replied', 'bounced', 'complained']);

export async function aggregateSignalOutcomes(
  db: Database,
  orgId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<{ written: number; windowEndDate: string }> {
  return withSpan('closed_loop.aggregate', async () => {
    const windowEnd = new Date(); windowEnd.setUTCHours(0, 0, 0, 0);
    const windowStart = new Date(windowEnd.getTime() - windowDays * 86400 * 1000);
    const windowEndDate = windowEnd.toISOString().slice(0, 10);

    /* Pull the recipient × lead × signal × inbound join we need. The join
       to inbound_messages is LEFT OUTER so non-repliers count too. Revenue
       from won deals is joined via reply_branch_states. */
    const res = await db.execute(sql`
      SELECT
        cr.id              AS "recipientId",
        cr.lead_id         AS "leadId",
        cr.state           AS "state",
        (cr.state = 'bounced')                                                  AS "bounced",
        (cr.state = 'complained')                                               AS "complained",
        EXISTS(SELECT 1 FROM email_events ee
               WHERE ee.recipient_id = cr.id AND ee.event_type = 'unsubscribe') AS "unsubscribed",
        (cr.replied_at IS NOT NULL)                                             AS "replied",
        (
          coalesce(im.manual_intent, im.auto_intent) IN ('interested','conditional','referral')
        )                                                                       AS "qualified",
        (rbs.node = 'won')                                                      AS "isWon",
        rbs.won_revenue_usd                                                     AS "wonRevenueUsd",
        l.niche                                                                 AS "niche",
        s.web_presence_level                                                    AS "webPresenceLevel",
        s.has_phone                                                             AS "hasPhone",
        s.phone_line_type                                                       AS "phoneLineType",
        s.has_online_booking                                                    AS "hasOnlineBooking",
        s.is_storm_zone                                                         AS "isStormZone",
        s.license_status                                                        AS "licenseStatus",
        s.review_count_30d                                                      AS "reviewCount30d",
        s.competitor_density                                                    AS "competitorDensity",
        s.owner_operator_heuristic                                              AS "ownerOperator",
        s.service_dispatch_model                                                AS "serviceDispatchModel",
        s.emergency_niche                                                       AS "emergencyNiche",
        s.multi_location                                                        AS "multiLocation",
        s.dead_domain                                                           AS "deadDomain"
      FROM campaign_recipients cr
      JOIN leads l ON l.id = cr.lead_id
      LEFT JOIN lead_signals s ON s.lead_id = l.id
      LEFT JOIN inbound_messages im ON im.recipient_id = cr.id
      LEFT JOIN reply_branch_states rbs ON rbs.lead_id = l.id AND rbs.node = 'won'
      WHERE l.org_id = ${orgId}
        AND cr.first_sent_at >= ${windowStart.toISOString()}
        AND cr.first_sent_at < ${windowEnd.toISOString()}
    `);
    const rows = ((res as unknown as { rows?: RecipientRow[] }).rows ?? (res as unknown as RecipientRow[])) as RecipientRow[];

    /* Bucket by (signalKey, signalValue). Revenue from won deals is accumulated
       per bucket so high-revenue signals get upweighted in proposals. */
    type Bucket = Omit<SignalOutcomeAggregate, 'signalKey' | 'signalValue'> & { key: string; value: string; nWon: number; totalRevenueUsd: number };
    const buckets = new Map<string, Bucket>();
    for (const r of rows) {
      const snap: LeadSignalSnapshot = {
        niche: r.niche as LeadSignalSnapshot['niche'],
        webPresenceLevel: (r.webPresenceLevel ?? 'unknown') as LeadSignalSnapshot['webPresenceLevel'],
        hasPhone: !!r.hasPhone,
        phoneLineType: r.phoneLineType,
        hasOnlineBooking: !!r.hasOnlineBooking,
        isStormZone: !!r.isStormZone,
        licenseStatus: r.licenseStatus,
        reviewCount30d: r.reviewCount30d ?? null,
        competitorDensity: r.competitorDensity ?? null,
        ownerOperator: !!r.ownerOperator,
        serviceDispatchModel: !!r.serviceDispatchModel,
        emergencyNiche: !!r.emergencyNiche,
        multiLocation: !!r.multiLocation,
        deadDomain: !!r.deadDomain,
      };
      const signals = snapshotSignals(snap);
      for (const sig of signals) {
        const k = `${sig.key}:${sig.value}`;
        if (!buckets.has(k)) {
          buckets.set(k, {
            key: sig.key, value: sig.value,
            nObservations: 0, nSent: 0, nReplied: 0, nQualified: 0,
            nBounced: 0, nComplained: 0, nUnsubscribed: 0,
            nWon: 0, totalRevenueUsd: 0,
          });
        }
        const b = buckets.get(k)!;
        b.nObservations++;
        if (SENT_STATES.has(r.state)) b.nSent++;
        if (r.replied) b.nReplied++;
        if (r.qualified) b.nQualified++;
        if (r.bounced) b.nBounced++;
        if (r.complained) b.nComplained++;
        if (r.unsubscribed) b.nUnsubscribed++;
        if (r.isWon) { b.nWon++; b.totalRevenueUsd += r.wonRevenueUsd ?? 0; }
      }
    }

    /* Upsert into signal_outcomes. Lift values are computed at proposal time
       against the within-key cohort, so we leave the columns null here and
       fill them when we propose. */
    let written = 0;
    for (const b of buckets.values()) {
      await db.insert(schema.signalOutcomes).values({
        orgId,
        signalKey: b.key, signalValue: b.value,
        windowDays, windowEndDate,
        nObservations: b.nObservations,
        nSent: b.nSent, nReplied: b.nReplied, nQualified: b.nQualified,
        nBounced: b.nBounced, nComplained: b.nComplained, nUnsubscribed: b.nUnsubscribed,
        nWon: b.nWon, totalRevenueUsd: b.totalRevenueUsd,
        liftReply: null, liftQualified: null,
      }).onConflictDoUpdate({
        target: [
          schema.signalOutcomes.orgId,
          schema.signalOutcomes.signalKey,
          schema.signalOutcomes.signalValue,
          schema.signalOutcomes.windowDays,
          schema.signalOutcomes.windowEndDate,
        ],
        set: {
          nObservations: b.nObservations,
          nSent: b.nSent, nReplied: b.nReplied, nQualified: b.nQualified,
          nBounced: b.nBounced, nComplained: b.nComplained, nUnsubscribed: b.nUnsubscribed,
          nWon: b.nWon, totalRevenueUsd: b.totalRevenueUsd,
          computedAt: new Date(),
        },
      });
      written++;
    }
    obs().meter.gauge('closed_loop_signal_outcomes_total', written, { window_days: windowDays });
    return { written, windowEndDate };
  }, { org_id: orgId, window_days: windowDays });
}

/* ────────── Proposal generation ────────── */

export async function proposeScoringChanges(
  db: Database,
  orgId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<{ proposalId: string | null; proposal: Proposal }> {
  return withSpan('closed_loop.propose', async () => {
    const maxEnd = await db
      .select({ d: max(schema.signalOutcomes.windowEndDate) })
      .from(schema.signalOutcomes)
      .where(and(
        eq(schema.signalOutcomes.orgId, orgId),
        eq(schema.signalOutcomes.windowDays, windowDays),
      ));
    const windowEndDate = maxEnd[0]?.d ?? null;
    if (!windowEndDate) {
      return { proposalId: null, proposal: emptyProposal() };
    }
    const rows = await db.select().from(schema.signalOutcomes).where(and(
      eq(schema.signalOutcomes.orgId, orgId),
      eq(schema.signalOutcomes.windowDays, windowDays),
      eq(schema.signalOutcomes.windowEndDate, windowEndDate),
    ));
    const aggregates: SignalOutcomeAggregate[] = rows.map(r => ({
      signalKey: r.signalKey,
      signalValue: r.signalValue,
      nObservations: r.nObservations,
      nSent: r.nSent, nReplied: r.nReplied, nQualified: r.nQualified,
      nBounced: r.nBounced, nComplained: r.nComplained, nUnsubscribed: r.nUnsubscribed,
    }));

    const baseVersion = await loadCurrentScoringVersion(db, orgId);
    const proposal = proposeWeightChanges(aggregates, baseVersion, DEFAULT_PROPOSAL_OPTIONS);
    if (proposal.evidence.length === 0) {
      return { proposalId: null, proposal };
    }

    /* Skip if an identical pending proposal already exists. */
    const existing = await db.select({ id: schema.scoringProposals.id }).from(schema.scoringProposals)
      .where(and(
        eq(schema.scoringProposals.orgId, orgId),
        eq(schema.scoringProposals.status, 'pending'),
        eq(schema.scoringProposals.baseVersionId, baseVersion.id),
      ));
    if (existing.length > 0) {
      return { proposalId: existing[0]!.id, proposal };
    }

    const inserted = await db.insert(schema.scoringProposals).values({
      orgId,
      baseVersionId: baseVersion.id,
      deltas: proposal.deltas as Record<string, number>,
      evidence: { rows: proposal.evidence, windowDays, windowEndDate },
      status: 'pending',
      notes: `Auto-generated from ${proposal.evidence.length} signals in window ${windowEndDate} (${windowDays}d).`,
    }).returning({ id: schema.scoringProposals.id });

    obs().meter.counter('closed_loop_proposals_created');
    return { proposalId: inserted[0]?.id ?? null, proposal };
  }, { org_id: orgId, window_days: windowDays });
}

/* ────────── Apply ────────── */

export async function applyScoringProposal(
  db: Database,
  proposalId: string,
  actor: { reason?: string },
): Promise<{ ok: true; newVersionId: number } | { ok: false; error: string }> {
  const prop = (await db.select().from(schema.scoringProposals)
    .where(eq(schema.scoringProposals.id, proposalId)).limit(1))[0];
  if (!prop) return { ok: false, error: 'not_found' };
  if (prop.status !== 'pending') return { ok: false, error: 'not_pending' };

  const baseVersion = await loadCurrentScoringVersion(db, prop.orgId);
  if (baseVersion.id !== prop.baseVersionId) {
    /* Mark as superseded — the base version moved while it was pending. */
    await db.update(schema.scoringProposals)
      .set({ status: 'superseded', notes: `Base version moved from ${prop.baseVersionId} to ${baseVersion.id}.` })
      .where(eq(schema.scoringProposals.id, proposalId));
    return { ok: false, error: 'superseded' };
  }

  /* Re-derive the next ScoringVersion server-side rather than trusting the
     cached one. Same evidence the proposal stored. */
  const ev = prop.evidence as { rows?: Array<{ signalKey: string; signalValue: string }>; windowDays?: number; windowEndDate?: string };
  const aggregateKeys = (ev.rows ?? []).map(r => `${r.signalKey}:${r.signalValue}`);
  const aggregates = await loadAggregatesByKey(db, prop.orgId, ev.windowDays ?? DEFAULT_WINDOW_DAYS, ev.windowEndDate ?? null, aggregateKeys);
  const recomputed = proposeWeightChanges(aggregates, baseVersion, DEFAULT_PROPOSAL_OPTIONS);
  if (!recomputed.nextVersion) {
    return { ok: false, error: 'no_next_version' };
  }

  const newId = baseVersion.id + 1;
  await db.insert(schema.scoringVersions).values({
    id: newId,
    orgId: prop.orgId,
    weights: recomputed.nextVersion.weights as unknown as Record<string, unknown>,
    notes: `Closed-loop proposal ${proposalId}. ${actor.reason ?? ''}`.trim(),
    measuredLift: { evidence: recomputed.evidence } as unknown as Record<string, unknown>,
  });
  await db.update(schema.scoringProposals).set({
    status: 'applied', appliedVersionId: newId, appliedAt: new Date(),
  }).where(eq(schema.scoringProposals.id, proposalId));
  await writeAudit('scoring_proposal_applied', proposalId, {
    fromVersion: baseVersion.id, toVersion: newId,
    deltas: prop.deltas, reason: actor.reason ?? '',
  });
  obs().meter.counter('closed_loop_proposals_applied');
  return { ok: true, newVersionId: newId };
}

export async function rejectScoringProposal(
  db: Database,
  proposalId: string,
  reason: string,
): Promise<{ ok: boolean }> {
  await db.update(schema.scoringProposals).set({
    status: 'rejected', notes: reason,
  }).where(eq(schema.scoringProposals.id, proposalId));
  await writeAudit('scoring_proposal_rejected', proposalId, { reason });
  return { ok: true };
}

/* ────────── Scheduler entrypoint ────────── */

/* Auto-apply a proposal only when all evidence has sufficient sample size.
   This prevents premature weight changes from small-sample noise. */
const AUTO_APPLY_MIN_OBSERVATIONS = 200;

export async function tickClosedLoop(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  const orgs = await db.select({ id: schema.organizations.id }).from(schema.organizations);
  let totalSignals = 0, totalProposals = 0, totalAutoApplied = 0, totalAutoSkipped = 0;
  for (const o of orgs) {
    const agg = await aggregateSignalOutcomes(db, o.id, DEFAULT_WINDOW_DAYS);
    totalSignals += agg.written;
    const prop = await proposeScoringChanges(db, o.id, DEFAULT_WINDOW_DAYS);
    if (prop.proposalId) {
      totalProposals++;

      /* Auto-apply has two gates and is OFF by default:
           1. CLOSED_LOOP_AUTO_APPLY env flag must be true (operator opt-in).
           2. Confidence gate: all evidence buckets >= MIN observations and
              the proposal must have >= 3 signal changes.
         The proposal row is always written; the operator can apply via the
         /api/scoring/proposals/:id/apply route after review. */
      if (!cfg.closedLoopAutoApply) {
        totalAutoSkipped++;
        continue;
      }

      const evidenceHighConfidence =
        prop.proposal.evidence.length >= 3 &&
        prop.proposal.evidence.every(e => (e.nObservations ?? 0) >= AUTO_APPLY_MIN_OBSERVATIONS);

      if (evidenceHighConfidence && prop.proposalId) {
        const applied = await applyScoringProposal(db, prop.proposalId, {
          reason: `auto_apply: ${prop.proposal.evidence.length} signals, min ${AUTO_APPLY_MIN_OBSERVATIONS} obs each`,
        });
        if (applied.ok) {
          totalAutoApplied++;
          log.info({ orgId: o.id, newVersion: applied.newVersionId }, 'closed-loop auto-applied scoring proposal');
        }
      }
    }
  }
  return { totalSignals, totalProposals, totalAutoApplied, totalAutoSkipped, orgs: orgs.length };
}

/* ────────── Internals ────────── */

async function loadCurrentScoringVersion(db: Database, orgId: string): Promise<ScoringVersion> {
  const rows = await db.select().from(schema.scoringVersions)
    .where(eq(schema.scoringVersions.orgId, orgId))
    .orderBy(desc(schema.scoringVersions.id))
    .limit(1);
  const v = rows[0];
  if (!v) {
    /* Fall back to the in-code default. */
    const { SCORING_VERSION_V1 } = await import('@keres/core');
    return SCORING_VERSION_V1;
  }
  return {
    id: v.id,
    weights: v.weights as unknown as ScoringVersion['weights'],
    notes: v.notes ?? undefined,
  };
}

async function loadAggregatesByKey(
  db: Database,
  orgId: string,
  windowDays: number,
  windowEndDate: string | null,
  keys: string[],
): Promise<SignalOutcomeAggregate[]> {
  if (keys.length === 0 || !windowEndDate) return [];
  const signalKeys = [...new Set(keys.map(k => k.split(':')[0]!).filter(Boolean))];
  const rows = await db.select().from(schema.signalOutcomes).where(and(
    eq(schema.signalOutcomes.orgId, orgId),
    eq(schema.signalOutcomes.windowDays, windowDays),
    eq(schema.signalOutcomes.windowEndDate, windowEndDate),
    inArray(schema.signalOutcomes.signalKey, signalKeys),
  ));
  return rows.map(r => ({
    signalKey: r.signalKey,
    signalValue: r.signalValue,
    nObservations: r.nObservations,
    nSent: r.nSent, nReplied: r.nReplied, nQualified: r.nQualified,
    nBounced: r.nBounced, nComplained: r.nComplained, nUnsubscribed: r.nUnsubscribed,
  }));
}

function emptyProposal(): Proposal {
  return { baseVersionId: 0, deltas: {}, evidence: [], nextVersion: null };
}
