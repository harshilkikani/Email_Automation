/**
 * Reply branch executor.
 *
 * Two entrypoints:
 *
 *   1. `onInboundReply(db, msgId)` — called by inbound-handler.ts as soon as
 *      we parse a Postmark inbound. Loads the matching reply_branch_states
 *      row (creates one if missing), reduces the FSM, persists, and fires
 *      side effects (suppress / queue a follow-up).
 *
 *   2. `tickReplyBranches(db, log)` — called every 5 min by the scheduler.
 *      Drives time-based transitions: pulls rows where nextActionAt is due,
 *      reduces each with a `tick` event, and persists.
 */
import { and, eq, lte, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import {
  reduce, INITIAL_BRANCH_STATE,
  type BranchState, type BranchAction, type ReplyNode,
} from '@keres/core';
import type { ReplyIntent } from '@keres/core';
import { writeAudit } from './audit.js';
import { obs } from '../observability.js';

/* ────────── inbound handler integration ────────── */

export async function onInboundReply(
  db: Database,
  inboundId: string,
): Promise<{ ok: boolean; action: BranchAction; node: ReplyNode } | { ok: false; reason: string }> {
  const msg = (await db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, inboundId)).limit(1))[0];
  if (!msg) return { ok: false, reason: 'inbound_not_found' };
  if (!msg.leadId) return { ok: false, reason: 'inbound_unlinked' };
  const intent = (msg.manualIntent ?? msg.autoIntent ?? 'unknown') as ReplyIntent | 'unknown';

  const state = await loadOrCreate(db, msg.orgId, msg.campaignId, msg.leadId, msg.recipientId);
  const transition = reduce(state.fsm, { kind: 'inbound', intent }, new Date());
  await persistTransition(db, state.rowId, transition, intent);
  await fireAction(db, msg.orgId, msg.leadId, transition);
  return { ok: true, action: transition.action, node: transition.state.node };
}

/* ────────── tick handler ────────── */

export async function tickReplyBranches(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const now = new Date();
  /* Pull a bounded batch of branches whose next action is due. */
  const due = await db.select().from(schema.replyBranchStates).where(and(
    isNotNull(schema.replyBranchStates.nextActionAt),
    lte(schema.replyBranchStates.nextActionAt, now),
  )).limit(200);

  let acted = 0;
  for (const row of due) {
    const fsm: BranchState = fromRow(row);
    const transition = reduce(fsm, { kind: 'tick', now }, now);
    if (transition.action.type === 'noop' && transition.state.node === fsm.node && !diffNextAction(fsm, transition.state)) {
      continue;
    }
    await persistTransition(db, row.id, transition, null);
    await fireAction(db, row.orgId, row.leadId, transition);
    acted++;
  }

  /* Also: cover newly-sent recipients that never had a reply_branch_states
     row created. We create them lazily so the tick can arm follow-up timers. */
  const newRows = await db.execute(sql`
    SELECT cr.id AS recipient_id, cr.org_id, cr.campaign_id, cr.lead_id, cr.first_sent_at
    FROM campaign_recipients cr
    LEFT JOIN reply_branch_states rb ON rb.recipient_id = cr.id
    WHERE rb.id IS NULL
      AND cr.first_sent_at IS NOT NULL
      AND cr.state IN ('sent','delivered')
    LIMIT 200
  `);
  const recipientRows = ((newRows as unknown as { rows?: Array<{ recipient_id: string; org_id: string; campaign_id: string; lead_id: string; first_sent_at: Date | string }> }).rows ?? []) as Array<{ recipient_id: string; org_id: string; campaign_id: string; lead_id: string; first_sent_at: Date | string }>;
  for (const r of recipientRows) {
    /* Raw SQL execute() returns timestamp columns as `Date` under the
       node-postgres driver but as ISO strings under @neondatabase/serverless's
       HTTP driver. Coerce here so neither path crashes. */
    const sentAt = r.first_sent_at instanceof Date ? r.first_sent_at : new Date(r.first_sent_at);
    const inserted = await db.insert(schema.replyBranchStates).values({
      orgId: r.org_id, campaignId: r.campaign_id, leadId: r.lead_id, recipientId: r.recipient_id,
      node: 'awaiting_reply',
      followUpsSent: 0,
      nextActionAt: new Date(sentAt.getTime() + 48 * 3600_000),
      nextActionKind: 'send_followup',
      nextActionPayload: { templateKey: 'follow_up_1' } as Record<string, unknown>,
      trail: [{ at: new Date().toISOString(), from: 'init', to: 'awaiting_reply', cause: 'lazy_create' }] as unknown as Record<string, unknown>,
    }).onConflictDoNothing().returning({ id: schema.replyBranchStates.id });
    if (inserted[0]) acted++;
  }

  log.info({ due: due.length, acted, newlyCreated: recipientRows.length }, 'reply branches tick');
  obs().meter.gauge('reply_branches_due', due.length);
  return { acted, due: due.length, created: recipientRows.length };
}

