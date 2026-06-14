/**
 * Deterministic "deficiency" derivation for fact-grounded personalization.
 *
 * The hybrid personalization model: this module produces the *facts* (true,
 * scraped weaknesses a business has) — an LLM is only ever allowed to rephrase
 * these into an opener, never to invent new ones. Pure functions, no I/O, so
 * the truth layer is unit-testable and reproducible.
 *
 * Each deficiency ties a verifiable gap to the AI-receptionist fix.
 */
import type { Niche, WebPresenceLevel } from './types.js';

export type DeficiencyCode =
  | 'no_online_booking'
  | 'no_website'
  | 'social_only'
  | 'gbp_only'
  | 'dated_builder'
  | 'stale_site'
  | 'few_reviews'
  | 'no_reviews'
  | 'by_appointment'
  | 'no_contact_email';

export interface Deficiency {
  code: DeficiencyCode;
  /** Literal, verifiable statement of the gap (what they're NOT doing well). */
  fact: string;
  /** How the AI receptionist closes that gap. */
  fix: string;
}

/** Subset of scraped intel needed to derive deficiencies (from `website_intel`). */
export interface IntelFacts {
  bookingVendor: string | null;
  techStack: string[];
  emails: string[];
  hoursText: string | null;
  yearFounded: number | null;
}

/** Subset of computed signals needed (from `lead_signals`). */
export interface SignalFacts {
  webPresenceLevel: WebPresenceLevel;
  hasOnlineBooking: boolean;
  reviewCount30d: number | null;
  reviewRating: number | null;
}

const DATED_BUILDERS = new Set(['godaddy', 'wix', 'weebly', 'duda']);

/**
 * Return the business's true weaknesses, highest-impact first. Only facts that
 * are actually supported by the scraped data are included — an empty list means
 * we found nothing specific (caller should fall back to a generic opener).
 */
export function deriveDeficiencies(intel: IntelFacts, signals: SignalFacts, nowYear = new Date().getUTCFullYear()): Deficiency[] {
  const out: Deficiency[] = [];

  /* Web presence is the strongest hook — they can't be found / reached. */
  if (signals.webPresenceLevel === 'none') {
    out.push({
      code: 'no_website',
      fact: 'has no real website — runs on phone and word-of-mouth',
      fix: 'a 24/7 AI receptionist answers and books every caller so no lead is lost to a missed call',
    });
  } else if (signals.webPresenceLevel === 'social_only') {
    out.push({
      code: 'social_only',
      fact: 'has only a social page, no main website',
      fix: 'an AI receptionist captures and books the leads that message or call outside hours',
    });
  } else if (signals.webPresenceLevel === 'gbp_only') {
    out.push({
      code: 'gbp_only',
      fact: 'shows up only on a Google listing, with no website to capture leads',
      fix: 'an AI receptionist answers every call from that listing and books the job',
    });
  }

  /* No way to book without calling. */
  if (!signals.hasOnlineBooking && intel.bookingVendor === null) {
    out.push({
      code: 'no_online_booking',
      fact: 'has no online booking — customers can only book by calling',
      fix: 'an AI receptionist answers 24/7 and books the appointment on the spot',
    });
  }

  /* Reviews: none, then few. */
  const rc = signals.reviewCount30d;
  if (rc !== null && rc === 0) {
    out.push({
      code: 'no_reviews',
      fact: 'has no recent reviews',
      fix: 'never missing a call means more booked jobs — and more chances to earn reviews',
    });
  } else if (rc !== null && rc > 0 && rc < 5) {
    out.push({
      code: 'few_reviews',
      fact: `has only ${rc} recent review${rc === 1 ? '' : 's'}`,
      fix: 'answering and booking every caller turns more inquiries into reviewed jobs',
    });
  }

  /* DIY / dated site builder. */
  if (intel.techStack.some(t => DATED_BUILDERS.has(t.toLowerCase()))) {
    out.push({
      code: 'dated_builder',
      fact: 'runs on a basic DIY site builder with no lead capture',
      fix: 'an AI receptionist handles the inbound the website can\'t',
    });
  }

  /* Stale site (old "since YYYY" with nothing newer). */
  if (intel.yearFounded !== null && nowYear - intel.yearFounded >= 15) {
    out.push({
      code: 'stale_site',
      fact: `site looks like it hasn't been refreshed since around ${intel.yearFounded}`,
      fix: 'a 24/7 AI receptionist modernizes how you capture and book leads — no rebuild needed',
    });
  }

  /* By-appointment / limited hours → after-hours callers hit voicemail. */
  if (intel.hoursText && /appointment|by appt|call (for|to)|limited/i.test(intel.hoursText)) {
    out.push({
      code: 'by_appointment',
      fact: 'runs by-appointment, so after-hours callers hit voicemail',
      fix: 'an AI receptionist answers after hours and books the slot before they call someone else',
    });
  }

  /* No contact email scraped. */
  if (intel.emails.length === 0 && signals.webPresenceLevel !== 'none') {
    out.push({
      code: 'no_contact_email',
      fact: 'has no contact email on the site, so the phone is the only way in',
      fix: 'an AI receptionist makes sure that phone is always answered',
    });
  }

  return out;
}

