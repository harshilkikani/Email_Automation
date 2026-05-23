/**
 * Deterministic website intelligence extractors.
 *
 * Each function takes raw HTML (already fetched by the provider/scraper) and
 * returns structured facts. NO LLM, NO JS-execution, NO third-party API
 * calls — purely regex + simple HTML parsing so output is reproducible.
 *
 * The scraper in @keres/providers chains these together. We isolate them in
 * core so we can unit-test extraction independent of any I/O.
 */

/** Detected site-builder / CMS. The list is intentionally short and high-signal. */
export type TechStackTag =
  | 'wordpress' | 'wix' | 'squarespace' | 'shopify' | 'webflow' | 'godaddy'
  | 'duda' | 'weebly' | 'react' | 'next' | 'gatsby' | 'cloudflare' | 'aws'
  | 'google-tag-manager' | 'meta-pixel' | 'hubspot' | 'mailchimp';

export type BookingVendor =
  | 'calendly' | 'acuity' | 'squarespace-scheduling' | 'housecallpro'
  | 'servicetitan' | 'jobber' | 'fieldedge' | 'getjobber' | 'bookingkoala'
  | 'mindbody' | 'square' | 'wix-bookings' | 'other';

export interface ExtractedIntel {
  techStack: TechStackTag[];
  bookingVendor: BookingVendor | null;
  emails: string[];
  phones: string[];
  social: Record<string, string>;
  services: string[];
  hoursText: string | null;
  addressText: string | null;
  yearFounded: number | null;
  language: string | null;
  evidence: Record<string, unknown>;
}

export function emptyIntel(): ExtractedIntel {
  return {
    techStack: [], bookingVendor: null,
    emails: [], phones: [], social: {},
    services: [], hoursText: null, addressText: null,
    yearFounded: null, language: null, evidence: {},
  };
}

