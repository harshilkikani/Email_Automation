/**
 * Per-mailbox warmup engine.
 *
 * Drives sender_mailboxes through the warmup curve defined in their
 * `warmup_plans` row:
 *
 *   1. tickDailyRollup     — at UTC midnight, freeze each mailbox's
 *      sent/delivered/bounced/complained/replied/seedlist counts into
 *      sender_reputation_daily.
 *   2. tickWarmupEngine    — every 30 min, blend the last 7 days into a
 *      reputation score, evaluate decideWarmupAction(), and apply (advance /
 *      hold / pause). Audits every state change.
 *   3. tickHourlyTokenRefill — once an hour, refills hourlyTokens up to
 *      hourlyTokensFor(currentDailyCap).
 */
import { and, eq, gte, lt, sql, desc, inArray } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_CONSERVATIVE_PLAN, dailyCapFor, decideWarmupAction,
  domainReputationScore, hourlyTokensFor,
  type WarmupPlan, type DailySnapshot,
} from '@keres/core';
import { writeAudit } from './audit.js';
import { obs } from '../observability.js';

const ACTIVE_STATES = new Set(['warming', 'active']);

/* ────────── Daily rollup ────────── */

export async function rollupDailyReputation(db: Database, dateUtc: string): Promise<{ rolled: number }> {
  /* For every mailbox, count the sends + outcomes that happened on `dateUtc`. */
  const mailboxes = await db.select().from(schema.senderMailboxes);
  let rolled = 0;
  for (const mb of mailboxes) {
    const startUtc = new Date(`${dateUtc}T00:00:00Z`);
    const endUtc = new Date(startUtc.getTime() + 86400_000);

    /* email_events doesn't store mailbox_id directly; we lookup via the
       campaign_recipients.sender_mailbox_id once that wiring exists. Until then
       we attribute domain-level events to all active mailboxes proportionally.
       For correctness during initial rollout we just count events whose
       sender domain matches this mailbox's domain. */
    const counts = await db.execute(sql`
      SELECT
        coalesce(sum(CASE WHEN ee.event_type = 'send' THEN 1 ELSE 0 END), 0)::int        AS sent,
        coalesce(sum(CASE WHEN ee.event_type = 'delivered' THEN 1 ELSE 0 END), 0)::int   AS delivered,
        coalesce(sum(CASE WHEN ee.event_type = 'bounce' AND ee.bounce_type = 'hard' THEN 1 ELSE 0 END), 0)::int AS bounced,
        coalesce(sum(CASE WHEN ee.event_type = 'complaint' THEN 1 ELSE 0 END), 0)::int   AS complained,
        coalesce(sum(CASE WHEN ee.event_type = 'reply' THEN 1 ELSE 0 END), 0)::int       AS replied,
        coalesce(sum(CASE WHEN ee.event_type = 'unsubscribe' THEN 1 ELSE 0 END), 0)::int AS unsubscribed
      FROM email_events ee
      JOIN campaign_recipients cr ON cr.id = ee.recipient_id
      WHERE cr.sender_mailbox_id = ${mb.id}
        AND ee.occurred_at >= ${startUtc.toISOString()}
        AND ee.occurred_at < ${endUtc.toISOString()}
    `);
    const c = ((counts as { rows?: Array<{ sent: number; delivered: number; bounced: number; complained: number; replied: number; unsubscribed: number }> }).rows ?? [])[0]
            ?? { sent: 0, delivered: 0, bounced: 0, complained: 0, replied: 0, unsubscribed: 0 };

    /* Seedlist placement: count seedlist_tests with sentAt on this date, grouped by observed. */
    const seedlistAgg = await db.execute(sql`
      SELECT
        coalesce(sum(CASE WHEN observed IN ('primary','promotions') THEN 1 ELSE 0 END), 0)::int AS inbox,
        coalesce(sum(CASE WHEN observed = 'spam' THEN 1 ELSE 0 END), 0)::int                    AS spam
      FROM seedlist_tests
      WHERE sender_domain_id = ${mb.senderDomainId}
        AND sent_at >= ${startUtc.toISOString()}
        AND sent_at < ${endUtc.toISOString()}
    `);
    const sl = ((seedlistAgg as { rows?: Array<{ inbox: number; spam: number }> }).rows ?? [])[0] ?? { inbox: 0, spam: 0 };

    /* Compute end-of-day reputation. Mailbox age in days for the bonus. */
    const ageDays = Math.max(0, Math.floor((Date.now() - mb.createdAt.getTime()) / 86400_000));
    const recent = await loadRecentSnapshots(db, mb.id, 7);
    const snap: DailySnapshot = {
      date: dateUtc,
      sent: c.sent, delivered: c.delivered, bounced: c.bounced,
      complained: c.complained, unsubscribed: c.unsubscribed,
      seedlistInbox: sl.inbox, seedlistSpam: sl.spam,
    };
    const reputation = domainReputationScore({ ageDays, recent: [...recent, snap] });

    await db.insert(schema.senderReputationDaily).values({
      mailboxId: mb.id, date: dateUtc,
      sent: c.sent, delivered: c.delivered, bounced: c.bounced,
      complained: c.complained, replied: c.replied, unsubscribed: c.unsubscribed,
      seedlistInbox: sl.inbox, seedlistSpam: sl.spam,
      reputationScore: reputation,
    }).onConflictDoUpdate({
      target: [schema.senderReputationDaily.mailboxId, schema.senderReputationDaily.date],
      set: {
        sent: c.sent, delivered: c.delivered, bounced: c.bounced,
        complained: c.complained, replied: c.replied, unsubscribed: c.unsubscribed,
        seedlistInbox: sl.inbox, seedlistSpam: sl.spam,
        reputationScore: reputation,
      },
    });
    await db.update(schema.senderMailboxes).set({ reputationScore: reputation })
      .where(eq(schema.senderMailboxes.id, mb.id));
    rolled++;
  }
  return { rolled };
}

