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

  /* Each `fix` pitches the CUSTOM solution matched to the specific gap — we
     build whatever the business is lacking (site, booking, reviews, AI phone),
     not a one-size pitch. */
  if (signals.webPresenceLevel === 'none') {
    out.push({
      code: 'no_website',
      fact: 'has no real website — runs on phone and word-of-mouth',
      fix: "we'd build you a fast, mobile-friendly website that turns online searches into booked jobs",
    });
  } else if (signals.webPresenceLevel === 'social_only') {
    out.push({
      code: 'social_only',
      fact: 'has only a social page, no main website',
      fix: "we'd build a real website that captures the leads your social page is leaving on the table",
    });
  } else if (signals.webPresenceLevel === 'gbp_only') {
    out.push({
      code: 'gbp_only',
      fact: 'shows up only on a Google listing, with no website to capture leads',
      fix: "we'd build a simple site that captures the leads your Google listing is already sending you",
    });
  }

  /* No way to book without calling. */
  if (!signals.hasOnlineBooking && intel.bookingVendor === null) {
    out.push({
      code: 'no_online_booking',
      fact: 'has no online booking — customers can only book by calling',
      fix: "we'd add online booking so customers can book the moment they land on your site, not just by phone",
    });
  }

  /* Reviews: none, then few. */
  const rc = signals.reviewCount30d;
  if (rc !== null && rc === 0) {
    out.push({
      code: 'no_reviews',
      fact: 'has no recent reviews',
      fix: "we'd set up an automated system that turns your happy customers into 5-star reviews",
    });
  } else if (rc !== null && rc > 0 && rc < 5) {
    out.push({
      code: 'few_reviews',
      fact: `has only ${rc} recent review${rc === 1 ? '' : 's'}`,
      fix: "we'd automate review requests so more of your finished jobs become public 5-star reviews",
    });
  }

  /* DIY / dated site builder. */
  if (intel.techStack.some(t => DATED_BUILDERS.has(t.toLowerCase()))) {
    out.push({
      code: 'dated_builder',
      fact: 'runs on a basic DIY site builder with no lead capture',
      fix: "we'd rebuild it into a modern site that actually captures and books leads",
    });
  }

  /* Stale site (old "since YYYY" with nothing newer). */
  if (intel.yearFounded !== null && nowYear - intel.yearFounded >= 15) {
    out.push({
      code: 'stale_site',
      fact: `site looks like it hasn't been refreshed since around ${intel.yearFounded}`,
      fix: "we'd modernize the site so it captures and books leads the way it should",
    });
  }

  /* By-appointment / limited hours → after-hours callers hit voicemail. */
  if (intel.hoursText && /appointment|by appt|call (for|to)|limited/i.test(intel.hoursText)) {
    out.push({
      code: 'by_appointment',
      fact: 'runs by-appointment, so after-hours callers hit voicemail',
      fix: "we'd make sure after-hours callers can still book the job instead of hitting voicemail",
    });
  }

  /* No contact email scraped. */
  if (intel.emails.length === 0 && signals.webPresenceLevel !== 'none') {
    out.push({
      code: 'no_contact_email',
      fact: 'has no contact email on the site, so the phone is the only way in',
      fix: "we'd add a quote/contact form so leads can reach you online, not just by phone",
    });
  }

  return out;
}

/* ───────────────── Deterministic variety engine ─────────────────
 * No LLM available in prod, so the deterministic composer must NOT read the
 * same for every business. We rotate phrasing/proof/CTA/structure by a stable
 * per-lead seed, so two businesses with the same deficiency still get visibly
 * different emails — while never asserting anything we can't verify. */

const NON_NAMES = new Set([
  'thanks', 'thank', 'hello', 'hi', 'hey', 'welcome', 'contact', 'home', 'team', 'our', 'the', 'info',
  'owner', 'manager', 'customer', 'service', 'services', 'support', 'call', 'free', 'get', 'your', 'about',
  'name', 'here', 'dear', 'sir', 'madam', 'please', 'email', 'quote', 'today', 'now', 'more', 'staff',
  'office', 'sales', 'admin', 'help', 'click', 'menu', 'search', 'login', 'review', 'reviews', 'company',
  'business', 'llc', 'inc', 'co', 'corp', 'mr', 'mrs', 'ms', 'dr', 'guest', 'user', 'friend', 'there',
]);

/** Validate a scraped owner first-name — rejects junk like "Thanks"/"Welcome"
 * that the crawler sometimes grabs, so we never send "Hi Thanks,". */
