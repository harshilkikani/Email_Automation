/**
 * Lightweight website probe: HEAD/GET for web_presence classification + email
 * extraction from /contact + /about. Plain HTML only — no JS execution.
 */
import { request } from 'undici';
import { lookup } from 'node:dns/promises';
import * as cheerio from 'cheerio';
import type { WebPresenceLevel } from '@keres/core';
import { emailIntakeFilter } from '@keres/core';

/** Per-request hard cap (connect + headers + body). Dead servers fail fast. */
const FETCH_TIMEOUT_MS = 6_000;

function hostnameOf(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

/** Quick DNS check so we skip non-resolving domains entirely instead of eating
 *  multiple multi-second fetch timeouts on them (~a third of scraped sites are dead). */
async function domainResolves(hostname: string, timeoutMs = 2_500): Promise<boolean> {
  try {
    await Promise.race([
      lookup(hostname),
      new Promise<never>((_, rej) => { const t = setTimeout(() => rej(new Error('dns_timeout')), timeoutMs); t.unref?.(); }),
    ]);
    return true;
  } catch (e) {
    /* Only treat a definitive resolution failure as dead. On an ambiguous timeout,
       proceed and let the capped fetch decide — never false-skip a valid domain. */
    return (e as Error)?.message === 'dns_timeout';
  }
}

export interface ProbeResult {
  webPresenceLevel: WebPresenceLevel;
  emails: string[];
  hasOnlineBooking: boolean;
  deadDomain: boolean;
  evidence: Record<string, unknown>;
}

export interface ScraperConfig {
  enabled: boolean;
  userAgent?: string;
  fetcher?: (url: string) => Promise<{ status: number; html: string; finalUrl: string }>;
}

export class Scraper {
  constructor(private cfg: ScraperConfig) {}
  isEnabled() { return this.cfg.enabled; }

  async probe(website: string | null | undefined): Promise<ProbeResult> {
    if (!website) {
      return {
        webPresenceLevel: 'none',
        emails: [], hasOnlineBooking: false, deadDomain: false,
        evidence: { reason: 'no_website_field' },
      };
    }
    const url = normalizeUrl(website);
    const host = hostnameOf(url);
    /* Skip dead domains up front (no real fetcher only — tests inject their own). */
    if (host && !this.cfg.fetcher && !(await domainResolves(host))) {
      return {
        webPresenceLevel: 'none', emails: [], hasOnlineBooking: false, deadDomain: true,
        evidence: { url, reason: 'dns_unresolved' },
      };
    }
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    try {
      const home = await fetcher(url);
      if (home.status >= 400) {
        return {
          webPresenceLevel: 'none', emails: [], hasOnlineBooking: false, deadDomain: true,
          evidence: { url, status: home.status, reason: 'http_error' },
        };
      }
      const $ = cheerio.load(home.html);
      const emails = collectEmails($, home.html);
      const hasBooking = /\b(book (now|online|appointment|service)|schedule (now|online)|calendly|squarespace[- ]?scheduling|housecallpro|servicetitan)\b/i.test(home.html);
      const level = inferWebPresence($, home.html);
      /* Try /contact too if no email yet. */
      if (emails.length === 0) {
        try {
          const contact = await fetcher(new URL('/contact', home.finalUrl).toString());
          if (contact.status >= 200 && contact.status < 400) {
            emails.push(...collectEmails(cheerio.load(contact.html), contact.html));
          }
        } catch { /* ignore */ }
      }
      return {
        webPresenceLevel: level, emails: dedupe(emails),
        hasOnlineBooking: hasBooking, deadDomain: false,
        evidence: { url, finalUrl: home.finalUrl, status: home.status },
      };
    } catch (e: any) {
      return {
        webPresenceLevel: 'none', emails: [], hasOnlineBooking: false, deadDomain: true,
        evidence: { url, error: e?.message ?? String(e) },
      };
    }
  }

  /** People-pages most likely to name the owner/decision-maker. */
  /* Contact pages first — they're the richest for email + were being skipped
     when they sat last in the list under the page budget. */
  static readonly PEOPLE_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/team', '/our-team', '/staff', '/contacts'];

  /**
   * Bounded multi-page crawl for owner/email finding: fetches up to `maxPages` of
   * the given paths, returning all emails + concatenated visible text. Plain HTML
   * only (no JS). Best-effort — failures per page are skipped.
   */
  async deepCrawl(website: string | null | undefined, paths: string[] = Scraper.PEOPLE_PATHS, maxPages = 4): Promise<{ emails: string[]; text: string; pages: number }> {
    if (!website || !this.isEnabled()) return { emails: [], text: '', pages: 0 };
    /* Bail on non-resolving domains before spending any fetch budget. */
    const host0 = hostnameOf(normalizeUrl(website));
    if (host0 && !this.cfg.fetcher && !(await domainResolves(host0))) return { emails: [], text: '', pages: 0 };
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    const emails = new Set<string>();
    let text = '';
    let pages = 0;
    const absorb = (html: string) => {
      const $ = cheerio.load(html);
      for (const e of collectEmails($, html)) emails.add(e);
      $('script, style, noscript').remove();
      text += ' ' + $('body').text().replace(/\s+/g, ' ');
      pages++;
    };
    /* Home first (resolves the final URL), then the people pages IN PARALLEL so a
       slow page doesn't serialize the whole crawl. */
    let base = normalizeUrl(website);
    try {
      const home = await fetcher(base);
      if (home.status >= 200 && home.status < 400) { base = home.finalUrl || base; absorb(home.html); }
    } catch { /* no home → nothing to crawl */ return { emails: [], text: '', pages: 0 }; }

    const wanted = paths.slice(0, Math.max(0, maxPages - 1));
    const results = await Promise.allSettled(wanted.map(async p => {
      const res = await fetcher(new URL(p, base).toString());
      return res.status >= 200 && res.status < 400 ? res.html : null;
    }));
    for (const r of results) if (r.status === 'fulfilled' && r.value) absorb(r.value);

    return { emails: [...emails], text: text.slice(0, 200_000), pages };
  }

  private async realFetch(url: string): Promise<{ status: number; html: string; finalUrl: string }> {
    const res = await request(url, {
      method: 'GET',
      maxRedirections: 4,
      headers: { 'User-Agent': this.cfg.userAgent ?? 'KeresAI/0.1' },
      headersTimeout: 5_000,
      bodyTimeout: FETCH_TIMEOUT_MS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),   // hard total cap incl. connect
    });
    const html = await res.body.text();
    return { status: res.statusCode, html, finalUrl: url };
  }
}