/* ────────── Main engine tick ────────── */

export async function tickWarmupEngine(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  /* If the date has changed since the last rollup, roll up the previous day. */
  const todayUtc = new Date().toISOString().slice(0, 10);
  const yesterdayUtc = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  const lastRollup = await db.select({ d: sql<string>`max(${schema.senderReputationDaily.date})` })
    .from(schema.senderReputationDaily);
  const lastDate = lastRollup[0]?.d ?? null;
  if (!lastDate || lastDate < yesterdayUtc) {
    await rollupDailyReputation(db, yesterdayUtc);
  }

  /* Evaluate every active mailbox. */
  const mailboxes = await db.select().from(schema.senderMailboxes)
    .where(inArray(schema.senderMailboxes.state, ['warming', 'active']));

  let advanced = 0, paused = 0, held = 0;
  for (const mb of mailboxes) {
    /* Cooldown still in effect? Skip. */
    if (mb.cooldownUntil && mb.cooldownUntil > new Date()) {
      held++;
      continue;
    }

    const plan = await loadWarmupPlan(db, mb.warmupPlanId, mb.orgId);
    const recent = await loadRecentSnapshots(db, mb.id, 7);
    const ageDays = Math.max(0, Math.floor((Date.now() - mb.createdAt.getTime()) / 86400_000));
    const reputation = domainReputationScore({ ageDays, recent });

    const recent24h = aggregateLastN(recent, 1);
    const decision = decideWarmupAction(plan, mb.warmupDay, reputation, {
      sent: recent24h.sent, bounced: recent24h.bounced, complained: recent24h.complained,
    });

    if (decision.action === 'advance') {
      await db.update(schema.senderMailboxes).set({
        warmupDay: decision.nextDay,
        reputationScore: reputation,
        state: decision.nextDay >= plan.dailyCaps.length - 1 ? 'active' : 'warming',
      }).where(eq(schema.senderMailboxes.id, mb.id));
      await writeAudit('warmup_mailbox_advance', mb.id, {
        fromDay: mb.warmupDay, toDay: decision.nextDay, newCap: decision.newCap, reputation,
      });
      advanced++;
    } else if (decision.action === 'pause') {
      const cooldown = new Date(Date.now() + 6 * 3600_000);   // 6h pause
      await db.update(schema.senderMailboxes).set({
        state: 'paused',
        pauseReason: decision.reason,
        cooldownUntil: cooldown,
        reputationScore: reputation,
      }).where(eq(schema.senderMailboxes.id, mb.id));
      await writeAudit('warmup_mailbox_pause', mb.id, { reason: decision.reason, reputation });
      paused++;
    } else {
      await db.update(schema.senderMailboxes).set({ reputationScore: reputation })
        .where(eq(schema.senderMailboxes.id, mb.id));
      held++;
    }
  }
  obs().meter.counter('warmup_advanced', undefined, advanced);
  obs().meter.counter('warmup_paused', undefined, paused);
  obs().meter.gauge('warmup_mailboxes_total', mailboxes.length);
  log.info({ advanced, paused, held }, 'warmup engine tick');
  return { advanced, paused, held, evaluated: mailboxes.length };
}

