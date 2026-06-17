/**
 * Instant reply auto-responder (speed-to-lead).
 *
 * When a prospect replies positively, the first company to respond wins ~78% of
 * the time, and replying within minutes makes a lead ~21x more likely to qualify
 * (vs. letting it sit). The reply branch FSM otherwise leaves a positive reply
 * sitting in `engaged` until a human looks — this closes that gap by sending a
 * short, threaded 1:1 acknowledgement the moment the reply is ingested.
 *
 * Policy:
 *  - Only fires on clearly-positive intents (interested / conditional / referral)
 *    and never on auto-replies (OOO) — those would create mail loops.
 *  - Reply-only by default (asks for phone + a time, no link), honoring the
 *    firm copy policy; a booking link is opt-in via AUTO_RESPONDER_BOOKING_LINK.
 *  - Exactly one auto-ack per lead (idempotent via leads.auto_responded_at, claimed
 *    atomically before the send so concurrent ingests can't double-send).
 *  - Sets Auto-Submitted: auto-replied + threads via In-Reply-To/References.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import { cleanFirstName, pickSignoffName } from '@keres/core';
import { getConfig } from '../config.js';
import { getOutbound } from './sender-factory.js';
import { saveToSentFolder } from './imap-client.js';
import { writeAudit } from './audit.js';
import { obs } from '../observability.js';

const POSITIVE_INTENTS = new Set(['interested', 'conditional', 'referral']);

/** Tiny stable hash → deterministic variety per reply without pulling in a dep. */
function seedIdx(seed: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) % mod;
}

export interface AutoReplyComposeInput {
  firstName: string | null;
  business: string;
  persona: string;
  bookingLink: string | null;
  seed: string;
}

/** Pure body composer — short, warm, link-free by default. Exported for tests. */
export function composeAutoReplyBody(input: AutoReplyComposeInput): string {
  const { firstName, business, persona, bookingLink, seed } = input;
  const greet = firstName ? `Hi ${firstName},` : 'Hi there,';
  const thanks = [
    `Thanks for getting back to me — really appreciate it.`,
    `Great to hear from you, thanks for the reply.`,
    `Thanks for the quick reply — glad this is on your radar.`,
  ][seedIdx(seed, 3)];
  const ask = bookingLink
    ? [
        `The fastest way to show you what this would look like for ${business} is a quick 5-minute call. Grab whatever time works here: ${bookingLink} — or just reply with your best number and I'll call you.`,
        `Easiest next step is a quick 5-minute call so I can tailor it to ${business}. Pick a time here: ${bookingLink}, or send me your best number and a time that works.`,
      ][seedIdx(seed + 'b', 2)]
    : [
        `The fastest way to show you what this would look like for ${business} is a quick 5-minute call. What's the best number to reach you, and a couple of times that work in the next day or two?`,
        `Easiest next step is a quick 5-minute call so I can tailor it to ${business}. What number's best, and when works for you over the next day or so?`,
        `Want me to put together a quick example for ${business}? If a 5-minute call is easier, send your best number and a time that suits you.`,
      ][seedIdx(seed + 'b', 3)];
  return `${greet}\n\n${thanks} ${ask}\n\n${persona}`;
}

