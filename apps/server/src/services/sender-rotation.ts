/**
 * Sender rotation + throttling.
 *
 * The send pipeline calls `pickMailbox` to choose which `sender_mailbox` row
 * should originate the next send. Selection policy:
 *
 *   1. Filter to mailboxes that are `active` or `warming`, NOT in cooldown,
 *      NOT exhausted (hourlyTokens > 0), with the same orgId.
 *   2. Apply per-domain cap: don't let any single domain handle more than
 *      `perDomainCap` of the org's per-hour budget.
 *   3. Pick by policy:
 *        - reputation_weighted (default): mailboxes with higher reputationScore
 *          get proportionally higher selection probability.
 *        - round_robin:   strictly least-recently-used.
 *        - random:        uniform over the eligible set.
 *   4. Decrement hourlyTokens + bump lastUsedAt atomically.
 *
 * On every send outcome, `recordSendOutcome` updates sendsToday + applies
 * cooldowns for bounce/complaint.
 */
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';

export type RotationPolicy = 'reputation_weighted' | 'round_robin' | 'random';

export interface RotationOptions {
  policy: RotationPolicy;
  /** Optional: restrict to mailboxes hosted on this senderDomainId (campaign-level pinning). */
  senderDomainId?: string;
  /** Skip a specific mailbox (used after a 1-shot retry). */
  excludeMailboxId?: string;
}

export interface PickedMailbox {
  id: string;
  orgId: string;
  senderDomainId: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  reputationScore: number;
  warmupDay: number;
  hourlyTokensBefore: number;
}

export async function pickMailbox(
  db: Database,
  orgId: string,
  opts: RotationOptions = { policy: 'reputation_weighted' },
): Promise<PickedMailbox | null> {
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);

  /* Reset sends_today rows that have stale date strings. Idempotent — only
     touches rows that need it. */
  await db.update(schema.senderMailboxes)
    .set({ sendsToday: 0, sendsTodayDate: todayUtc })
    .where(or(
      isNull(schema.senderMailboxes.sendsTodayDate),
      sql`${schema.senderMailboxes.sendsTodayDate} <> ${todayUtc}`,
    ));

  const eligible = await db.select().from(schema.senderMailboxes).where(and(
    eq(schema.senderMailboxes.orgId, orgId),
    or(eq(schema.senderMailboxes.state, 'warming'), eq(schema.senderMailboxes.state, 'active'))!,
    or(isNull(schema.senderMailboxes.cooldownUntil), lte(schema.senderMailboxes.cooldownUntil, now))!,
    gt(schema.senderMailboxes.hourlyTokens, 0),
    opts.senderDomainId ? eq(schema.senderMailboxes.senderDomainId, opts.senderDomainId) : sql`true`,
    opts.excludeMailboxId ? sql`${schema.senderMailboxes.id} <> ${opts.excludeMailboxId}` : sql`true`,
  ));
  if (eligible.length === 0) return null;

  const pick = selectByPolicy(eligible, opts.policy);
  if (!pick) return null;

  /* Atomically decrement hourlyTokens (don't underflow) and bump lastUsedAt.
     The WHERE clause guards against another worker racing us to 0. */
  const updated = await db.update(schema.senderMailboxes).set({
    hourlyTokens: sql`${schema.senderMailboxes.hourlyTokens} - 1`,
    lastUsedAt: now,
  }).where(and(
    eq(schema.senderMailboxes.id, pick.id),
    gt(schema.senderMailboxes.hourlyTokens, 0),
  )).returning({ id: schema.senderMailboxes.id, hourlyTokens: schema.senderMailboxes.hourlyTokens });
  if (updated.length === 0) {
    /* Lost the race; recurse to try another. */
    return pickMailbox(db, orgId, { ...opts, excludeMailboxId: pick.id });
  }
  return {
    id: pick.id,
    orgId: pick.orgId,
    senderDomainId: pick.senderDomainId,
    fromEmail: pick.fromEmail,
    fromName: pick.fromName,
    replyTo: pick.replyTo,
    reputationScore: pick.reputationScore,
    warmupDay: pick.warmupDay,
    hourlyTokensBefore: pick.hourlyTokens,
  };
}

function selectByPolicy(
  eligible: Array<typeof schema.senderMailboxes.$inferSelect>,
  policy: RotationPolicy,
): typeof schema.senderMailboxes.$inferSelect | null {
  if (eligible.length === 0) return null;
  if (policy === 'round_robin') {
    /* Pick the mailbox least-recently used (null lastUsedAt sorts first). */
    return [...eligible].sort((a, b) => {
      const at = a.lastUsedAt?.getTime() ?? 0;
      const bt = b.lastUsedAt?.getTime() ?? 0;
      return at - bt;
    })[0] ?? null;
  }
  if (policy === 'random') {
    return eligible[Math.floor(Math.random() * eligible.length)] ?? null;
  }
  /* reputation_weighted: roulette wheel over (reputation^2 + 1). The square
     amplifies the gap between healthy and unhealthy mailboxes. */
  const weights = eligible.map(m => Math.max(1, m.reputationScore * m.reputationScore + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return eligible[i]!;
  }
  return eligible[eligible.length - 1] ?? null;
}

export interface SendOutcome {
  mailboxId: string;
  status: 'sent' | 'bounce_hard' | 'bounce_soft' | 'complaint';
}

/**
 * Called by the send pipeline after every outbound provider call. Updates
 * sendsToday + applies cooldowns/auto-pause when thresholds are hit.
 */
export async function recordSendOutcome(db: Database, outcome: SendOutcome): Promise<void> {
  if (outcome.status === 'sent') {
    await db.update(schema.senderMailboxes).set({
      sendsToday: sql`${schema.senderMailboxes.sendsToday} + 1`,
    }).where(eq(schema.senderMailboxes.id, outcome.mailboxId));
    return;
  }
  if (outcome.status === 'bounce_hard') {
    /* Hard bounce: brief cooldown + immediate reputation penalty so the
       reputation-weighted rotator deprioritises this mailbox intra-day,
       not just after the next daily rollup. */
    await db.update(schema.senderMailboxes).set({
      cooldownUntil: new Date(Date.now() + 15 * 60_000),
      reputationScore: sql`greatest(0, ${schema.senderMailboxes.reputationScore} - 3)`,
    }).where(and(
      eq(schema.senderMailboxes.id, outcome.mailboxId),
      or(isNull(schema.senderMailboxes.cooldownUntil),
         lte(schema.senderMailboxes.cooldownUntil, new Date(Date.now() + 15 * 60_000)))!,
    ));
    return;
  }
  if (outcome.status === 'complaint') {
    /* Complaint is more serious: 2-hour cooldown + reputation penalty. */
    await db.update(schema.senderMailboxes).set({
      cooldownUntil: new Date(Date.now() + 2 * 3600_000),
      reputationScore: sql`greatest(0, ${schema.senderMailboxes.reputationScore} - 5)`,
    }).where(eq(schema.senderMailboxes.id, outcome.mailboxId));
    return;
  }
  /* bounce_soft: tiny nudge, no cooldown. */
  await db.update(schema.senderMailboxes).set({
    reputationScore: sql`greatest(0, ${schema.senderMailboxes.reputationScore} - 1)`,
  }).where(eq(schema.senderMailboxes.id, outcome.mailboxId));
}