export function cleanFirstName(name: string | null | undefined): string | null {
  const f = (name ?? '').trim().split(/\s+/)[0] ?? '';
  if (f.length < 2 || f.length > 15) return null;
  if (!/^[A-Z][A-Za-z'’.\-]{1,14}$/.test(f)) return null;   // must look like a Name
  if (NON_NAMES.has(f.toLowerCase())) return null;
  return f;
}

/** Small stable string hash → non-negative int. Deterministic across runs. */
function seedInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
const pick = <T,>(arr: T[], seed: number, salt: number): T => arr[(seed + salt * 2654435761) % arr.length % arr.length]!;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* Alternate true phrasings of each gap, so the core clause isn't copy-paste. */
const DEFICIENCY_PHRASINGS: Partial<Record<DeficiencyCode, string[]>> = {
  no_online_booking: [
    'has no online booking — customers can only book by calling',
    "doesn't offer online booking, so every new customer has to start with a phone call",
    'has no way to book online; it all comes down to catching the call',
    'still takes every booking by phone — there\'s no way to schedule online',
    'leaves the phone as the only way to book, with no online scheduling',
  ],
  no_website: [
    'has no real website — it runs on the phone and word-of-mouth',
    "doesn't have a website yet, so the phone is doing all the work",
    'is running without a real website, which puts everything on the phone',
  ],
  social_only: [
    'has only a social page, no main website',
    'is running on a social page alone, with no website to capture leads',
  ],
  gbp_only: [
    'shows up only on a Google listing, with no website to capture leads',
    'is just a Google listing right now, with nothing to catch the leads it sends',
  ],
  no_contact_email: [
    'has no contact email on the site, so the phone is the only way in',
    "doesn't list a contact email, which leaves the phone as the only way to reach you",
  ],
  no_reviews: ['has no recent reviews showing'],
  dated_builder: ['runs on a basic DIY site builder with no lead capture'],
  stale_site: ['looks like the site hasn\'t been refreshed in years'],
  by_appointment: ['runs by-appointment, so after-hours callers hit voicemail'],
};

/* Generic, always-true hooks for businesses with no specific scraped gap. These
   pose the universal missed-call problem — they assert nothing unverifiable. */
const GENERIC_HOOKS = [
  "when a call comes in after hours, it's easy for it to slip to voicemail",
  "it's hard to catch every call when the crew is out on jobs all day",
  'after-hours and overflow calls are some of the easiest money to miss',
  'the calls that come in while you\'re on a job are the ones that tend to get away',
];
const GENERIC_FIX = "we build the custom websites, online booking, and review systems that turn more of those calls into booked jobs";

/* Interest-based, low-friction asks — a first cold email gets far more replies
   asking "want me to send an example?" than "book a 10-minute call." */
const CTAS = [
  (b: string) => `Want me to send a 2-minute example of how it'd handle ${b}'s calls?`,
  (b: string) => `Worth exploring? Reply "yes" and I'll send a quick example for ${b}.`,
  (b: string) => `Is catching those missed calls something you'd want to look at?`,
  (b: string) => `Mind if I send over a short example built for ${b}?`,
  (b: string) => `Open to seeing how it'd work for ${b}? Happy to send a quick rundown.`,
];

/* What AI we'd actually put to work, by trade (research-backed):
   - urgent trades → a 24/7 AI receptionist that answers + books every call
   - recurring trades → an AI agent that re-books past customers (repeat revenue)
   - quote-driven trades → an AI agent that instantly follows up on estimates
   - real estate → an AI agent that responds to inquiries in seconds
   The AI receptionist stays featured for everyone. */
const AI_URGENT = [
  'Our 24/7 AI receptionist answers every call — even at 2am — qualifies the job, and books it on the spot.',
  "A 24/7 AI receptionist picks up the calls you'd otherwise miss, qualifies them, and books the job.",
];
const AI_RECURRING = [
  "Our AI receptionist answers new calls, and an AI agent automatically texts past customers when they're due — repeat jobs on autopilot.",
  'Beyond answering every call, our AI agent re-books past customers for their next service before they go elsewhere.',
];
const AI_ESTIMATE = [
  'Our AI receptionist answers every call, and an AI agent instantly texts back estimate requests so quotes never go cold.',
  'A 24/7 AI receptionist — plus an AI agent that chases every estimate by text — means far fewer quotes slip away.',
];
const AI_REALESTATE = [
  'Our AI agent answers and texts back listing inquiries in seconds, day or night, so you never lose a buyer to a slow reply.',
];
const AI_DEFAULT = ['Our 24/7 AI receptionist answers every call and books the job, while AI agents handle follow-up and repeat customers.'];

const URGENT_SET = new Set<Niche>(['Plumber', 'HVAC', 'Electrician', 'Septic', 'Water/Mold', 'Towing', 'Locksmith', 'Garage Door', 'Appliance Repair', 'Tree Service']);
const RECURRING_SET = new Set<Niche>(['Pest Control', 'Pool Service', 'Landscaping', 'Window Cleaning', 'Pressure Washing']);
const ESTIMATE_SET = new Set<Niche>(['Roofer', 'Fencing', 'Concrete', 'Flooring', 'Painter', 'Moving', 'Solar', 'Junk Removal', 'Carpet Cleaning', 'Handyman']);

function aiAngle(niche: Niche, seed: number): string {
  const set = niche === 'Real Estate' ? AI_REALESTATE
    : URGENT_SET.has(niche) ? AI_URGENT
    : RECURRING_SET.has(niche) ? AI_RECURRING
    : ESTIMATE_SET.has(niche) ? AI_ESTIMATE
    : AI_DEFAULT;
  return pick(set, seed, 6);
}

/**
 * Deterministic, no-LLM opener — a 1–2 sentence hook. Rotated by a stable seed
 * so different businesses read differently. Always returns a line (a generic,
 * still-true missed-call hook) when there's no specific scraped gap, so no lead
 * falls back to a bare template.
 */
export function deterministicOpener(
  business: string, city: string, deficiencies: Deficiency[],
  ownerFirst?: string | null, seed?: string,
): string {
  const n = seedInt(seed ?? business);
  const where = city ? ` in ${city}` : '';
  const greetDash = ownerFirst && ownerFirst.trim() ? `Hi ${ownerFirst.trim()} — ` : '';
  const top = deficiencies[0];
  const clause = top
    ? pick(DEFICIENCY_PHRASINGS[top.code] ?? [top.fact], n, 1)
    : pick(GENERIC_HOOKS, n, 1);
  const shapes = [
    `${greetDash}saw ${business}${where} — looks like it ${clause}.`,
    `${greetDash}quick note on ${business}${where}: noticed it ${clause}.`,
    `${greetDash}was looking at ${business}${where} and saw it ${clause}.`,
    `${greetDash}came across ${business}${where}; looks like it ${clause}.`,
    `${greetDash}had a look at ${business}${where} — it ${clause}.`,
  ];
  const line = pick(shapes, n, 2);
  return greetDash ? line : cap(line);
}

/**
 * Deterministic FULL email body, rotated by a stable seed so two businesses with
 * the same gap still get visibly different emails. Tokens {{from_name}}/
 * {{from_signoff}} are filled with the persona at render. Always returns a body
 * (generic missed-call angle when there's no specific gap) so every lead is
 * personalized, never the bare template.
 */
/**
 * The discrete copy levers a given email used (gap pitched, CTA, hook shape, AI
 * angle) — recorded per send so the performance loop can learn which variants
 * earn replies. Mirrors composeEmail's seeded picks exactly.
 */
export function messageVariant(input: { niche: Niche; deficiencies: Deficiency[]; seed: string }): {
  offer: string; gap: string; cta: number; hook: number; ai: string;
} {
  const n = seedInt(input.seed);
  const idx = (len: number, salt: number) => ((n + salt * 2654435761) % len + len) % len;
  return {
    offer: 'ai_solutions',
    gap: input.deficiencies[0]?.code ?? 'generic',
    cta: idx(CTAS.length, 4),      // composeEmail picks CTA with salt 4
    hook: idx(6, 5),               // 6 hook shapes, salt 5
    ai: input.niche === 'Real Estate' ? 'realestate'
      : URGENT_SET.has(input.niche) ? 'urgent'
      : RECURRING_SET.has(input.niche) ? 'recurring'
      : ESTIMATE_SET.has(input.niche) ? 'estimate' : 'default',
  };
}

/* ─────────────── Validation offers (alternate pitches to A/B test) ───────────────
 * Distinct value props we're testing against the core AI-solutions pitch:
 *  - claim_supplement: recover under-billed insurance dollars (roofing/restoration)
 *  - liens: never lose the right to get paid (all contractor trades)
 * Same seeded-variety + {{from_name}}/{{from_signoff}} machinery, so they send,
 * dedupe, and track exactly like every other email. */
export type ValidationOffer = 'claim_supplement' | 'liens';

export const OFFER_LABEL: Record<ValidationOffer, string> = {
  claim_supplement: 'Insurance claim supplement',
  liens: 'Get-paid / liens',
};

/** Subject templates (with {{business}} tokens) for an offer campaign. */
export function offerSubjects(offer: ValidationOffer): [string, string] {
  return offer === 'claim_supplement'
    ? ['did your last claim leave money behind, {{business}}?', 'a recent insurance claim at {{business}}']
    : ['getting paid on time, {{business}}', 'protect {{business}} from unpaid invoices'];
}

const OFFER_BODY: Record<ValidationOffer, { hooks: (b: string, w: string) => string[]; value: string[]; ctas: (b: string) => string[] }> = {
  claim_supplement: {
    hooks: (b, w) => [
      `I came across ${b}${w} and had a quick question about your insurance jobs.`,
      `Quick one for ${b}${w} on storm and damage claims.`,
    ],
    value: [
      "Carriers write the first scope at 50–65% of what a job is actually worth, so most contractors leave 20–40% on the table per claim. We run the carrier's scope and your photos through AI and draft a properly-coded Xactimate supplement to recover what's owed — usually approved in days.",
      "Most insurance estimates come in 35–50% low. Our AI compares the carrier's scope against trade-correct line items and writes the supplement for you, so you stop leaving money on every claim.",
    ],
    ctas: (b) => [
      `Want a free review on a recent claim? Send me the carrier scope and I'll show you exactly what it left behind.`,
      `Mind sending one recent claim? I'll show you in 2 minutes what ${b} could've recovered.`,
    ],
  },
  liens: {
    hooks: (b, w) => [
      `I came across ${b}${w} and wanted to flag something about getting paid.`,
      `Quick one for ${b}${w} on unpaid invoices.`,
    ],
    value: [
      "Contractors who send the right preliminary notice and lien recover 80% of unpaid invoices — the ones who don't recover 30% — but most miss the 20–45 day notice deadline and quietly lose the right to get paid. Our AI tracks every job's deadlines and auto-files the correct notice and lien for your state.",
      "The #1 reason contractors don't get paid isn't bad customers — it's a missed notice deadline. Our AI watches every job and files the right paperwork on time, in all 50 states, so you keep your right to get paid.",
    ],
    ctas: (b) => [
      `Want me to show you how it'd protect ${b}'s payments? Reply and I'll send a 2-minute example.`,
      `Worth a look? Reply "yes" and I'll send a quick example for ${b}.`,
    ],
  },
};

/** Compose an offer email body + its variant tag (for performance attribution). */
export function composeOfferEmail(input: { offer: ValidationOffer; business: string; city: string; ownerFirst?: string | null; seed?: string }): {
  body: string; variant: { offer: ValidationOffer; cta: number; hook: number };
} {
  const n = seedInt(input.seed ?? input.business);
  const greet = input.ownerFirst && input.ownerFirst.trim() ? `Hi ${input.ownerFirst.trim()},` : 'Hi there,';
  const where = input.city ? ` in ${input.city}` : '';
  const c = OFFER_BODY[input.offer];
  const hooks = c.hooks(input.business, where);
  const ctas = c.ctas(input.business);
  const hookIdx = ((n + 5 * 2654435761) % hooks.length + hooks.length) % hooks.length;
  const ctaIdx = ((n + 4 * 2654435761) % ctas.length + ctas.length) % ctas.length;
  const value = pick(c.value, n, 3);
  const body = `${greet}\n\n${hooks[hookIdx]}\n\n${value}\n\n${ctas[ctaIdx]}\n\n{{from_name}}\n{{from_signoff}}`;
  return { body, variant: { offer: input.offer, cta: ctaIdx, hook: hookIdx } };
}

export function composeEmail(input: {
  business: string; city: string; niche: Niche; deficiencies: Deficiency[];
  ownerFirst?: string | null; seed?: string;
}): string {
  const { business, city, niche } = input;
  const n = seedInt(input.seed ?? business);
  const greet = input.ownerFirst && input.ownerFirst.trim() ? `Hi ${input.ownerFirst.trim()},` : 'Hi there,';
  const where = city ? ` in ${city}` : '';
  const top = input.deficiencies[0];
  const clause = top
    ? pick(DEFICIENCY_PHRASINGS[top.code] ?? [top.fact], n, 1)
    : pick(GENERIC_HOOKS, n, 1);
  const fix = cap(top ? top.fix : GENERIC_FIX);
  const ai = aiAngle(niche, n);
  const cta = pick(CTAS, n, 4)(business);

  const hooks = [
    `I was looking at ${business}${where} and noticed it ${clause}.`,
    `${business} came up while I was researching local businesses${where} — one thing stood out: it ${clause}.`,
    `Quick one about ${business}${where}: it ${clause}.`,
    `Came across ${business}${where} and wanted to reach out — it ${clause}.`,
    `I'll keep this short — I noticed ${business}${where} ${clause}.`,
    `Took a look at how ${business}${where} handles new inquiries and saw it ${clause}.`,
  ];
  const hook = pick(hooks, n, 5);

  /* Kept under ~90 words on purpose — short cold emails get ~50% more replies.
     One value para (gap-matched fix + the AI we'd put to work), one soft ask. */
  return `${greet}

${hook}

${fix}. ${ai}

${cta}

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
