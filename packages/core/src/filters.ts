/**
 * Hard filters applied during discovery.
 * Returning `null` from `hardFilter` means the candidate is kept.
 * Anything else short-circuits scoring with a disqualification reason.
 */
import type { LeadCandidate, Niche } from './types.js';

const UPS_STORE_PATTERNS = [
  /\bups store\b/i, /\bpostal annex\b/i, /\bmailboxes etc\b/i,
  /\bpak mail\b/i, /\bgo postal\b/i,
];
const FRANCHISE_NAME_PATTERNS = [
  /\broto[- ]?rooter\b/i, /\bmr\.?\s?rooter\b/i, /\baire serv\b/i,
  /\bservpro\b/i, /\bservicemaster\b/i, /\bone\s?hour\b/i, /\bservpro\b/i,
  /\b1-?800-?\w+\b/i, /\bgreen\s?team\b/i,
];

export interface HardFilterContext {
  candidate: LeadCandidate;
  niche: Niche;
}

export interface DisqualificationDecision {
  ok: boolean;
  reason?: string;
  detail?: string;
}

export function hardFilter(ctx: HardFilterContext): DisqualificationDecision {
  const c = ctx.candidate;

  if (!c.name || c.name.trim().length === 0) {
    return { ok: false, reason: 'no_name', detail: 'Candidate has no business name' };
  }
  /* Need SOME way to reach them. A website is enough (we scrape it for the
     email) — requiring a phone here was silently dropping every website-only
     and web-search (Brave) business, which have a site but no phone in-listing. */
  if (!c.phone && !c.website && !c.email) {
    return { ok: false, reason: 'no_contact', detail: 'No phone, website, or email' };
  }

  /* UPS / mailbox addresses */
  if (c.address && UPS_STORE_PATTERNS.some(p => p.test(c.address ?? ''))) {
    return { ok: false, reason: 'mailbox_address', detail: 'Mailbox-store address' };
  }

  /* Obvious franchise / chain names */
  if (FRANCHISE_NAME_PATTERNS.some(p => p.test(c.name))) {
    return { ok: false, reason: 'franchise', detail: 'National franchise / chain' };
  }

  /* Non-US (we operate US-only at MVP) */
  if (c.state && c.state.length === 2 && !US_STATES.has(c.state.toUpperCase())) {
    return { ok: false, reason: 'non_us', detail: `Unknown US state: ${c.state}` };
  }

  /* Obvious government / nonprofit (heuristic) */
  if (/\b(city of|county of|department of|police|sheriff|fire dept)\b/i.test(c.name)) {
    return { ok: false, reason: 'government', detail: 'Government / municipal' };
  }
  if (/\b(non[- ]?profit|charity|foundation|ministries|church)\b/i.test(c.name)) {
    return { ok: false, reason: 'nonprofit', detail: 'Nonprofit / religious org' };
  }

  /* Niche relevance: web-search/Places sometimes return businesses in an
     unrelated industry (a lawyer-referral or accounting firm tagged "Plumber").
     Emailing them is wasted + raises spam risk, so drop obvious off-industry
     names for the trade niches (Real Estate keeps realty/realtor terms). */
  if (TRADE_NICHES.has(ctx.niche) && OFF_INDUSTRY.test(c.name)) {
    return { ok: false, reason: 'off_niche', detail: 'Name indicates a non-target industry' };
  }

  return { ok: true };
}

const TRADE_NICHES = new Set(['Septic', 'Roofer', 'Water/Mold', 'HVAC', 'Plumber', 'Electrician', 'Towing',
  'Pest Control', 'Garage Door', 'Locksmith', 'Appliance Repair', 'Pool Service', 'Landscaping',
  'Painter', 'Carpet Cleaning', 'Handyman', 'Tree Service',
  'Fencing', 'Concrete', 'Moving', 'Junk Removal', 'Window Cleaning', 'Pressure Washing', 'Solar', 'Flooring']);
