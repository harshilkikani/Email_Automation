/**
 * Lightweight website probe: HEAD/GET for web_presence classification + email
 * extraction from /contact + /about. Plain HTML only — no JS execution.
 */
import { request } from 'undici';
import * as cheerio from 'cheerio';
import type { WebPresenceLevel } from '@keres/core';

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

  private async realFetch(url: string): Promise<{ status: number; html: string; finalUrl: string }> {
    const res = await request(url, {
      method: 'GET',
      maxRedirections: 4,
      headers: { 'User-Agent': this.cfg.userAgent ?? 'KeresAI/0.1' },
      headersTimeout: 8_000,
      bodyTimeout: 10_000,
    });
    const html = await res.body.text();
    return { status: res.statusCode, html, finalUrl: url };
  }
}

function normalizeUrl(s: string): string {
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function collectEmails($: cheerio.CheerioAPI, raw: string): string[] {
  const out = new Set<string>();
  $('a[href^="mailto:"]').each((_, a) => {
    const h = $(a).attr('href') ?? '';
    const m = h.match(/^mailto:([^?]+)/i);
    if (m && m[1]) out.add(m[1]!.trim().toLowerCase());
  });
  const RE = /[a-zA-Z0-9_.+\-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
  for (const m of raw.match(RE) ?? []) out.add(m.toLowerCase());
  return [...out].filter(e => !/(\.png|\.jpg|\.svg|@sentry|@example|wixpress|gravatar)/.test(e));
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
