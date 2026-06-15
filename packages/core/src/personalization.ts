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

/** Short, niche-flavored proof lines (rotated by seed). */
const PROOF_LINES: Partial<Record<Niche, string[]>> = {
  Septic: [
    'Most septic crews cover the cost from a single after-hours job they would have missed.',
    'One emergency pump-out you catch at 9pm usually pays for a month of this.',
    'After-hours septic calls are urgent — whoever answers first gets the job.',
  ],
  Roofer: [
    'After a storm, one captured estimate usually pays for it many times over.',
    'Storm-season calls come in waves; the ones you answer are the ones you book.',
    'Homeowners with a leak call down the list until someone picks up.',
  ],
  HVAC: [
    'On the hottest days the calls never stop — none of them should go to voicemail.',
    'A no-cool call in July is a same-day job if you actually answer it.',
    'In peak season, every missed call is an install handed to a competitor.',
  ],
  Plumber: [
    'A 2am burst-pipe call is a same-day job; missing it hands it to the next plumber.',
    'Emergency plumbing callers hire whoever answers — speed wins the job.',
    'Most plumbers book an extra job or two a week just by never missing the phone.',
  ],
  Electrician: [
    'Every after-hours call you catch is work that would have gone elsewhere.',
    "Urgent electrical calls don't wait — the first to answer usually wins.",
    'A single captured panel or rewire job covers this many times over.',
  ],
  'Water/Mold': [
    'Water-damage callers hire whoever answers first — that should be you.',
    'Every hour matters with water damage; the fastest response books the job.',
    'One mitigation job you catch after hours pays for this outright.',
  ],
  Towing: [
    'Roadside callers go straight down the list until someone picks up.',
    'Stranded drivers call the first tow that answers — that\'s the whole game.',
    'Every missed roadside call is a paid tow handed to the next company.',
  ],
  'Real Estate': [
    'A lead that reaches a real person, not voicemail, is a lead you keep.',
    "Buyers calling on a listing won't leave a message — they call the next agent.",
    'The first agent to respond wins the showing more often than not.',
  ],
  'Pest Control': [
    'Someone who just saw a roach calls the first company that picks up — same-day money.',
    'Pest calls are urgent and emotional; the fastest response books the treatment.',
  ],
  'Garage Door': ['A stuck or broken garage door is a same-day call — whoever answers gets the repair.'],
  Locksmith: [
    'A lockout call goes to whoever answers first — every missed ring is a paid job gone.',
    'Locksmith calls are 100% urgent; speed to answer is the whole game.',
  ],
  'Appliance Repair': ['A dead fridge or washer is a same-day call — the first to answer books it.'],
  'Pool Service': ['Green-pool and pump-failure calls go to whoever picks up first.'],
  Landscaping: ['Most new lawn-care clients call 2-3 companies — the one that answers wins the contract.'],
  Painter: ['Estimate calls go cold fast; the painter who answers first usually lands the job.'],
  'Carpet Cleaning': ['Last-minute "company coming over" calls go to whoever answers right then.'],
  Handyman: ['Handyman calls are small but constant — answering every one fills the schedule.'],
  'Tree Service': ['A leaning or storm-damaged tree is an urgent call — the first answer wins the job.'],
};
const PROOF_DEFAULT = [
  'Most owners we work with book extra jobs within the first week.',
  'The businesses that answer every call simply close more work.',
  'Every missed call is revenue handed to whoever picks up next.',
];

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
  const proof = pick(PROOF_LINES[niche] ?? PROOF_DEFAULT, n, 3);
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

  /* Value para = the gap-matched fix + the AI we'd put to work (receptionist /
     reactivation / estimate-follow-up, by trade). Proof line for credibility. */
  return `${greet}

${hook}

${fix}. ${ai}

${proof}

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
