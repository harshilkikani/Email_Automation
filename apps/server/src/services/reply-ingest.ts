/**
 * Reply ingestion for plain mailboxes (Spacemail has no inbound webhook).
 *
 * Polls the ops@ inbox over IMAP and feeds genuine prospect replies into the
 * existing `handleInboundReply` (classify intent + store in inbound_messages +
 * flip the recipient to 'replied'). Only messages whose From matches a lead we
 * actually emailed are ingested — bounces, DMARC reports, our own sent copies,
 * and newsletters are skipped. Idempotent (handleInboundReply de-dupes by id).
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import { getConfig } from '../config.js';
import { ImapClient } from './imap-client.js';
import { handleInboundReply } from './inbound-handler.js';

function decodeMimeWords(s: string): string {
  return s.replace(/=\?[^?]+\?([BQ])\?([^?]*)\?=/gi, (_m, enc: string, txt: string) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(txt, 'base64').toString('utf8');
      return txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16)));
    } catch { return txt; }
  }).replace(/\s+/g, ' ').trim();
}

export interface ParsedEmail { fromEmail: string; toEmail: string; subject: string; messageId: string; textBody: string; receivedAt: Date }

/** Best-effort parse of a raw RFC822 email into the fields a reply needs. */
export function parseEmail(raw: string): ParsedEmail | null {
  const sep = raw.search(/\r?\n\r?\n/);
  const headers = sep >= 0 ? raw.slice(0, sep) : raw;
  const rest = sep >= 0 ? raw.slice(sep) : '';
  const fromRaw = headers.match(/^From:\s*(.+)$/im)?.[1] ?? '';
  const fromEmail = (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail)) return null;
  const toRaw = headers.match(/^To:\s*(.+)$/im)?.[1] ?? '';
  const toEmail = (toRaw.match(/<([^>]+)>/)?.[1] ?? toRaw).trim().toLowerCase();
  const subject = decodeMimeWords(headers.match(/^Subject:\s*(.+)$/im)?.[1] ?? '');
  const dateStr = headers.match(/^Date:\s*(.+)$/im)?.[1];
  const receivedAt = dateStr && !isNaN(Date.parse(dateStr)) ? new Date(dateStr) : new Date();
  const messageId = headers.match(/^Message-I[dD]:\s*<([^>]+)>/im)?.[1] ?? `imap:${fromEmail}:${receivedAt.getTime()}`;

  /* Prefer the text/plain MIME part; else strip tags from whatever's there. */
  let body = rest;
  const tp = rest.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i);
  if (tp?.[1]) body = tp[1];
  const textBody = body
    .replace(/=\r?\n/g, '')                                   // quoted-printable soft breaks
    .replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 4000);
  return { fromEmail, toEmail, subject, messageId, textBody, receivedAt };
}

const SKIP_FROM = /mailer-daemon|postmaster|no-?reply|noreply|notifications?@|@(?:google|brave|neon|openai|github)\b/i;

export async function tickReplyIngest(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg.imap.enabled || !cfg.imap.user || !cfg.imap.pass) return { skipped: 'disabled' };
  const org = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
  if (!org) return { skipped: 'no_org' };
  const ownDomain = (cfg.smtp.fromEmail.split('@')[1] ?? 'keresai.com').toLowerCase();

  const client = new ImapClient(cfg.imap);
  let scanned = 0, ingested = 0;
  try {
    await client.connect();
    await client.login();
    const total = await client.selectInbox();
    for (let id = Math.max(1, total - 40); id <= total; id++) {
      scanned++;
      let raw: string;
      try { raw = await client.fetchRaw(id); } catch { continue; }
      const ev = parseEmail(raw);
      if (!ev) continue;
      if (SKIP_FROM.test(ev.fromEmail) || ev.fromEmail.endsWith('@' + ownDomain)) continue;
      if (/report domain:/i.test(ev.subject)) continue;
      /* Only ingest replies from a lead we actually emailed. */
      const lead = (await db.select({ id: schema.leads.id })
        .from(schema.leads)
        .where(and(eq(schema.leads.orgId, org.id), eq(schema.leads.email, ev.fromEmail)))
        .limit(1))[0];
      if (!lead) continue;
      try {
        await handleInboundReply(db, org.id, {
          providerMessageId: ev.messageId, fromEmail: ev.fromEmail, toEmail: ev.toEmail,
          subject: ev.subject, textBody: ev.textBody, htmlBody: undefined, receivedAt: ev.receivedAt,
        });
        ingested++;
      } catch (e) { log.warn({ err: e, from: ev.fromEmail }, 'reply ingest row failed'); }
    }
  } catch (e) {
    log.warn({ err: e }, 'reply ingest failed');
    return { error: (e as Error).message, scanned };
  } finally {
    await client.logout();
  }
  if (ingested > 0) log.info({ scanned, ingested }, 'reply ingest');
  return { scanned, ingested };
}
