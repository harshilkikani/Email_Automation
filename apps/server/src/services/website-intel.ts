/**
 * Website intelligence orchestrator.
 *
 * Fetches a lead's website (home + /contact + /about + /services), runs the
 * deterministic extractors from @keres/core, and upserts a website_intel row.
 *
 * Calls are concurrency-limited to be polite (we already ship a 1-RPS scraper
 * via undici with conservative timeouts). The `tickWebsiteIntelRefresh`
 * scheduler tick walks newly-discovered leads that have a website but no
 * intel row.
 */
import { and, eq, isNull, sql, desc } from 'drizzle-orm';
import { request } from 'undici';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import { extractIntel, emptyIntel, type ExtractedIntel } from '@keres/core';
import { getConfig } from '../config.js';
import { obs } from '../observability.js';

const PROBE_PATHS = ['', '/contact', '/about', '/services'];
const PER_REQUEST_TIMEOUT_MS = 8_000;
const MAX_BYTES_PER_PAGE = 1_500_000;

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
}

export type Fetcher = (url: string) => Promise<FetchedPage>;

export interface RefreshOptions {
  /** Override the network fetcher (tests, sample mode). */
  fetcher?: Fetcher;
  /** Hard cap on total milliseconds per lead. */
  budgetMs?: number;
}

export async function refreshWebsiteIntelForLead(
  db: Database,
  leadId: string,
  opts: RefreshOptions = {},
): Promise<{ ok: boolean; intel?: ExtractedIntel; reason?: string }> {
  const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1))[0];
  if (!lead) return { ok: false, reason: 'lead_not_found' };
  if (!lead.website) return { ok: false, reason: 'no_website' };
  const fetcher = opts.fetcher ?? defaultFetcher;
  const baseUrl = normalizeUrl(lead.website);
  const budgetMs = opts.budgetMs ?? 25_000;
  const deadline = Date.now() + budgetMs;

  let homePage: FetchedPage | null = null;
  const extraHtml: string[] = [];
  let language: string | null = null;
  for (const p of PROBE_PATHS) {
    if (Date.now() > deadline) break;
    try {
      const target = p === '' ? baseUrl : new URL(p, baseUrl).toString();
      const page = await fetcher(target);
      if (p === '') homePage = page;
      else if (page.status >= 200 && page.status < 400) extraHtml.push(page.html);
      if (!language && page.html) {
        const m = page.html.match(/<html[^>]+lang="([^"]+)"/i);
        if (m) language = m[1] ?? null;
      }
    } catch (e) {
      obs().captureException(e, { leadId, path: p, baseUrl });
    }
  }

  if (!homePage || homePage.status >= 400) {
    /* Mark as a dead/erroring site; still record so we don't re-probe forever. */
    await upsertIntel(db, lead, {
      ...emptyIntel(),
      evidence: { reason: 'home_unreachable', status: homePage?.status ?? null, baseUrl },
    }, baseUrl, homePage?.finalUrl ?? baseUrl, homePage?.status ?? 0);
    return { ok: false, reason: 'home_unreachable' };
  }

  const intel = extractIntel({
    homeHtml: homePage.html,
    homeUrl: baseUrl,
    finalUrl: homePage.finalUrl,
    extraHtml,
    language,
  });
  await upsertIntel(db, lead, intel, baseUrl, homePage.finalUrl, homePage.status);
  obs().meter.counter('website_intel_refreshed');
  return { ok: true, intel };
}

async function upsertIntel(
  db: Database,
  lead: typeof schema.leads.$inferSelect,
  intel: ExtractedIntel,
  baseUrl: string,
  finalUrl: string,
  status: number,
): Promise<void> {
  await db.insert(schema.websiteIntel).values({
    leadId: lead.id,
    orgId: lead.orgId,
    homeUrl: baseUrl,
    finalUrl,
    httpStatus: status,
    techStack: intel.techStack as unknown as string[],
    bookingVendor: intel.bookingVendor,
    emails: intel.emails,
    phones: intel.phones,
    social: intel.social as Record<string, unknown>,
    services: intel.services,
    hoursText: intel.hoursText,
    addressText: intel.addressText,
    yearFounded: intel.yearFounded,
    language: intel.language,
    evidence: intel.evidence as Record<string, unknown>,
  }).onConflictDoUpdate({
    target: schema.websiteIntel.leadId,
    set: {
      homeUrl: baseUrl,
      finalUrl,
      httpStatus: status,
      techStack: intel.techStack as unknown as string[],
      bookingVendor: intel.bookingVendor,
      emails: intel.emails,
      phones: intel.phones,
      social: intel.social as Record<string, unknown>,
      services: intel.services,
      hoursText: intel.hoursText,
      addressText: intel.addressText,
      yearFounded: intel.yearFounded,
      language: intel.language,
      evidence: intel.evidence as Record<string, unknown>,
      fetchedAt: new Date(),
    },
  });

  /* Feed two facts back into lead_signals so scoring picks them up: presence
     of a booking vendor (-10 already in default weights) and dead domain. */
  const hasOnlineBooking = intel.bookingVendor !== null;
  const deadDomain = status >= 400;
  await db.update(schema.leadSignals).set({
    hasOnlineBooking,
    deadDomain,
  }).where(eq(schema.leadSignals.leadId, lead.id));
}

/**
 * Default real fetcher — undici GET with timeouts + a body size cap.
 */
async function defaultFetcher(url: string): Promise<FetchedPage> {
  const cfg = getConfig();
  const res = await request(url, {
    method: 'GET',
    maxRedirections: 4,
    headers: { 'User-Agent': cfg.osm.userAgent || 'KeresAI/0.1' },
    headersTimeout: PER_REQUEST_TIMEOUT_MS,
    bodyTimeout: PER_REQUEST_TIMEOUT_MS,
  });
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    bytes += buf.length;
    if (bytes > MAX_BYTES_PER_PAGE) break;
    chunks.push(buf);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  return { url, finalUrl: url, status: res.statusCode, html };
}

function normalizeUrl(s: string): string {
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

/* ────────── Scheduler tick ────────── */

export async function tickWebsiteIntelRefresh(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  /* Refresh up to 25 leads per tick that have a website + no website_intel
     OR whose intel is older than 30 days. */
  const stale = new Date(Date.now() - 30 * 86400_000);
  const candidates = await db.execute(sql`
    SELECT l.id
    FROM leads l
    LEFT JOIN website_intel w ON w.lead_id = l.id
    WHERE l.deleted_at IS NULL
      AND l.website IS NOT NULL
      AND (w.lead_id IS NULL OR w.fetched_at < ${stale.toISOString()})
    ORDER BY l.score DESC, l.discovered_at DESC
    LIMIT 25
  `);
  const rows = ((candidates as { rows?: Array<{ id: string }> }).rows ?? []) as Array<{ id: string }>;
  let ok = 0, failed = 0;
  for (const r of rows) {
    try {
      const result = await refreshWebsiteIntelForLead(db, r.id);
      if (result.ok) ok++; else failed++;
    } catch (e) {
      failed++;
      obs().captureException(e, { leadId: r.id, op: 'website_intel_refresh' });
    }
  }
  log.info({ refreshed: ok, failed, candidates: rows.length }, 'website intel refresh');
  return { refreshed: ok, failed };
}

/* Silence unused-import linters until other helpers are wired up. */
void and; void isNull; void desc;
