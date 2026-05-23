/**
 * Typed domain event emitter — event sourcing layer.
 *
 * Every FSM transition, campaign state change, scoring change, and revenue
 * event should be emitted here so domain_events becomes the authoritative
 * append-only ledger. The audit_log table remains for human-readable operator
 * actions; domain_events is for machine-readable, replayable business events.
 *
 * Usage: `await emitEvent(db, orgId, 'lead.won', 'lead', leadId, { revenueUsd: 500 })`
 */
import type { Database } from '@keres/db';
import { schema } from '@keres/db';

export type AggregateType = 'campaign' | 'lead' | 'mailbox' | 'scoring' | 'reply_branch';

export type DomainEventType =
  | 'campaign.launched'
  | 'campaign.paused'
  | 'campaign.resumed'
  | 'campaign.completed'
  | 'lead.engaged'
  | 'lead.won'
  | 'lead.lost'
  | 'lead.suppressed'
  | 'lead.contacted'
  | 'mailbox.paused'
  | 'mailbox.activated'
  | 'mailbox.retired'
  | 'scoring.proposal_created'
  | 'scoring.proposal_applied'
  | 'scoring.proposal_rejected'
  | 'reply_branch.transition'
  | 'reply_branch.won'
  | 'send.delivered'
  | 'send.bounced'
  | 'send.complained'
  | 'send.dead_lettered';

export async function emitEvent(
  db: Database,
  orgId: string,
  eventType: DomainEventType,
  aggregateType: AggregateType,
  aggregateId: string,
  payload: Record<string, unknown> = {},
  correlationId?: string,
): Promise<void> {
  await db.insert(schema.domainEvents).values({
    orgId,
    eventType,
    aggregateType,
    aggregateId,
    payload,
    correlationId: correlationId ?? null,
    occurredAt: new Date(),
  });
}