/* ────────── Hourly token refill ────────── */

export async function refillHourlyTokens(db: Database): Promise<{ refilled: number }> {
  const mailboxes = await db.select().from(schema.senderMailboxes)
    .where(inArray(schema.senderMailboxes.state, ['warming', 'active']));
  let refilled = 0;
  for (const mb of mailboxes) {
    const plan = await loadWarmupPlan(db, mb.warmupPlanId, mb.orgId);
    const cap = dailyCapFor(plan, mb.warmupDay);
    const tokens = hourlyTokensFor(cap);
    /* Don't refill past the daily-remaining: a mailbox that's already sent
       sendsToday in excess of (cap - tokens) shouldn't accumulate. */
    const remainingToday = Math.max(0, cap - mb.sendsToday);
    const granted = Math.min(tokens, remainingToday);
    await db.update(schema.senderMailboxes).set({
      hourlyTokens: granted,
      hourlyTokensRefilledAt: new Date(),
    }).where(eq(schema.senderMailboxes.id, mb.id));
    refilled++;
  }
  return { refilled };
}

/* ────────── Internals ────────── */

async function loadWarmupPlan(db: Database, planId: string | null, orgId: string): Promise<WarmupPlan> {
  if (planId) {
    const row = (await db.select().from(schema.warmupPlans).where(eq(schema.warmupPlans.id, planId)).limit(1))[0];
    if (row) return toPlan(row);
  }
  const def = (await db.select().from(schema.warmupPlans)
    .where(and(eq(schema.warmupPlans.orgId, orgId), eq(schema.warmupPlans.isDefault, true)))
    .limit(1))[0];
  if (def) return toPlan(def);
  return DEFAULT_CONSERVATIVE_PLAN;
}

function toPlan(row: typeof schema.warmupPlans.$inferSelect): WarmupPlan {
  return {
    dailyCaps: row.dailyCaps,
    pauseBouncePct: row.pauseBouncePct,
    pauseComplaintPct: row.pauseComplaintPct,
    minReputationToAdvance: row.minReputationToAdvance,
  };
}

async function loadRecentSnapshots(db: Database, mailboxId: string, days: number): Promise<DailySnapshot[]> {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const rows = await db.select().from(schema.senderReputationDaily)
    .where(and(eq(schema.senderReputationDaily.mailboxId, mailboxId),
               gte(schema.senderReputationDaily.date, cutoff)))
    .orderBy(desc(schema.senderReputationDaily.date));
  return rows.map(r => ({
    date: r.date,
    sent: r.sent, delivered: r.delivered, bounced: r.bounced,
    complained: r.complained, unsubscribed: r.unsubscribed,
    seedlistInbox: r.seedlistInbox, seedlistSpam: r.seedlistSpam,
  }));
}

function aggregateLastN(snaps: DailySnapshot[], n: number): DailySnapshot {
  const top = snaps.slice(0, n);
  return top.reduce<DailySnapshot>((acc, r) => ({
    date: acc.date,
    sent: acc.sent + r.sent,
    delivered: acc.delivered + r.delivered,
    bounced: acc.bounced + r.bounced,
    complained: acc.complained + r.complained,
    unsubscribed: acc.unsubscribed + r.unsubscribed,
    seedlistInbox: acc.seedlistInbox + r.seedlistInbox,
    seedlistSpam: acc.seedlistSpam + r.seedlistSpam,
  }), { date: top[0]?.date ?? '', sent: 0, delivered: 0, bounced: 0, complained: 0, unsubscribed: 0, seedlistInbox: 0, seedlistSpam: 0 });
}

/* ────────── Unused imports kept for future extensions (silence linter). ────────── */
void lt;