const OFF_INDUSTRY = /\b(law|lawyer|attorney|attorneys|legal|paralegal|accounting|accountant|cpa|bookkeep|tax service|insurance|realty|realtor|real estate|dental|dentist|orthodont|medical|physician|clinic|hospital|pharmacy|chiropract|salon|spa|barber|nail|restaurant|cafe|café|bakery|catering|coffee|brewery|bank|credit union|mortgage|\bloan|financial|school|university|college|academy|daycare|staffing|recruit|notary|process serv|security (?:service|guard)|referral service|marketing|advertising|web design|software|\bit services\b|consulting|travel agency|funeral|veterinary|\bvet\b|\btv\b|television|\bchannel\b|\bnews\b|\bradio\b|broadcast|\bmedia\b|newspaper|magazine|museum|library|\bgov\b|municipal|city of|county of)\b/i;

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

/** Disposable / role-only / known-bad email signals (intake-time). */
export function emailIntakeFilter(email: string | null | undefined): { ok: boolean; reason?: string } {
  if (!email) return { ok: true };
  const lower = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) return { ok: false, reason: 'invalid_syntax' };
  const local = lower.split('@')[0] ?? '';
  const domain = lower.split('@')[1] ?? '';
  const tld = domain.split('.').pop() ?? '';
  if (DISPOSABLE_DOMAINS.has(domain)) return { ok: false, reason: 'disposable_domain' };
  /* Scraped HTML often yields garbage that is syntactically an email but will
     always bounce — every bounce hurts sender reputation, so drop these hard:
       • placeholder/example addresses from form hints ("user@domain.com",
         "j.doe@inbox.com", "you@example.com"),
       • asset filenames matched as emails ("logo@2x.png", "icon@sprite.svg"). */
  if (ASSET_EXTS.has(tld)) return { ok: false, reason: 'asset_filename' };
  if (PLACEHOLDER_DOMAINS.has(domain)) return { ok: false, reason: 'placeholder_domain' };
  if (PLACEHOLDER_LOCALS.has(local)) return { ok: false, reason: 'placeholder_local' };
  /* role accounts are warnings, not hard fails: handled at verification time. */
  return { ok: true };
}

const ASSET_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'css', 'js', 'mp4', 'pdf']);

/* ONLY unambiguous placeholders — never a real business domain (business.com,
   email.com, name.com etc. are real and must NOT be here). */
const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.edu', 'domain.com', 'domain.tld',
  'yourdomain.com', 'your-domain.com', 'yourcompany.com', 'your-company.com', 'mycompany.com',
  'mydomain.com', 'yoursite.com', 'yourwebsite.com', 'companyname.com',
  'wixpress.com', 'sentry.io', 'sentry-next.wixpress.com',
]);

const PLACEHOLDER_LOCALS = new Set([
  'user', 'username', 'user1', 'name', 'firstname', 'lastname', 'firstname.lastname', 'first.last',
  'name.surname', 'johndoe', 'john.doe', 'j.doe', 'janedoe', 'jane.doe', 'jane.smith', 'john.smith',
  'email', 'your.email', 'youremail', 'yourname', 'your.name', 'example', 'sample', 'demo',
  'test', 'test.test', 'test.email', 'someone', 'somebody', 'abc', 'xyz',
]);

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com',
  'getnada.com', 'trashmail.com', 'sharklasers.com', 'yopmail.com',
  'fakeinbox.com', 'maildrop.cc', 'mintemail.com', 'mailtothis.com',
]);

export const ROLE_PREFIXES = new Set([
  'info', 'sales', 'admin', 'support', 'contact', 'hello',
  'office', 'team', 'help', 'service', 'noreply', 'no-reply', 'inquiries',
]);

export function isRoleEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const local = email.toLowerCase().split('@')[0] ?? '';
  return ROLE_PREFIXES.has(local);
}
