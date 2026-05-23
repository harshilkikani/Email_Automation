/**
 * The actual send loop: pulls queued recipients, renders, asks the outbound
 * provider to send, persists email_events, updates campaign counters, and
 * auto-pauses on threshold breaches.
 *
 * It is intentionally a simple polling loop (not a separate worker process)
 * so the v3.1 single-Fly-machine architecture works without Upstash/BullMQ.
 */
import { and, eq, sql, asc, inArray, lte, or, isNull } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { defaultTemplateFor, renderEmail, TEMPLATES, type Template } from '@keres/core';
import { finalRender, lintEmail, highestSeverity } from '@keres/email';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { gateCampaign } from './campaigns.js';
import { getOutbound } from './sender-factory.js';
import { pickMailbox, recordSendOutcome } from './sender-rotation.js';
import { checkSaturationBeforeSend } from './saturation.js';
import { emitEvent } from './events.js';

/**
 * Pre-flight decision: all the per-recipient choices that happen before the
 * actual SES call. Extracting this makes the send loop readable and testable.
 */
export interface CampaignDecision {
  shouldSend: boolean;
  skipReason?: string;
  mailbox: typeof schema.senderMailboxes.$inferSelect | null;
  template: Template;
  subjectOverrides: string[];
  senderIdentity: { fromName: string; fromEmail: string; replyTo: string };
}

/** Evaluate whether this recipient should be sent to and which identity/template to use. */
function computeDecision(
  camp: typeof schema.campaigns.$inferSelect,
  lead: typeof schema.leads.$inferSelect,
  org: typeof schema.organizations.$inferSelect,
  _signals: typeof schema.leadSignals.$inferSelect | undefined,
  sat: { action: 'allow' | 'block'; saturationPct: number; reason?: string },
  mailbox: typeof schema.senderMailboxes.$inferSelect | null,
  cfg: ReturnType<typeof getConfig>,
): CampaignDecision {
  if (camp.status !== 'running') return { shouldSend: false, skipReason: 'campaign_not_running', mailbox: null, template: defaultTemplateFor(lead.niche as 'Septic'), subjectOverrides: [], senderIdentity: { fromName: '', fromEmail: '', replyTo: '' } };
  if (!lead.email) return { shouldSend: false, skipReason: 'no_email', mailbox: null, template: defaultTemplateFor(lead.niche as 'Septic'), subjectOverrides: [], senderIdentity: { fromName: '', fromEmail: '', replyTo: '' } };
  if (['bounced', 'unsubscribed', 'dnc'].includes(lead.status)) return { shouldSend: false, skipReason: 'lead_status', mailbox: null, template: defaultTemplateFor(lead.niche as 'Septic'), subjectOverrides: [], senderIdentity: { fromName: '', fromEmail: '', replyTo: '' } };
  if (sat.action === 'block') return { shouldSend: false, skipReason: `saturation_${sat.reason}`, mailbox: null, template: defaultTemplateFor(lead.niche as 'Septic'), subjectOverrides: [], senderIdentity: { fromName: '', fromEmail: '', replyTo: '' } };

  const senderIdentity = mailbox
    ? { fromName: mailbox.fromName, fromEmail: mailbox.fromEmail, replyTo: mailbox.replyTo ?? org.replyTo ?? cfg.org.replyTo }
    : { fromName: org.fromName ?? cfg.org.fromName, fromEmail: org.fromEmail ?? cfg.org.fromEmail, replyTo: org.replyTo ?? cfg.org.replyTo };

  const template: Template = TEMPLATES[camp.templateKey] ?? defaultTemplateFor(lead.niche as 'Septic');
  const subjectOverrides = [
    camp.subjectA && camp.subjectA.trim() ? camp.subjectA.trim() : null,
    camp.subjectB && camp.subjectB.trim() ? camp.subjectB.trim() : null,
  ].filter((s): s is string => s !== null);

  return { shouldSend: true, mailbox, template, subjectOverrides, senderIdentity };
}

