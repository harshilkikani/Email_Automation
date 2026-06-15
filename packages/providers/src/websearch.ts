/**
 * Web-search discovery — free, no map directory. Searches the open web for
 * "{trade} {city} {state}", pulls the businesses' OWN websites from the results
 * (filtering out directories/aggregators/listicles), and hands them to the
 * normal scrape → owner → verify pipeline. This is the "public web crawling"
 * Apollo/Hunter use, and it works for any industry + city.
 *
 * Two backends:
 *  - Brave Search API (when BRAVE_API_KEY is set): a real API — reliable from
 *    servers, free tier ~2k queries/mo. This is the production path.
 *  - DuckDuckGo HTML scrape (no key): works from residential IPs / local dev,
 *    but search engines block datacenter IPs (Fly returns an anomaly page), so
 *    this is a best-effort fallback only.
 *
 * Either way it's best-effort: a block/empty result just yields [] and the
 * other discovery sources still contribute.
 */
import { request } from 'undici';
import * as cheerio from 'cheerio';
import type { LeadCandidate, Niche } from '@keres/core';
import type { DiscoveryProvider, DiscoveryQuery, DiscoveryResult } from './types.js';

export interface WebResult { url: string; title: string; }

export interface WebSearchConfig {
  enabled: boolean;
  userAgent?: string;
  /** Brave Search API key — enables the reliable, server-safe backend. */
  braveApiKey?: string;
  /** Test seam: given a search term, return raw web results. */
  fetcher?: (term: string) => Promise<WebResult[]>;
}

/* Domains that are directories/aggregators/socials — not a business's own site. */
const EXCLUDE = [
  'yelp.', 'yellowpages.', 'yellowbook.', 'superpages.', 'citysearch.', 'dexknows.',
  'facebook.', 'instagram.', 'linkedin.', 'twitter.', 'x.com', 'pinterest.', 'tiktok.',
  'angi.', 'angieslist.', 'thumbtack.', 'homeadvisor.', 'porch.', 'networx.', 'houzz.',
  'bbb.org', 'mapquest.', 'manta.', 'nextdoor.', 'expertise.', 'threebestrated.', 'birdeye.',
  'indeed.', 'glassdoor.', 'ziprecruiter.', 'wikipedia.', 'youtube.', 'reddit.', 'amazon.',
  'tripadvisor.', 'foursquare.', 'merchantcircle.', 'chamberofcommerce.', 'local.com', 'localedge.',
  'justdial.', 'cylex', 'hotfrog.', 'brownbook.', 'ezlocal.', 'elocal.', 'n49.', 'opendi.',
  'find-open.', 'duckduckgo.', 'google.', 'bing.', 'apple.', 'maps.', '.gov', '.edu', 'wikihow.',
  'bestprosintown.', 'plumbersup.', 'statesman.', 'nerdwallet.', 'forbes.', 'usnews.', 'consumeraffairs.',
  'trustpilot.', 'sitejabber.', 'crunchbase.', 'bloomberg.', 'newspaper.', 'news.', 'wikitia.',
];

/* Listicle / "best of" / review-roundup titles — not a single business. */
function isListicle(title: string): boolean {
  return /^\s*\d+\b/.test(title)                                   // "17 Best …"
    || /\b(best|top|greatest)\b.{0,30}\b(near|in|for|of|plumber|hvac|septic|roofer|electrician|contractor)/i.test(title)
    || /\b(according to|reviews? of|directory|listings?|compare|comparison|ranked|rankings)\b/i.test(title);
}

export class WebSearchAdapter implements DiscoveryProvider {
  readonly name = 'websearch';
  constructor(private cfg: WebSearchConfig) {}
  isEnabled() { return this.cfg.enabled; }

