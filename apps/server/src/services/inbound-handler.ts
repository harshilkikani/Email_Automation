/**
 * Inbound webhook handler — both SES SNS and Postmark Inbound funnel here.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { classifyReply } from '@keres/core';
import { parseSnsNotification, shouldAutoSuppress } from '@keres/providers';
import type { InboundEvent } from '@keres/providers';
import { getConfig } from '../config.js';

/** Persist an SES SNS notification batch. Returns counts for the test harness. */
export async function handleSesSns(db: Database, orgId: string, body: any): Promise<{ subscribed: boolean; events: number; suppressed: number; subscribeUrl?: string }> {
  const parsed = parseSnsNotification(body);
  let events = 0, suppressed = 0;
  let subscribed = false, subscribeUrl: string | undefined;
  for (const ev of parsed) {
    if (ev.kind === 'subscription_confirmation') {
      subscribed = true;
      subscribeUrl = ev.subscribeUrl;
      continue;
    }
    /* Find recipient for the message id. */
    const recipient = (await db.select()
      .from(schema.campaignRecipients)
      .where(eq(schema.campaignRecipients.providerMessageId, ev.providerMessageId))
      .limit(1))[0] ?? null;

    /* Idempotent insert. */
    const inserted = await db.insert(schema.emailEvents).values({
      orgId,
      eventType: ev.eventType,
      providerMessageId: ev.providerMessageId,
      bounceType: ev.bounceType ?? null,
      diagnostic: ev.diagnostic ?? null,
      occurredAt: ev.occurredAt,
      rawPayload: ev.raw as Record<string, unknown>,
      campaignId: recipient?.campaignId ?? null,
      recipientId: recipient?.id ?? null,
      leadId: recipient?.leadId ?? null,
    }).onConflictDoNothing();
    events++;

    if (recipient) {
      const nextState = ev.eventType === 'bounce' ? 'bounced'
                      : ev.eventType === 'complaint' ? 'complained'
                      : ev.eventType === 'delivered' ? 'delivered'
                      : recipient.state;
      await db.update(schema.campaignRecipients).set({
        state: nextState, bouncedAt: ev.eventType === 'bounce' ? ev.occurredAt : recipient.bouncedAt,
      }).where(eq(schema.campaignRecipients.id, recipient.id));
    }

    if (shouldAutoSuppress(ev) && ev.recipients.length > 0) {
      for (const email of ev.recipients) {
        await db.insert(schema.suppressions).values({
          orgId, email, scope: 'org',
          reason: ev.eventType === 'complaint' ? 'complaint' : 'hard_bounce',
          sourceEvent: ev.eventType,
        }).onConflictDoNothing();
        suppressed++;
        if (recipient) {
          await db.update(schema.leads).set({
            status: ev.eventType === 'complaint' ? 'dnc' : 'bounced',
          }).where(eq(schema.leads.id, recipient.leadId));
        }
      }
    }
  }
  return { subscribed, events, suppressed, subscribeUrl };
}

/** Persist an inbound reply (Postmark Inbound parser). */
export async function handleInboundReply(db: Database, orgId: string, ev: InboundEvent): Promise<{ id: string; intent: string }> {
  /* Find recipient by To: address + the most recent campaign with this lead. */
  const lead = (await db.select().from(schema.leads)
    .where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.email, ev.fromEmail)))
    .limit(1))[0] ?? null;

  let recipient = null as typeof schema.campaignRecipients.$inferSelect | null;
  if (lead) {
    recipient = (await db.select().from(schema.campaignRecipients)
      .where(eq(schema.campaignRecipients.leadId, lead.id))
      .orderBy(sql`${schema.campaignRecipients.firstSentAt} desc nulls last`)
      .limit(1))[0] ?? null;
  }

  const classified = classifyReply(ev.subject ?? '', ev.textBody ?? '');
  const inserted = await db.insert(schema.inboundMessages).values({
    orgId,
    leadId: lead?.id ?? null,
    campaignId: recipient?.campaignId ?? null,
    recipientId: recipient?.id ?? null,
    providerMessageId: ev.providerMessageId,
    fromEmail: ev.fromEmail,
    toEmail: ev.toEmail,
    subject: ev.subject ?? null,
    textBody: ev.textBody ?? null,
    htmlBody: ev.htmlBody ?? null,
    autoIntent: classified.intent,
    classifierSource: 'regex',
    isAutoReply: classified.isAutoReply,
    receivedAt: ev.receivedAt,
  }).onConflictDoNothing().returning({ id: schema.inboundMessages.id });

  /* Record an email_event(reply). */
  if (recipient) {
    await db.insert(schema.emailEvents).values({
      orgId, campaignId: recipient.campaignId, recipientId: recipient.id, leadId: recipient.leadId,
      eventType: 'reply',
      providerMessageId: ev.providerMessageId,
      occurredAt: ev.receivedAt,
      rawPayload: { intent: classified.intent } as Record<string, unknown>,
    }).onConflictDoNothing();
    await db.update(schema.campaignRecipients).set({
      state: 'replied', repliedAt: ev.receivedAt,
    }).where(eq(schema.campaignRecipients.id, recipient.id));
  }
  /* Auto-suppress on hostile / unsubscribe / bounce. */
  if (classified.intent === 'not_interested_hostile' || classified.intent === 'unsubscribe') {
    await db.insert(schema.suppressions).values({
      orgId, email: ev.fromEmail, scope: 'org',
      reason: classified.intent === 'unsubscribe' ? 'unsubscribe_reply' : 'hostile_reply',
      sourceEvent: 'inbound',
    }).onConflictDoNothing();
    if (lead) {
      await db.update(schema.leads).set({
        status: classified.intent === 'unsubscribe' ? 'unsubscribed' : 'dnc',
      }).where(eq(schema.leads.id, lead.id));
    }
  } else if (classified.intent === 'interested' || classified.intent === 'conditional') {
    if (lead) await db.update(schema.leads).set({ status: 'interested' }).where(eq(schema.leads.id, lead.id));
  }

  return { id: inserted[0]?.id ?? '', intent: classified.intent };
}