export interface SendBatchOptions {
  campaignId?: string;
  maxToSend: number;
}

export async function sendBatch(db: Database, opts: SendBatchOptions): Promise<{ sent: number; skipped: number; failed: number }> {
  const cfg = getConfig();
  /* Defense-in-depth: in production with SES disabled, refuse to call the
     outbound provider at all. The launch gate's `outbound_configured` check
     normally prevents campaigns from reaching status='running' in this state,
     but `/api/campaigns/:id/resume` can revive a paused campaign without
     re-running the gate — this guard catches that path so MockOutbound never
     "fake-sends" to real recipients. */
  if (cfg.nodeEnv === 'production' && !cfg.ses.enabled && !cfg.sampleMode) {
    return { sent: 0, skipped: 0, failed: 0 };
  }
  const provider = getOutbound();
  let sent = 0, skipped = 0, failed = 0;

  /* Pick eligible recipients across runnable campaigns. */
  const recipients = await db.select({
    rid: schema.campaignRecipients.id,
    campaignId: schema.campaignRecipients.campaignId,
    leadId: schema.campaignRecipients.leadId,
    orgId: schema.campaignRecipients.orgId,
    retryCount: schema.campaignRecipients.retryCount,
    nextSendAt: schema.campaignRecipients.nextSendAt,
  })
    .from(schema.campaignRecipients)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignRecipients.campaignId))
    .where(and(
      or(
        eq(schema.campaignRecipients.state, 'pending'),
        and(
          eq(schema.campaignRecipients.state, 'failed'),
          sql`${schema.campaignRecipients.retryCount} < 3`,
          or(
            isNull(schema.campaignRecipients.nextSendAt),
            lte(schema.campaignRecipients.nextSendAt, new Date()),
          ),
        ),
      ),
      eq(schema.campaigns.status, 'running'),
      opts.campaignId ? eq(schema.campaignRecipients.campaignId, opts.campaignId) : sql`true`,
    ))
    .orderBy(asc(schema.campaignRecipients.id))
    .limit(opts.maxToSend);

  /* Pre-fetch all campaigns, leads, orgs, and signals to eliminate N+1 queries. */
  if (recipients.length === 0) return { sent: 0, skipped: 0, failed: 0 };
  const campaignIds = [...new Set(recipients.map(r => r.campaignId))];
  const leadIds = recipients.map(r => r.leadId);
  const orgIds = [...new Set(recipients.map(r => r.orgId))];

  const [campRows, leadRows, orgRows, signalRows] = await Promise.all([
    db.select().from(schema.campaigns).where(inArray(schema.campaigns.id, campaignIds)),
    db.select().from(schema.leads).where(inArray(schema.leads.id, leadIds)),
    db.select().from(schema.organizations).where(inArray(schema.organizations.id, orgIds)),
    db.select().from(schema.leadSignals).where(inArray(schema.leadSignals.leadId, leadIds)),
  ]);
  const campMap = new Map(campRows.map(c => [c.id, c]));
  const leadMap = new Map(leadRows.map(l => [l.id, l]));
  const orgMap = new Map(orgRows.map(o => [o.id, o]));
  const signalMap = new Map(signalRows.map(s => [s.leadId, s]));

  /* Pre-fetch saturation data for all postal codes to avoid per-recipient DB lookups. */
  const postalCodes = [...new Set(leadRows.map(l => l.postalCode).filter((p): p is string => !!p))];
  const satMap = new Map<string, { action: 'allow' | 'block'; saturationPct: number; reason?: string }>();
  for (const postal of postalCodes) {
    const firstLead = leadRows.find(l => l.postalCode === postal);
    if (firstLead) {
      const satResult = await checkSaturationBeforeSend(db, {
        orgId: firstLead.orgId,
        niche: firstLead.niche,
        postalCode: postal,
      });
      satMap.set(`${firstLead.orgId}|${firstLead.niche}|${postal}`, satResult);
    }
  }

  for (const r of recipients) {
    const camp = campMap.get(r.campaignId);
    const lead = leadMap.get(r.leadId);
    const org = orgMap.get(r.orgId);
    if (!camp || !org) { skipped++; continue; }
    if (!lead) { skipped++; await markSkipped(db, r.rid, 'no_lead'); continue; }

    /* Pick a sender mailbox (needed by computeDecision for identity). */
    const picked = await pickMailbox(db, org.id, {
      policy: 'reputation_weighted',
      senderDomainId: camp.senderDomainId ?? undefined,
    });

    const sat = lead.postalCode
      ? (satMap.get(`${org.id}|${lead.niche}|${lead.postalCode}`) ?? { action: 'allow' as const, saturationPct: 0 })
      : { action: 'allow' as const, saturationPct: 0 };

    const decision = computeDecision(camp, lead, org, signalMap.get(lead.id), sat, picked, cfg);

    if (!decision.shouldSend) {
      await markSkipped(db, r.rid, decision.skipReason ?? 'decision_skip');
      skipped++;
      continue;
    }
    /* lead.email is confirmed non-null by computeDecision; assert for TypeScript. */
    const email = lead.email!;

    const { senderIdentity, template: tpl, subjectOverrides } = decision;
    const signals = signalMap.get(lead.id);

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
      fromName: senderIdentity.fromName,
      fromSignoff: org.name,
      subjectOverrides,
    });
    const msgId = `<${randomUUID()}@${cfg.org.outreachSubdomain}>`;
    const final = finalRender({
      rendered,
      to: email,
      leadEmail: email,
      orgScopeKey: org.id,
      campaignId: camp.id,
      identity: {
        fromName: senderIdentity.fromName,
        fromEmail: senderIdentity.fromEmail,
        replyTo: senderIdentity.replyTo,
        unsubMailto: senderIdentity.replyTo,
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
        to: email,
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
        senderMailboxId: picked?.id ?? null,
        firstSentAt: new Date(),
      }).where(eq(schema.campaignRecipients.id, r.rid));
      await db.update(schema.campaigns).set({ sentCount: sql`${schema.campaigns.sentCount} + 1` })
        .where(eq(schema.campaigns.id, camp.id));
      await db.update(schema.leads).set({ status: 'contacted', lastContactedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
      if (picked) {
        await recordSendOutcome(db, { mailboxId: picked.id, status: 'sent' });
      }
      await emitEvent(db, org.id, 'lead.contacted', 'lead', lead.id, {
        campaignId: camp.id, recipientId: r.rid, providerMessageId: out.providerMessageId,
      });
      sent++;
    } catch (e: any) {
      const retryCount = r.retryCount ?? 0;
      if (retryCount < 3) {
        const backoffMs = Math.pow(2, retryCount) * 5 * 60_000;
        await db.update(schema.campaignRecipients).set({
          state: 'failed',
          skipReason: e?.message ?? 'send_failed',
          retryCount: retryCount + 1,
          nextSendAt: new Date(Date.now() + backoffMs),
        }).where(eq(schema.campaignRecipients.id, r.rid));
      } else {
        const failReason = `max_retries:${e?.message ?? 'send_failed'}`;
        await db.update(schema.campaignRecipients).set({
          state: 'failed',
          skipReason: failReason,
        }).where(eq(schema.campaignRecipients.id, r.rid));
        /* Archive to dead letter queue for operator review + manual replay. */
        await db.insert(schema.deadLetters).values({
          orgId: r.orgId,
          campaignId: r.campaignId,
          leadId: r.leadId,
          recipientId: r.rid,
          failReason,
          lastError: e?.message ?? 'send_failed',
        });
        const camp2 = campMap.get(r.campaignId);
        await emitEvent(db, r.orgId, 'send.dead_lettered', 'campaign', r.campaignId, {
          recipientId: r.rid, leadId: r.leadId, error: e?.message ?? 'send_failed',
          campaignName: camp2?.name,
        });
      }
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