/**
 * Deterministic, no-LLM fallback opener built straight from the top deficiency.
 * Used when AI personalization is off or returns nothing — still specific and true.
 */
export function deterministicOpener(business: string, city: string, deficiencies: Deficiency[], ownerFirst?: string | null): string | null {
  const top = deficiencies[0];
  if (!top) return null;
  const where = city ? ` in ${city}` : '';
  const greeting = ownerFirst && ownerFirst.trim() ? `Hi ${ownerFirst.trim()} — ` : '';
  return `${greeting}saw ${business}${where} — looks like it ${top.fact}.`.replace(/^([a-z])/, (m) => greeting ? m : m.toUpperCase());
}

/** Short, niche-flavored proof line for the composed email. */
const NICHE_PROOF: Partial<Record<Niche, string>> = {
  Septic: 'Most septic crews cover the cost from a single after-hours job they would have missed.',
  Roofer: 'After a storm, one captured estimate usually pays for it many times over.',
  HVAC: 'On the hottest days the calls never stop — none of them should go to voicemail.',
  Plumber: 'A 2am burst-pipe call is a same-day job; missing it hands it to the next plumber.',
  Electrician: 'Every after-hours call you catch is work that would have gone elsewhere.',
  'Water/Mold': 'Water damage callers hire whoever answers first — that should be you.',
  Towing: 'Roadside callers go straight down the list until someone picks up.',
  'Real Estate': 'A lead that reaches a real person, not voicemail, is a lead you keep.',
};

/**
 * Deterministic FULL email composed from the top verified deficiency + owner
 * greeting + the fix + a niche proof line + CTA. Returns a complete body with
 * {{from_name}}/{{from_signoff}} tokens (filled with the persona at render).
 * Returns null when there's nothing specific to say (caller keeps the template).
 */
export function composeEmail(input: {
  business: string; city: string; niche: Niche; deficiencies: Deficiency[];
  ownerFirst?: string | null;
}): string | null {
  const top = input.deficiencies[0];
  if (!top) return null;
  const greet = input.ownerFirst && input.ownerFirst.trim() ? `Hi ${input.ownerFirst.trim()},` : 'Hi there,';
  const where = input.city ? ` in ${input.city}` : '';
  const fix = top.fix.charAt(0).toUpperCase() + top.fix.slice(1);
  const proof = NICHE_PROOF[input.niche] ?? 'Most owners we work with book extra jobs within the first week.';
  return `${greet}

I was looking at ${input.business}${where} and noticed it ${top.fact}.

${fix}. ${proof}

Worth a quick 10-minute look? I can show you exactly how it'd work for ${input.business}.

{{from_name}}
{{from_signoff}}`;
}

export interface PersonalizeOpenerInput {
  business: string;
  city: string;
  niche: Niche;
  deficiencies: Deficiency[];
  /** What we sell, e.g. "a 24/7 AI receptionist that answers calls and books jobs". */
  product: string;
  /** Owner/decision-maker first name, when found, to greet by name. */
  ownerFirst?: string | null;
}