/* ────────── internals ────────── */

async function loadOrCreate(
  db: Database,
  orgId: string,
  campaignId: string | null,
  leadId: string,
  recipientId: string | null,
): Promise<{ rowId: string; fsm: BranchState }> {
  /* Try (campaignId, leadId) first; fall back to recipientId. */
  let row: typeof schema.replyBranchStates.$inferSelect | undefined;
  if (campaignId) {
    row = (await db.select().from(schema.replyBranchStates).where(and(
      eq(schema.replyBranchStates.campaignId, campaignId),
      eq(schema.replyBranchStates.leadId, leadId),
    )).limit(1))[0];
  }
  if (!row && recipientId) {
    row = (await db.select().from(schema.replyBranchStates).where(eq(schema.replyBranchStates.recipientId, recipientId)).limit(1))[0];
  }
  if (row) return { rowId: row.id, fsm: fromRow(row) };

  const inserted = await db.insert(schema.replyBranchStates).values({
    orgId, campaignId, leadId, recipientId,
    node: 'awaiting_reply',
    followUpsSent: 0,
  }).returning({ id: schema.replyBranchStates.id });
  return { rowId: inserted[0]!.id, fsm: { ...INITIAL_BRANCH_STATE } };
}

function fromRow(row: typeof schema.replyBranchStates.$inferSelect): BranchState {
  return {
    node: row.node as ReplyNode,
    followUpsSent: row.followUpsSent,
    nextActionAt: row.nextActionAt,
    nextActionKind: row.nextActionKind ?? null,
    nextActionPayload: (row.nextActionPayload as Record<string, unknown> | undefined) ?? undefined,
  };
}

function diffNextAction(a: BranchState, b: BranchState): boolean {
  return (a.nextActionAt?.getTime() ?? 0) !== (b.nextActionAt?.getTime() ?? 0)
      || a.nextActionKind !== b.nextActionKind;
}

async function persistTransition(
  db: Database,
  rowId: string,
  transition: { state: BranchState; trail: { at: string; from: ReplyNode; to: ReplyNode; cause: string } },
  intent: ReplyIntent | 'unknown' | null,
): Promise<void> {
  const trailEntry = { ...transition.trail, intent: intent ?? undefined };
  await db.update(schema.replyBranchStates).set({
    node: transition.state.node,
    followUpsSent: transition.state.followUpsSent,
    nextActionAt: transition.state.nextActionAt,
    nextActionKind: transition.state.nextActionKind,
    nextActionPayload: (transition.state.nextActionPayload ?? null) as Record<string, unknown> | null,
    lastIntent: intent ?? null,
    trail: sql`coalesce(${schema.replyBranchStates.trail}, '[]'::jsonb) || ${JSON.stringify([trailEntry])}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(schema.replyBranchStates.id, rowId));
}

async function fireAction(
  db: Database,
  orgId: string,
  leadId: string,
  transition: { action: BranchAction; state: BranchState },
): Promise<void> {
  if (transition.state.node === 'engaged') {
    await writeAudit('lead_engaged', leadId, { orgId });
    obs().meter.gauge('leads_engaged_total', 1);
  }
  if (transition.action.type === 'noop' || transition.action.type === 'wait') return;
  if (transition.action.type === 'suppress') {
    const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1))[0];
    if (lead?.email) {
      await db.insert(schema.suppressions).values({
        orgId, email: lead.email, scope: 'org',
        reason: transition.action.reason, sourceEvent: 'hostile_reply',
      }).onConflictDoNothing();
      await db.update(schema.leads).set({ status: 'dnc' }).where(eq(schema.leads.id, leadId));
    }
    await writeAudit('reply_branch_suppress', leadId, { reason: transition.action.reason });
    return;
  }
  if (transition.action.type === 'send_followup' || transition.action.type === 'send_booking_link') {
    /* The actual follow-up send is enqueued by inserting a new campaign_recipients
       row in the same campaign with templateKey override + nextSendAt = now. The
       send loop picks it up on the next tick. We keep this branch terse since the
       full follow-up campaign builder lives in campaigns.ts. */
    await db.insert(schema.jobRuns).values({
      orgId, kind: 'send_followup',
      payload: { leadId, action: transition.action } as Record<string, unknown>,
      status: 'queued',
    });
    await writeAudit('reply_branch_action', leadId, { action: transition.action });
  }
}