function normalizeUrl(s: string): string {
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

const EMAIL_RE = /[a-zA-Z0-9_.+\-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;

/** Decode a Cloudflare-obfuscated email (data-cfemail / email-protection#hex). */
function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 6 || hex.length % 2) return null;
  const bytes = hex.match(/../g)!.map(h => parseInt(h, 16));
  const key = bytes[0]!;
  let s = '';
  for (let i = 1; i < bytes.length; i++) s += String.fromCharCode(bytes[i]! ^ key);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

/**
 * Extract emails from a page, recovering the ones small-business sites hide:
 * mailto links, Cloudflare protection, JSON-LD, HTML entities, and
 * "name [at] domain [dot] com" style obfuscation. Every recovered address is a
 * business we'd otherwise lose at the email step.
 */
function collectEmails($: cheerio.CheerioAPI, raw: string): string[] {
  const out = new Set<string>();
  const add = (e: string | null | undefined) => { if (e) out.add(e.replace(/^mailto:/i, '').trim().toLowerCase()); };

  /* 1. mailto: links (URL-decoded). */
  $('a[href^="mailto:"]').each((_, a) => {
    const m = ($(a).attr('href') ?? '').match(/^mailto:([^?]+)/i);
    if (m?.[1]) { try { add(decodeURIComponent(m[1])); } catch { add(m[1]); } }
  });

  /* 2. Cloudflare email protection — extremely common on small-biz sites. */
  $('[data-cfemail]').each((_, el) => add(decodeCfEmail($(el).attr('data-cfemail') ?? '')));
  for (const m of raw.matchAll(/(?:data-cfemail="|email-protection#)([0-9a-fA-F]{6,})/g)) add(decodeCfEmail(m[1]!));

  /* 3. JSON-LD / structured data + meta. */
  for (const m of raw.matchAll(/"email"\s*:\s*"([^"]+)"/gi)) add(m[1]);

  /* 4. HTML-entity-encoded @ and . , then plain matches. */
  const deEntity = raw.replace(/&#0*64;|&commat;/gi, '@').replace(/&#0*46;/gi, '.');
  for (const m of deEntity.match(EMAIL_RE) ?? []) add(m);

  /* 5. Obfuscated: "name [at] domain [dot] com" / "name @ domain . com". */
  const OBF = /([a-z0-9._%+\-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|@)\s*([a-z0-9.\-]+?)\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\.)\s*([a-z]{2,24})\b/gi;
  for (const m of raw.matchAll(OBF)) add(`${m[1]}@${m[2]}.${m[3]}`);

  /* Drop scraped junk (placeholders, asset filenames, disposable). */
  return [...out].filter(e => emailIntakeFilter(e).ok);
}

function dedupe<T>(a: T[]): T[] {
  return [...new Set(a)];
}

function inferWebPresence($: cheerio.CheerioAPI, raw: string): WebPresenceLevel {
  /* Heuristic: count signals of a modern CMS vs a one-page Wix vs nothing. */
  const isWix = /<!-- *wix /i.test(raw) || /wixstatic\.com/.test(raw);
  const hasMeta = $('meta[name="viewport"]').length > 0;
  const totalLinks = $('a').length;
  const hasCart = /add[- ]?to[- ]?cart|wc-cart/i.test(raw);
  if (!hasMeta && totalLinks < 5) return 'basic';
  if (hasCart || (totalLinks > 30 && hasMeta)) return 'modern';
  if (isWix && totalLinks < 20) return 'basic';
  return 'basic';
}