function q(s: string): string {
  return /[",<>@]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
function angle(id: string | null | undefined, fallbackDomain: string): string {
  if (!id) return `<${Date.now().toString(36)}@${fallbackDomain}>`;
  return id.startsWith('<') ? id : `<${id}>`;
}

export interface AutoRespondResult {
  sent?: boolean; messageId?: string; skipped?: string; error?: string;
}

/**
 * Send an instant acknowledgement for the given inbound message, if eligible.
 * Best-effort: callers should not let failures block the inbound ack.
 */
export async function maybeAutoRespond(
  db: Database,
  inboundId: string,
  log?: FastifyBaseLogger,
): Promise<AutoRespondResult> {
  const cfg = getConfig();
  if (!cfg.autoResponder.enabled || cfg.sampleMode) return { skipped: 'disabled' };

  const msg = (await db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, inboundId)).limit(1))[0];
  if (!msg || !msg.leadId) return { skipped: 'no_lead' };
  if (msg.isAutoReply) return { skipped: 'auto_reply' };
  const intent = (msg.manualIntent ?? msg.autoIntent ?? 'unknown');
  if (!POSITIVE_INTENTS.has(intent)) return { skipped: `intent_${intent}` };

  const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, msg.leadId)).limit(1))[0];
  if (!lead || !lead.email) return { skipped: 'no_email' };
  if (lead.autoRespondedAt) return { skipped: 'already' };
  if (['unsubscribed', 'dnc', 'bounced'].includes(lead.status)) return { skipped: 'suppressed' };

  const org = (await db.select().from(schema.organizations).where(eq(schema.organizations.id, msg.orgId)).limit(1))[0];
  const fromEmail = org?.fromEmail ?? cfg.org.fromEmail;
  const fromDomain = fromEmail.split('@')[1] ?? 'keresai.com';
  const replyTo = org?.replyTo ?? cfg.org.replyTo;
  const persona = pickSignoffName(lead.id, cfg.org.signoffNames) ?? org?.fromName ?? cfg.org.fromName;
  const firstName = cleanFirstName(lead.ownerName);
  const bookingLink = cfg.autoResponder.includeBookingLink ? cfg.org.defaultBookingLink : null;

  const body = composeAutoReplyBody({ firstName, business: lead.name, persona, bookingLink, seed: msg.id });

  const baseSubject = (msg.subject ?? '').replace(/^(re:\s*)+/i, '').trim() || 'your reply';
  const subject = `Re: ${baseSubject}`;
  const ourMessageId = `<ar-${msg.id}-${Date.now().toString(36)}@${fromDomain}>`;
  const inReplyTo = angle(msg.providerMessageId, fromDomain);

  /* Build the raw 1:1 reply directly — no bulk/List-Unsubscribe markers so it
     reads as a genuine human reply. CAN-SPAM opt-out + address kept in-footer. */
  const addr = org?.physicalAddress || cfg.org.physicalAddress;
  const footer = [`\n\n--`, persona, org?.name ?? cfg.org.name, addr, `Reply "stop" and I'll take you off the list.`]
    .filter(Boolean).join('\n');
  const headers: Record<string, string> = {
    From: `${q(persona)} <${fromEmail}>`,
    'Reply-To': replyTo,
    To: lead.email,
    Subject: subject,
    Date: new Date().toUTCString(),
    'Message-ID': ourMessageId,
    'In-Reply-To': inReplyTo,
    References: inReplyTo,
    'Auto-Submitted': 'auto-replied',
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset=UTF-8',
  };
  const rawMessage = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n' + body + footer + '\n';

  /* Claim the lead atomically BEFORE sending — only the writer that flips
     auto_responded_at from NULL proceeds, so concurrent ingests can't double-send. */
  const claimed = await db.update(schema.leads)
    .set({ autoRespondedAt: new Date() })
    .where(and(eq(schema.leads.id, lead.id), isNull(schema.leads.autoRespondedAt)))
    .returning({ id: schema.leads.id });
  if (claimed.length === 0) return { skipped: 'already' };

  try {
    const res = await getOutbound().send({ to: lead.email, subject, rawMessage, customMessageId: ourMessageId });
    if (cfg.imap.saveToSent) await saveToSentFolder(cfg.imap, rawMessage).catch(() => undefined);
    await writeAudit('auto_responded', lead.id, { orgId: msg.orgId, inboundId: msg.id, provider: res.provider });
    obs().meter.gauge('auto_responses_sent_total', 1);
    log?.info({ leadId: lead.id, to: lead.email, intent }, 'auto-responder sent');
    return { sent: true, messageId: res.providerMessageId };
  } catch (e) {
    /* Release the claim so a later attempt can retry. */
    await db.update(schema.leads).set({ autoRespondedAt: null }).where(eq(schema.leads.id, lead.id)).catch(() => undefined);
    obs().captureException(e, { leadId: lead.id, op: 'auto_respond' });
    log?.warn({ err: e, leadId: lead.id }, 'auto-responder send failed');
    return { error: (e as Error).message };
  }
}
