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
  if (!c.phone) {
    return { ok: false, reason: 'no_phone', detail: 'No phone in listing' };
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

  return { ok: true };
}

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
  const domain = lower.split('@')[1] ?? '';
  if (DISPOSABLE_DOMAINS.has(domain)) return { ok: false, reason: 'disposable_domain' };
  /* role accounts are warnings, not hard fails: handled at verification time. */
  return { ok: true };
}

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