  async search(q: DiscoveryQuery): Promise<DiscoveryResult> {
    if (!this.isEnabled()) return { candidates: [], source: 'websearch', attribution: '' };
    const fetcher = this.cfg.fetcher
      ?? (this.cfg.braveApiKey ? this.braveFetch.bind(this) : this.ddgFetch.bind(this));
    /* DuckDuckGo throttles bursts, so keep it to 2 phrasings there; Brave is a
       real API (reliable), so use an extra phrasing for more unique businesses. */
    const terms = q.keyword
      ? [`${q.keyword} ${q.city} ${q.state}`]
      : [`${nicheToQuery(q.niche)} ${q.city} ${q.state}`, `${nicheToQuery(q.niche)} near ${q.city} ${q.state}`];
    if (this.cfg.braveApiKey && !q.keyword) terms.push(`best ${nicheToQuery(q.niche)} in ${q.city} ${q.state}`);

    const byDomain = new Map<string, LeadCandidate>();
    for (const term of terms) {
      if (byDomain.size >= q.targetCount * 2) break;
      let results: WebResult[];
      try { results = await fetcher(term); } catch { continue; }
      for (const { url, title } of results) {
        let host: string;
        try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }
        if (EXCLUDE.some(d => host.includes(d)) || byDomain.has(host)) continue;
        if (isListicle(title)) continue;
        byDomain.set(host, {
          name: cleanName(title) || titleFromDomain(host),
          website: `https://${host}`,
          city: q.city, state: q.state, niche: q.niche,
          source: 'websearch', sourceExternalId: host,
        });
      }
    }

    return {
      candidates: [...byDomain.values()].slice(0, q.targetCount),
      source: 'websearch',
      attribution: this.cfg.braveApiKey ? 'Web search (Brave Search API).' : 'Web search results (public web).',
    };
  }

  /** Brave Search API — reliable from servers. Free tier ~2k queries/month. */
  private async braveFetch(term: string): Promise<WebResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
      q: term, country: 'us', count: '20', result_filter: 'web',
    })}`;
    const res = await request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        /* No Accept-Encoding: undici's `request` doesn't auto-decompress, so
           asking for gzip would make `.json()` choke on compressed bytes. */
        'X-Subscription-Token': this.cfg.braveApiKey!,
      },
      headersTimeout: 10_000,
      bodyTimeout: 12_000,
    });
    if (res.statusCode >= 400) throw new Error(`brave ${res.statusCode}`);
    const json = (await res.body.json()) as { web?: { results?: Array<{ url?: string; title?: string }> } };
    return (json.web?.results ?? [])
      .filter(r => r.url)
      .map(r => ({ url: r.url!, title: (r.title ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }));
  }

  /** DuckDuckGo HTML scrape — no key, but blocked from datacenter IPs. */
  private async ddgFetch(term: string): Promise<WebResult[]> {
    const res = await request('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': this.cfg.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html',
      },
      body: new URLSearchParams({ q: term, kl: 'us-en' }).toString(),
      maxRedirections: 3,
      headersTimeout: 10_000,
      bodyTimeout: 12_000,
    });
    if (res.statusCode >= 400) throw new Error(`websearch ${res.statusCode}`);
    const html = await res.body.text();
    const $ = cheerio.load(html);
    const out: WebResult[] = [];
    $('a.result__a').each((_, a) => {
      const url = decodeResultUrl($(a).attr('href') ?? '');
      if (url) out.push({ url, title: $(a).text().replace(/\s+/g, ' ').trim() });
    });
    return out;
  }
}

/** DuckDuckGo wraps targets as //duckduckgo.com/l/?uddg=<encoded>. Decode it. */
function decodeResultUrl(href: string): string | null {
  if (!href) return null;
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]!); } catch { return null; } }
  if (/^https?:\/\//.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return null;
}

function cleanName(title: string): string {
  /* Page titles are usually "Business Name | tagline" — keep the lead phrase. */
  let n = title.split(/\s[|\-–—•:]\s/)[0]!.trim();
  n = n.replace(/\b(home|official site|welcome to)\b/gi, '').trim();
  return n.length >= 2 && n.length <= 80 ? n : '';
}

function titleFromDomain(host: string): string {
  const base = host.split('.')[0] ?? host;
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function nicheToQuery(niche: Niche): string {
  const m: Record<Niche, string> = {
    Septic: 'septic service company', Roofer: 'roofing contractor', 'Water/Mold': 'water damage restoration',
    HVAC: 'HVAC contractor', Plumber: 'plumbing company', Electrician: 'electrician',
    Towing: 'towing service', 'Real Estate': 'real estate agency',
  };
  return m[niche] ?? niche;
}
