/**
 * Bounce / NDR processing for plain mailboxes (Spacemail has no bounce webhook).
 *
 * Spacemail returns undeliverable mail to the sender as a Mailer-Daemon NDR in
 * the ops@ inbox. This tick polls that mailbox over IMAP, parses the bounced
 * recipients out of each NDR, and for HARD bounces: suppresses the address,
 * marks the lead `bounced`, and records a `bounce` email_event so the launch
 * gate's 24h bounce-rate check can auto-pause sending. Idempotent — re-running
 * is harmless (suppression + event inserts use ON CONFLICT DO NOTHING).
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import { getConfig } from '../config.js';
import { ImapClient } from './imap-client.js';

export interface ParsedBounce { email: string; hard: boolean }
export interface ParsedNdr { messageId: string | null; bounces: ParsedBounce[] }

/* Daemon/system senders that can appear as a recipient line — never a real
   prospect. (Our OWN mailbox is excluded separately by domain.) */
const OUR_LOCALS = /^(mailer-daemon|postmaster|no-?reply|noreply)@/i;

/** Parse a raw NDR message into the bounced recipients + hardness. Pure. */
export function parseNdr(raw: string, ownDomain = 'keresai.com'): ParsedNdr {
  const messageId = raw.match(/^Message-ID:\s*<([^>]+)>/im)?.[1] ?? null;

  /* Hard if any 5.x.x DSN status / 5xx SMTP code appears; soft only if it's
     purely a 4.x.x (greylist / temporary) NDR. */
  const hasHard = /(^|\s)Status:\s*5\.\d+\.\d+/im.test(raw)
    || /Diagnostic-Code:[^\n]*\b5\d\d\b/i.test(raw)
    || /\bsaid:\s*5\d\d\b/i.test(raw)
    || /\b5\d\d[ -]5\.\d\.\d/.test(raw);
  const hasSoft = /(^|\s)Status:\s*4\.\d+\.\d+/im.test(raw) || /\b4\d\d[ -]4\.\d\.\d/.test(raw);
  const hard = hasHard || !hasSoft;

  const emails = new Set<string>();
  for (const re of [
    /(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/gi,
    /<([^\s<>@]+@[^\s<>]+\.[^\s<>]+)>:\s*(?:host|smtp|Recipient|said)/gi,
  ]) {
    for (const m of raw.matchAll(re)) emails.add(m[1]!.toLowerCase().replace(/[.,;]+$/, ''));
  }

  const bounces: ParsedBounce[] = [];
  for (const email of emails) {
    if (email.endsWith('@' + ownDomain)) continue;     // our own envelope/from
    if (OUR_LOCALS.test(email)) continue;
    bounces.push({ email, hard });
  }
  return { messageId, bounces };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function imapDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

export async function tickBounceProcessing(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg.imap.enabled || !cfg.imap.user || !cfg.imap.pass) return { skipped: 'disabled' };
  const org = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
  if (!org) return { skipped: 'no_org' };
  const ownDomain = (cfg.smtp.fromEmail.split('@')[1] ?? 'keresai.com').toLowerCase();

  const client = new ImapClient(cfg.imap);
  let suppressed = 0, marked = 0, scanned = 0;
  try {
    await client.connect();
    await client.login();
    await client.selectInbox();
    const since = imapDate(Date.now() - 3 * 86400_000);
    const ids = new Set<number>();
    for (const crit of [`SINCE ${since} FROM "MAILER-DAEMON"`, `SINCE ${since} SUBJECT "Undeliverable"`, `SINCE ${since} SUBJECT "Undelivered"`]) {
      for (const id of await client.search(crit)) ids.add(id);
    }
    for (const id of [...ids].slice(-200)) {
      scanned++;
      let raw: string;
      try { raw = await client.fetchRaw(id); } catch { continue; }
      const { messageId, bounces } = parseNdr(raw, ownDomain);
      for (const b of bounces) {
        if (!b.hard) continue;
        const sup = await db.insert(schema.suppressions)
          .values({ orgId: org.id, email: b.email, scope: 'org', reason: 'hard_bounce', sourceEvent: 'hard_bounce' })
          .onConflictDoNothing();
        suppressed += sup.rowCount ?? 0;
        const lead = (await db.select({ id: schema.leads.id })
          .from(schema.leads)
          .where(sql`lower(${schema.leads.email}) = ${b.email} AND ${schema.leads.orgId} = ${org.id}`)
          .limit(1))[0];
        if (lead) {
          await db.update(schema.leads).set({ status: 'bounced' })
            .where(sql`${schema.leads.id} = ${lead.id} AND ${schema.leads.status} NOT IN ('unsubscribed','dnc')`);
          marked++;
        }
        await db.insert(schema.emailEvents).values({
          orgId: org.id,
          leadId: lead?.id ?? null,
          eventType: 'bounce',
          bounceType: 'hard',
          providerMessageId: `ndr:${messageId ?? id}:${b.email}`,
          occurredAt: new Date(),
          rawPayload: { source: 'imap_ndr', email: b.email } as Record<string, unknown>,
        }).onConflictDoNothing();
      }
    }
  } catch (e) {
    log.warn({ err: e }, 'bounce processing failed');
    return { error: (e as Error).message, scanned };
  } finally {
    await client.logout();
  }
  if (suppressed > 0 || marked > 0) log.info({ scanned, suppressed, marked }, 'bounce processing');
  return { scanned, suppressed, marked };
}
