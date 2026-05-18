/**
 * The actual send loop: pulls queued recipients, renders, asks the outbound
 * provider to send, persists email_events, updates campaign counters, and
 * auto-pauses on threshold breaches.
 *
 * It is intentionally a simple polling loop (not a separate worker process)
 * so the v3.1 single-Fly-machine architecture works without Upstash/BullMQ.
 */
import { and, eq, sql, asc } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { defaultTemplateFor, renderEmail, TEMPLATES, type Template } from '@keres/core';
import { finalRender, lintEmail, highestSeverity } from '@keres/email';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { gateCampaign } from './campaigns.js';
import { getOutbound } from './sender-factory.js';

export interface SendBatchOptions {
  campaignId?: string;
  maxToSend: number;
}

export async function sendBatch(db: Database, opts: SendBatchOptions): Promise<{ sent: number; skipped: number; failed: number }> {
  const cfg = getConfig();
  const provider = getOutbound();
  let sent = 0, skipped = 0, failed = 0;

  /* Pick eligible recipients across runnable campaigns. */
  const recipients = await db.select({
    rid: schema.campaignRecipients.id,
    campaignId: schema.campaignRecipients.campaignId,
    leadId: schema.campaignRecipients.leadId,
    orgId: schema.campaignRecipients.orgId,
  })
    .from(schema.campaignRecipients)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignRecipients.campaignId))
    .where(and(
      eq(schema.campaignRecipients.state, 'pending'),
      eq(schema.campaigns.status, 'running'),
      opts.campaignId ? eq(schema.campaignRecipients.campaignId, opts.campaignId) : sql`true`,
    ))
    .orderBy(asc(schema.campaignRecipients.id))
    .limit(opts.maxToSend);

  for (const r of recipients) {
    const camp = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, r.campaignId)).limit(1))[0];
    if (!camp || camp.status !== 'running') { skipped++; continue; }
    const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, r.leadId)).limit(1))[0];
    if (!lead || !lead.email) { skipped++; await markSkipped(db, r.rid, 'no_email'); continue; }
    if (['bounced', 'unsubscribed', 'dnc'].includes(lead.status)) {
      await markSkipped(db, r.rid, 'lead_status'); skipped++; continue;
    }
    const org = (await db.select().from(schema.organizations).where(eq(schema.organizations.id, r.orgId)).limit(1))[0];
    if (!org) { skipped++; continue; }
    const signals = (await db.select().from(schema.leadSignals).where(eq(schema.leadSignals.leadId, lead.id)).limit(1))[0];
    const tpl: Template = TEMPLATES[camp.templateKey] ?? defaultTemplateFor(lead.niche as 'Septic');

    const rendered = renderEmail(tpl, {
      leadId: lead.id,
      business: lead.name,
      city: lead.city ?? '',
      signals: {
        webPresenceLevel: (signals?.webPresenceLevel ?? 'unknown') as 'unknown',
        isStormZone: signals?.isStormZone ?? false,
        niche: lead.niche as 'Septic',
        hasOnlineBooking: signals?.hasOnlineBooking ?? false,
      },
      fromName: org.fromName ?? cfg.org.fromName,
      fromSignoff: org.name,
    });
    const msgId = `<${randomUUID()}@${cfg.org.outreachSubdomain}>`;
    const final = finalRender({
      rendered,
      to: lead.email,
      leadEmail: lead.email,
      orgScopeKey: org.id,
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
      messageId: msgId,
    });

    const lint = lintEmail({
      subject: final.subject, body: final.bodyWithFooter,
      recipientCount: camp.recipientCount,
      identityHasPhysicalAddress: !!org.physicalAddress,
      unsubscribeUrlPresent: final.bodyWithFooter.includes(final.unsubscribeUrl),
      canSpamFooterPresent: final.bodyWithFooter.includes('Unsubscribe (one click)'),
    });
    if (highestSeverity(lint) === 'error') {
      await db.update(schema.campaignRecipients).set({ state: 'failed', skipReason: 'lint_error' })
        .where(eq(schema.campaignRecipients.id, r.rid));
      failed++; continue;
    }

    try {
      const out = await provider.send({
        to: lead.email,
        subject: final.subject,
        rawMessage: final.rawMessage,
        configurationSet: cfg.ses.configurationSet,
        customMessageId: msgId,
      });
      await db.insert(schema.emailEvents).values({
        orgId: org.id,
        campaignId: camp.id,
        recipientId: r.rid,
        leadId: lead.id,
        eventType: 'send',
        providerMessageId: out.providerMessageId,
        occurredAt: new Date(),
        rawPayload: { msgId, slot: rendered.slotKey } as Record<string, unknown>,
      }).onConflictDoNothing();
      await db.update(schema.campaignRecipients).set({
        state: 'sent', providerMessageId: out.providerMessageId,
        renderedSubject: final.subject, renderedBody: final.bodyWithFooter,
        variantSeed: rendered.variantSeed, slotKey: rendered.slotKey,
        firstSentAt: new Date(),
      }).where(eq(schema.campaignRecipients.id, r.rid));
      await db.update(schema.campaigns).set({ sentCount: sql`${schema.campaigns.sentCount} + 1` })
        .where(eq(schema.campaigns.id, camp.id));
      await db.update(schema.leads).set({ status: 'contacted', lastContactedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
      sent++;
    } catch (e: any) {
      await db.update(schema.campaignRecipients).set({ state: 'failed', skipReason: e?.message ?? 'send_failed' })
        .where(eq(schema.campaignRecipients.id, r.rid));
      failed++;
    }

    /* After each send, check pause thresholds. */
    if (sent > 0 && sent % 25 === 0) {
      const g = await gateCampaign(db, camp.id, {
        bouncePausePct: cfg.bouncePausePct, complaintPausePct: cfg.complaintPausePct,
      });
      if (!g.ok) {
        await db.update(schema.campaigns).set({ status: 'paused', pauseReason: g.blockers[0]?.message })
          .where(eq(schema.campaigns.id, camp.id));
        break;
      }
    }
  }
  return { sent, skipped, failed };
}

async function markSkipped(db: Database, rid: string, reason: string): Promise<void> {
  await db.update(schema.campaignRecipients).set({ state: 'skipped', skipReason: reason })
    .where(eq(schema.campaignRecipients.id, rid));
}