const TECH_PATTERNS: Array<[RegExp, TechStackTag]> = [
  [/wp-content|wp-json|wordpress/i,                                       'wordpress'],
  [/wixstatic\.com|<!--\s*wix\s/i,                                        'wix'],
  [/squarespace\.com|sqs-block|sqs-html-content/i,                        'squarespace'],
  [/cdn\.shopify\.com|shopify-section/i,                                  'shopify'],
  [/webflow\.com|w-webflow/i,                                             'webflow'],
  [/godaddysites\.com|godaddy\.com\/sites/i,                              'godaddy'],
  [/duda\.co|dudamobile/i,                                                'duda'],
  [/weebly\.com|<!--\s*Weebly\s/i,                                        'weebly'],
  [/_next\/static|next\/router/i,                                         'next'],
  [/__gatsby|gatsby-image|gatsby-link/i,                                  'gatsby'],
  [/<div[^>]+id="root"|react-dom\.production/i,                           'react'],
  [/cloudflare-static|__cf_chl/i,                                         'cloudflare'],
  [/awsstatic\.com|amazonaws\.com\/.*\/static/i,                          'aws'],
  [/gtag\(|googletagmanager\.com|GTM-/i,                                  'google-tag-manager'],
  [/connect\.facebook\.net|fbq\('init'/i,                                 'meta-pixel'],
  [/hs-scripts\.com|hubspot\.com/i,                                       'hubspot'],
  [/list-manage\.com|mailchimp\.com/i,                                    'mailchimp'],
];

const BOOKING_PATTERNS: Array<[RegExp, BookingVendor]> = [
  [/calendly\.com/i,                                                      'calendly'],
  [/(acuityscheduling\.com|app\.acuityscheduling)/i,                      'acuity'],
  [/squarespace-scheduling|sqsp-scheduling/i,                             'squarespace-scheduling'],
  [/(housecallpro\.com|book\.housecallpro)/i,                             'housecallpro'],
  [/servicetitan\.com|service-titan/i,                                    'servicetitan'],
  [/(getjobber\.com|jobber\.com\/d\/)/i,                                  'jobber'],
  [/fieldedge\.com/i,                                                     'fieldedge'],
  [/bookingkoala\.com/i,                                                  'bookingkoala'],
  [/mindbodyonline\.com|mindbody\.io/i,                                   'mindbody'],
  [/squareup\.com\/appointments|square\.site\/book/i,                     'square'],
  [/wixapps\/booking|wix-bookings/i,                                      'wix-bookings'],
  [/\bbook\s+(now|online|appointment|service)\b/i,                        'other'],
];

const SOCIAL_PATTERNS: Array<[RegExp, string]> = [
  [/href="([^"]*facebook\.com\/[^"]+)"/i,                                 'facebook'],
  [/href="([^"]*instagram\.com\/[^"]+)"/i,                                'instagram'],
  [/href="([^"]*linkedin\.com\/[^"]+)"/i,                                 'linkedin'],
  [/href="([^"]*x\.com\/[^"\/?#]+)"/i,                                    'x'],
  [/href="([^"]*twitter\.com\/[^"\/?#]+)"/i,                              'twitter'],
  [/href="([^"]*youtube\.com\/[^"]+)"/i,                                  'youtube'],
  [/href="([^"]*yelp\.com\/biz\/[^"]+)"/i,                                'yelp'],
  [/href="([^"]*g\.page\/[^"]+)"/i,                                       'google-business'],
  [/href="([^"]*tiktok\.com\/@[^"\/?#]+)"/i,                              'tiktok'],
];

const EMAIL_RE = /[a-zA-Z0-9_.+\-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
const PHONE_RE = /(?:\+?1[\s.\-])?\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})\b/g;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const ADDRESS_RE = /\b\d{1,5}\s+[A-Z][a-zA-Z0-9.\s,'#-]{4,80}\b(?:Street|St\.?|Ave(?:nue)?|Blvd\.?|Road|Rd\.?|Way|Drive|Dr\.?|Lane|Ln\.?|Suite|Ste\.?|Parkway|Pkwy\.?|Court|Ct\.?|Highway|Hwy\.?)\b[^.\n]{0,80}/;
const HOURS_RE = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*[-–]\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[^.\n]{0,40}/i;
const YEAR_FOUNDED_RE = /\b(?:since|established(?:\s+in)?|serving\s+\w+\s+since|family[-\s]owned\s+since)\s*(19\d{2}|20[01]\d)\b/i;

/** Filter out obvious noise from raw email/phone matches. */
function looksLikeRealEmail(e: string): boolean {
  const lower = e.toLowerCase();
  if (/(\.png|\.jpg|\.svg|\.webp|@sentry|@example|@test|wixpress|gravatar|no[-]?reply|noreply|donotreply|mailer|postmaster|sentry\.io|googleapis\.com)/i.test(lower)) return false;
  if (lower.length > 80) return false;
  return true;
}

function looksLikePhone(area: string, exchange: string, line: string): boolean {
  /* US area codes can't start with 0/1; central office can't start with 0/1. */
  if (area[0] === '0' || area[0] === '1') return false;
  if (exchange[0] === '0' || exchange[0] === '1') return false;
  /* Block obvious sentinels (555-XXXX, 000-0000, 111-1111). */
  if (exchange === '555' || /^(\d)\1{2}$/.test(area)) return false;
  if (/^0+$/.test(line) || /^1+$/.test(line)) return false;
  return true;
}

/**
 * Main extractor — takes the raw HTML of (typically) the homepage plus any
 * additional pages fetched by the scraper and returns the structured intel.
 */
export function extractIntel(opts: {
  homeHtml: string;
  homeUrl: string;
  finalUrl?: string;
  extraHtml?: string[];       // contact, about, services pages
  language?: string | null;
}): ExtractedIntel {
  const out = emptyIntel();
  const allHtml = [opts.homeHtml, ...(opts.extraHtml ?? [])].join('\n');

  /* Tech stack: each pattern is independent — a site can hit multiple. */
  const techHits = new Set<TechStackTag>();
  for (const [re, tag] of TECH_PATTERNS) {
    if (re.test(allHtml)) techHits.add(tag);
  }
  out.techStack = [...techHits];

  /* Booking: take the first vendor that matches with priority order. */
  for (const [re, vendor] of BOOKING_PATTERNS) {
    if (re.test(allHtml)) { out.bookingVendor = vendor; break; }
  }

  /* Emails + phones — dedupe, filter, cap to a sane count. */
  const emails = new Set<string>();
  for (const m of allHtml.match(EMAIL_RE) ?? []) {
    const lower = m.toLowerCase();
    if (looksLikeRealEmail(lower)) emails.add(lower);
  }
  out.emails = [...emails].slice(0, 10);

  const phones = new Set<string>();
  let pm: RegExpExecArray | null;
  const phoneScanner = new RegExp(PHONE_RE.source, 'g');
  while ((pm = phoneScanner.exec(allHtml)) !== null) {
    const [, area, exch, line] = pm;
    if (!area || !exch || !line) continue;
    if (!looksLikePhone(area, exch, line)) continue;
    phones.add(`(${area}) ${exch}-${line}`);
    if (phones.size >= 6) break;
  }
  out.phones = [...phones];

  /* Social. */
  for (const [re, key] of SOCIAL_PATTERNS) {
    const m = allHtml.match(re);
    if (m && m[1] && !out.social[key]) out.social[key] = m[1];
  }

  /* Services — pull from common selectors via text-only heuristics. */
  out.services = extractServiceList(allHtml);

  /* Hours, address, year founded, language. */
  out.hoursText = allHtml.match(HOURS_RE)?.[0]?.trim() ?? null;
  const addrMatch = allHtml.match(ADDRESS_RE)?.[0]?.trim() ?? null;
  if (addrMatch && ZIP_RE.test(addrMatch.slice(-30))) {
    out.addressText = addrMatch;
  } else if (addrMatch) {
    out.addressText = addrMatch.length > 12 ? addrMatch : null;
  }
  const yfMatch = allHtml.match(YEAR_FOUNDED_RE);
  if (yfMatch && yfMatch[1]) {
    const y = parseInt(yfMatch[1]!, 10);
    if (y >= 1900 && y <= new Date().getFullYear()) out.yearFounded = y;
  }
  out.language = opts.language ?? (allHtml.match(/<html[^>]+lang="([^"]+)"/i)?.[1] ?? null);

  out.evidence = {
    homeUrl: opts.homeUrl,
    finalUrl: opts.finalUrl ?? opts.homeUrl,
    pagesAnalyzed: 1 + (opts.extraHtml?.length ?? 0),
    techStackCount: out.techStack.length,
    socialKeys: Object.keys(out.social),
  };
  return out;
}

const SERVICE_KEYWORDS: Array<[RegExp, string]> = [
  [/septic[-\s](?:pumping|cleaning|inspection|installation|repair|tank)/gi, 'septic'],
  [/drain[-\s](?:cleaning|unclog|repair|snake)/gi,                           'drain'],
  [/sewer[-\s](?:line|repair|cleaning|inspection|jet|jetting)/gi,            'sewer'],
  [/water[-\s](?:heater|damage|leak|softener|filtration|treatment)/gi,       'water'],
  [/mold[-\s](?:removal|remediation|inspection|testing)/gi,                  'mold'],
  [/roof(?:ing)?\s*(?:repair|replacement|inspection|installation)/gi,        'roofing'],
  [/(?:air[-\s]conditioning|hvac|heating|furnace|heat[-\s]pump)/gi,          'hvac'],
  [/electrical\s*(?:repair|installation|panel|wiring|inspection)/gi,         'electrical'],
  [/plumb(?:ing|er)\s*(?:repair|service|installation)/gi,                    'plumbing'],
  [/tow(?:ing)?\s*(?:service|truck|company)/gi,                              'towing'],
];

function extractServiceList(html: string): string[] {
  const out = new Set<string>();
  for (const [re, tag] of SERVICE_KEYWORDS) {
    if (re.test(html)) out.add(tag);
  }
  return [...out];
}
