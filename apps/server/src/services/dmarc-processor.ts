/**
 * DMARC aggregate-report processing.
 *
 * Mailbox providers email a daily zipped XML report to the `rua=` address in our
 * DMARC record (ops@keresai.com). This tick reads those reports over IMAP,
 * decompresses (.zip or .gz), parses the XML, and stores a simple pass/fail
 * summary in `dmarc_reports` — so the operator sees "100% authenticated" instead
 * of zip attachments, and we can spot SPF/DKIM alignment regressions early.
 */
import zlib from 'node:zlib';
import { sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import { getConfig } from '../config.js';
import { ImapClient } from './imap-client.js';

export interface DmarcSummary {
  reportId: string; orgName: string | null; domain: string | null; policy: string | null;
  dateBegin: Date | null; dateEnd: Date | null;
  totalMessages: number; dmarcPass: number; dmarcFail: number; spfPass: number; dkimPass: number;
  rows: Array<{ sourceIp: string | null; count: number; dkimAligned: string | null; spfAligned: string | null; disposition: string | null }>;
}

const tag = (xml: string, name: string): string | null => xml.match(new RegExp(`<${name}>([^<]+)</${name}>`, 'i'))?.[1]?.trim() ?? null;

/** Parse a DMARC aggregate XML into a flat summary. Pure. */
export function parseDmarcXml(xml: string): DmarcSummary {
  const meta = xml.match(/<report_metadata>([\s\S]*?)<\/report_metadata>/i)?.[1] ?? '';
  const beginS = Number(meta.match(/<begin>(\d+)/)?.[1] ?? 0);
  const endS = Number(meta.match(/<end>(\d+)/)?.[1] ?? 0);
  const policy = xml.match(/<policy_published>([\s\S]*?)<\/policy_published>/i)?.[1] ?? '';

  let totalMessages = 0, dmarcPass = 0, dmarcFail = 0, spfPass = 0, dkimPass = 0;
  const rows: DmarcSummary['rows'] = [];
  for (const rec of xml.matchAll(/<record>([\s\S]*?)<\/record>/gi)) {
    const b = rec[1]!;
    const count = Number(tag(b, 'count') ?? 0);
    const pe = b.match(/<policy_evaluated>([\s\S]*?)<\/policy_evaluated>/i)?.[1] ?? '';
    const dkimAligned = tag(pe, 'dkim');
    const spfAligned = tag(pe, 'spf');
    const ar = b.match(/<auth_results>([\s\S]*?)<\/auth_results>/i)?.[1] ?? '';
    const rawDkim = ar.match(/<dkim>[\s\S]*?<result>([^<]+)/i)?.[1];
    const rawSpf = ar.match(/<spf>[\s\S]*?<result>([^<]+)/i)?.[1];
    totalMessages += count;
    /* DMARC passes if EITHER mechanism is aligned-pass. */
    if (dkimAligned === 'pass' || spfAligned === 'pass') dmarcPass += count; else dmarcFail += count;
    if (rawSpf === 'pass') spfPass += count;
    if (rawDkim === 'pass') dkimPass += count;
    rows.push({ sourceIp: tag(b, 'source_ip'), count, dkimAligned, spfAligned, disposition: tag(pe, 'disposition') });
  }
  return {
    reportId: tag(meta, 'report_id') ?? `${tag(meta, 'org_name')}-${beginS}`,
    orgName: tag(meta, 'org_name'), domain: tag(policy, 'domain'), policy: tag(policy, 'p'),
    dateBegin: beginS ? new Date(beginS * 1000) : null, dateEnd: endS ? new Date(endS * 1000) : null,
    totalMessages, dmarcPass, dmarcFail, spfPass, dkimPass, rows,
  };
}

/** Extract the report XML from a raw email (.gz or single-file .zip attachment). */
export function extractReportXml(rawEmail: string): string | null {
  const blocks = rawEmail.match(/(?:\r?\n\r?\n)((?:[A-Za-z0-9+/=]{20,}\r?\n)+)/g) ?? [];
  for (const blk of blocks) {
    let buf: Buffer;
    try { buf = Buffer.from(blk.replace(/\s/g, ''), 'base64'); } catch { continue; }
    try {
      if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');   // .gz
      if (buf[0] === 0x50 && buf[1] === 0x4b) {                                                // .zip (PK)
        const method = buf.readUInt16LE(8), compSize = buf.readUInt32LE(18);
        const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
        const data = buf.subarray(start, compSize > 0 ? start + compSize : buf.length);
        return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
      }
    } catch { /* try next block */ }
  }
  return null;
}

export async function tickDmarcReports(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg.imap.enabled || !cfg.imap.user || !cfg.imap.pass) return { skipped: 'disabled' };
  const org = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
  if (!org) return { skipped: 'no_org' };

  const client = new ImapClient(cfg.imap);
  let stored = 0, scanned = 0;
  try {
    await client.connect(); await client.login(); await client.selectInbox();
    const ids = await client.search('SUBJECT "Report domain:"');
    for (const id of ids.slice(-100)) {
      scanned++;
      let raw: string;
      try { raw = await client.fetchRaw(id); } catch { continue; }
      const xml = extractReportXml(raw);
      if (!xml) continue;
      const s = parseDmarcXml(xml);
      const r = await db.insert(schema.dmarcReports).values({
        orgId: org.id, reportId: s.reportId, orgName: s.orgName, domain: s.domain, policy: s.policy,
        dateBegin: s.dateBegin, dateEnd: s.dateEnd, totalMessages: s.totalMessages,
        dmarcPass: s.dmarcPass, dmarcFail: s.dmarcFail, spfPass: s.spfPass, dkimPass: s.dkimPass,
        rows: s.rows as unknown as Record<string, unknown>,
      }).onConflictDoNothing();
      stored += r.rowCount ?? 0;
    }
  } catch (e) {
    log.warn({ err: e }, 'dmarc processing failed');
    return { error: (e as Error).message, scanned };
  } finally {
    await client.logout();
  }
  if (stored > 0) log.info({ scanned, stored }, 'dmarc reports processed');
  return { scanned, stored };
}

/** Aggregate summary for the UI/API. */
export async function dmarcSummary(db: Database): Promise<{
  reports: number; totalMessages: number; dmarcPass: number; passPct: number | null; latest: Date | null;
}> {
  const since = new Date(Date.now() - 14 * 86400_000);
  const r = (await db.execute(sql`
    SELECT count(*)::int AS reports,
           coalesce(sum(total_messages),0)::int AS total,
           coalesce(sum(dmarc_pass),0)::int AS pass,
           max(date_end) AS latest
    FROM dmarc_reports WHERE created_at > ${since}
  `)) as unknown as { rows?: Array<{ reports: number; total: number; pass: number; latest: string | null }> };
  const row = row0(r);
  const total = Number(row?.total ?? 0);
  return {
    reports: Number(row?.reports ?? 0),
    totalMessages: total,
    dmarcPass: Number(row?.pass ?? 0),
    passPct: total > 0 ? Math.round((Number(row?.pass ?? 0) / total) * 100) : null,
    latest: row?.latest ? new Date(row.latest) : null,
  };
}
function row0<T>(r: { rows?: T[] }): T | undefined { return r.rows?.[0]; }
