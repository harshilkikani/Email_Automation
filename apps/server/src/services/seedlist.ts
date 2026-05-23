/**
 * Seedlist test-send.
 *
 * Sends a real (or mock, in sample mode) email to one of the configured
 * seedlist mailboxes from the sender domain. On success, updates the domain's
 * `last_seedlist_pass_at` so the launch gate accepts it.
 *
 * This is the only code path that may send outside a campaign — so it has its
 * own safety checks and never reuses a campaign template.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { buildHeaders, renderRawMessage, canSpamFooter, signUnsubscribeToken, unsubscribeUrl } from '@keres/email';
import { getConfig } from '../config.js';
import { getOutbound } from './sender-factory.js';

export interface SeedlistResult {
  ok: boolean;
  sent: number;
  failed: number;
  error?: string;
  results: Array<{ to: string; ok: boolean; providerMessageId?: string; error?: string }>;
}

export async function sendSeedlistTest(
  db: Database, senderDomainId: string, toOverride?: string, subjectOverride?: string,
): Promise<SeedlistResult> {
  const cfg = getConfig();
  const domain = (await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.id, senderDomainId)).limit(1))[0];
  if (!domain) return { ok: false, sent: 0, failed: 0, error: 'sender_domain_not_found', results: [] };
  const org = (await db.select().from(schema.organizations).where(eq(schema.organizations.id, domain.orgId)).limit(1))[0];
  if (!org) return { ok: false, sent: 0, failed: 0, error: 'org_not_found', results: [] };

  if (!org.physicalAddress || !org.fromName || !org.fromEmail || !org.replyTo) {
    return { ok: false, sent: 0, failed: 0, error: 'sender_identity_incomplete', results: [] };
  }

  const recipients = toOverride
    ? [toOverride]
    : cfg.seedlistEmails;
  if (recipients.length === 0) {
    return { ok: false, sent: 0, failed: 0, error: 'no_seedlist_configured', results: [] };
  }

  const provider = getOutbound();
  const results: SeedlistResult['results'] = [];
  let sent = 0, failed = 0;

  for (const to of recipients) {
    /* Persist a placement-tracker row up-front. */
    const seedRow = (await db.insert(schema.seedlistTests).values({
      orgId: org.id, senderDomainId, mailbox: to,
    }).returning({ id: schema.seedlistTests.id }))[0];

    const token = signUnsubscribeToken(
      { email: to, scope: org.id, campaignId: undefined },
      cfg.unsubscribeSigningSecret,
    );
    const url = unsubscribeUrl(cfg.publicBaseUrl, token);
    const body = [
      `Hi — this is a deliverability test from ${org.name}.`,
      ``,
      `If you can read this in your inbox (not spam), DNS and headers are working.`,
      ``,
      canSpamFooter({
        fromName: org.fromName, fromEmail: org.fromEmail, replyTo: org.replyTo,
        unsubMailto: org.replyTo, publicBaseUrl: cfg.publicBaseUrl,
        physicalAddress: org.physicalAddress, orgName: org.name,
      }, url),
    ].join('\n');
    const headers = buildHeaders({
      identity: {
        fromName: org.fromName, fromEmail: org.fromEmail, replyTo: org.replyTo,
        unsubMailto: org.replyTo, publicBaseUrl: cfg.publicBaseUrl,
        physicalAddress: org.physicalAddress, orgName: org.name,
      },
      to,
      subject: subjectOverride ?? `Seedlist test — ${org.name}`,
      unsubscribeToken: token,
      messageId: `<seed-${randomUUID()}@${cfg.org.outreachSubdomain}>`,
    });
    const raw = renderRawMessage(headers, body);
    try {
      const out = await provider.send({
        to, subject: headers.Subject, rawMessage: raw,
        configurationSet: cfg.ses.configurationSet,
      });
      sent++;
      if (seedRow) {
        await db.update(schema.seedlistTests)
          .set({ providerMessageId: out.providerMessageId })
          .where(eq(schema.seedlistTests.id, seedRow.id));
      }
      results.push({ to, ok: true, providerMessageId: out.providerMessageId });
    } catch (e: any) {
      failed++;
      results.push({ to, ok: false, error: e?.message ?? String(e) });
    }
  }

  await db.update(schema.senderDomains).set({
    lastSeedlistTestAt: new Date(),
    lastSeedlistPassAt: sent > 0 && failed === 0 ? new Date() : domain.lastSeedlistPassAt,
  }).where(eq(schema.senderDomains.id, senderDomainId));

  return { ok: failed === 0, sent, failed, results };
}
