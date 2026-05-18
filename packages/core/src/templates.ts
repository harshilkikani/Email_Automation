/**
 * Plain-text templates with signal-aware slots.
 *
 * Renderer rules:
 *  - Hash-stable per lead-id (deterministic re-renders).
 *  - Slot pick prefers the strongest signal (no_website > storm_zone > social_only > gbp_only > by_appointment > default).
 *  - Never invents personalization. Missing tokens fall back to safe phrasing.
 *  - Always plaintext; renderer does not produce HTML.
 */
import type { Niche, ScoringInputs } from './types.js';
import { ALL_NICHES } from './types.js';

export type SlotKey = 'no_website' | 'social_only' | 'gbp_only' | 'storm_zone' | 'by_appointment' | 'default';

export interface Template {
  key: string;
  niche: Niche | 'all';
  label: string;
  sub: string;
  subjectVariants: string[];
  openerVariants: Record<SlotKey, string[]>;
  painVariants: string[];
  bodyTemplate: string;
}

const COMMON_OPENERS: Record<SlotKey, string[]> = {
  no_website: [
    'Saw {{business}} in {{city}} — looks like you run things mostly through phone and word-of-mouth, no main site yet.',
    'Came across {{business}} — clean operation, surprised you don\'t have a website up.',
  ],
  social_only: [
    'Found {{business}}\'s social page — quick question for you.',
    'Saw {{business}} on social but no main site — wanted to ask one thing.',
  ],
  gbp_only: [
    'Found {{business}} on Google — solid reviews.',
    'Saw {{business}} on Google Business — wanted to flag something I noticed.',
  ],
  storm_zone: [
    'After last week\'s storm in {{city}}, {{business}} must be slammed with calls.',
    'Storm season hitting {{city}} hard — figured {{business}} is fielding a lot of inquiries.',
  ],
  by_appointment: [
    '{{business}} runs by-appointment in {{city}} — quick question on after-hours calls.',
    'Saw {{business}}\'s hours are by-appointment — curious how you handle off-hour inbound.',
  ],
  default: [
    'Saw {{business}} serving {{city}} — quick question for you.',
    'Quick question, {{business}}.',
  ],
};

function mk(key: string, niche: Niche | 'all', label: string, sub: string,
            subs: string[], pains: string[], body: string,
            openerOverrides: Partial<Record<SlotKey, string[]>> = {}): Template {
  return {
    key, niche, label, sub,
    subjectVariants: subs,
    openerVariants: { ...COMMON_OPENERS, ...openerOverrides },
    painVariants: pains,
    bodyTemplate: body,
  };
}

const ROOFER = mk('roofer', 'Roofer', 'Roofing missed-calls', 'After-hours storm calls',
  ['quick question, {{business}}', '{{city}} storm calls', 'missed calls at {{business}}'],
  [
    'every missed call after a storm is a $8k+ job going to the next roofer on the list',
    'most roofing offices miss 1 in 4 calls during dispatch hours',
    'homeowners call the next contractor when nobody picks up',
  ],
  `{{opener}}

How many calls does {{business}} miss after hours or mid-job? For most roofers, {{pain}}.

We set up a 24/7 AI phone agent for roofers that answers every call, qualifies the lead, and books the estimate. Most crews cover the cost in week one from a single saved job.

Worth a 15-min look?

{{from_name}}
{{from_signoff}}`);

const SEPTIC = mk('septic', 'Septic', 'Septic 2 AM emergencies', 'After-hours backup calls',
  ['after-hours calls, {{business}}', '2am calls at {{business}}', 'never miss an emergency call'],
  [
    'a 2am backup call usually goes to whoever picks up first',
    'most septic outfits lose 30% of after-hours calls to voicemail',
    'every emergency call you miss is a same-day job a competitor wins',
  ],
  `{{opener}}

Honest question — what happens when someone calls {{business}} at 2am with a backup? For most septic outfits, {{pain}}.

We built a 24/7 AI answering agent for septic businesses that triages the emergency, captures the address, and texts your on-call tech. Setup takes an afternoon.

Open to a quick demo this week?

{{from_name}}
{{from_signoff}}`);

const WATER = mk('water', 'Water/Mold', 'Water/mold restoration', 'Insurance-driven 24/7 intake',
  ['water damage leads, {{business}}', '24/7 intake for {{business}}', 'never miss a flood call'],
  [
    'a pipe burst at 3am goes to whoever answers',
    'restoration jobs hinge on the first ten minutes of phone contact',
    'insurance-driven jobs go to the first responder, not the best one',
  ],
  `{{opener}}

When a pipe bursts at 3am, {{pain}}.

Keres AI answers every call instantly, captures the property details, and dispatches your team. Never lose an emergency lead to voicemail again.

Quick demo this week?

{{from_name}}
{{from_signoff}}`);

const HVAC = mk('hvac', 'HVAC', 'HVAC no-heat / no-cool', 'Seasonal emergency intake',
  ['no-heat calls at {{business}}', 'no-cool dispatch, {{business}}', 'never miss a peak-season call'],
  [
    'a no-heat call in January is whoever picks up first',
    'most HVAC offices miss 20-30% of calls during peak season',
    'a missed no-cool call is a $400+ same-day install lost',
  ],
  `{{opener}}

When the heat goes out at 8pm or the AC dies on the hottest day, the homeowner calls every HVAC shop in {{city}} until someone picks up. {{pain}}.

Keres AI answers, qualifies the urgency, books the dispatch, and texts your tech. Most shops break even in week one.

Worth a 15-min look?

{{from_name}}
{{from_signoff}}`);

const PLUMBER = mk('plumber', 'Plumber', 'Plumber leak calls', 'Emergency leak intake',
  ['leak calls at {{business}}', 'after-hours plumbing, {{business}}', 'never miss a leak'],
  [
    'a midnight leak goes to whichever plumber answers',
    'most small plumbing shops miss 1 in 5 calls during the day',
    'urgent leaks shop themselves to the first picked-up phone',
  ],
  `{{opener}}

When a slab leak shows up at 11pm, {{pain}}.

Keres AI is a 24/7 phone agent for plumbers — answers every call, qualifies the leak, books the dispatch. Setup takes an afternoon. Most shops save the cost in their first week from a single saved job.

Open to a short demo?

{{from_name}}
{{from_signoff}}`);

const ELECTRICIAN = mk('electrician', 'Electrician', 'Electrical service calls', 'Service-call intake',
  ['service calls at {{business}}', 'after-hours electrical, {{business}}', 'never miss a panel call'],
  [
    'a panel call in the evening goes to whichever electrician answers',
    'most electrical service shops miss 15-25% of calls',
    'service work is won on the first phone call',
  ],
  `{{opener}}

When a homeowner\'s panel trips at 8pm, {{pain}}.

Keres AI answers, qualifies the service need, and books the call. Built for small electrical shops — setup takes an afternoon, no IT change.

Worth a 15-min walkthrough?

{{from_name}}
{{from_signoff}}`);

const TOWING = mk('towing', 'Towing', 'Roadside / towing', 'Roadside urgency',
  ['roadside calls, {{business}}', 'never miss a roadside call', 'tow dispatch for {{business}}'],
  [
    'a stranded driver calls every tow in the area — first answer wins',
    'most towing outfits miss 1 in 3 calls during peak hours',
    'roadside jobs are decided in the first 60 seconds of phone contact',
  ],
  `{{opener}}

When someone\'s broken down on I-{{city}}, {{pain}}.

Keres AI answers, captures location and vehicle details, and dispatches your driver — 24/7. No more roadside leads going to the next tow on the list.

Quick demo this week?

{{from_name}}
{{from_signoff}}`);

const RE_TEAM = mk('real-estate', 'Real Estate', 'Real estate teams', 'Speed-to-lead routing',
  ['speed-to-lead at {{business}}', 'showing requests, {{business}}', 'never miss a buyer call'],
  [
    'speed-to-lead is the entire game in real estate',
    'most team leads die when nobody picks up after 5pm',
    'buyer inquiries shop themselves to the first responder',
  ],
  `{{opener}}

In real estate, {{pain}}.

Keres AI answers every inbound — buyer, seller, or showing — qualifies, and routes hot leads to your agents in real time. Best fit for teams 3-15 agents, not solo.

Worth 15 minutes?

{{from_name}}
{{from_signoff}}`);

const GENERAL = mk('general-audit', 'all', 'Free call audit', 'Works for any niche',
  ['free call audit for {{business}}', '{{business}} call audit', 'how many calls does {{business}} miss?'],
  [
    'most service businesses lose 20-30% of calls to voicemail',
    'phone-driven shops leak revenue at every after-hours call',
    'the fastest phone answer wins the job most of the time',
  ],
  `{{opener}}

Quick one — how many calls a week does {{business}} miss? {{pain}}.

We run a free communication audit and show you exactly where it\'s leaking. No pitch unless you want one.

Worth a look?

{{from_name}}
{{from_signoff}}`);

/* Lazy registration of pilot templates to avoid circular imports. The Septic /
   Houston pilot template lives in `templates-septic.ts`; register it once. */
import { SEPTIC_HOUSTON_PILOT } from './templates-septic.js';

export const TEMPLATES: Record<string, Template> = {
  roofer: ROOFER,
  septic: SEPTIC,
  water: WATER,
  hvac: HVAC,
  plumber: PLUMBER,
  electrician: ELECTRICIAN,
  towing: TOWING,
  'real-estate': RE_TEAM,
  'general-audit': GENERAL,
  'septic-houston-pilot': SEPTIC_HOUSTON_PILOT,
};

export function templatesForNiche(niche: Niche): Template[] {
  return Object.values(TEMPLATES).filter(t => t.niche === niche || t.niche === 'all');
}

export function defaultTemplateFor(niche: Niche): Template {
  const niche2key: Record<Niche, string> = {
    Roofer: 'roofer', Septic: 'septic', 'Water/Mold': 'water', HVAC: 'hvac',
    Plumber: 'plumber', Electrician: 'electrician', Towing: 'towing',
    'Real Estate': 'real-estate',
  };
  return TEMPLATES[niche2key[niche]] ?? GENERAL;
}

export function allNicheKeys(): Niche[] {
  return ALL_NICHES.slice();
}

/* ─── Renderer ─── */
export interface RenderContext {
  leadId: string;
  business: string;
  city: string;
  signals: Pick<ScoringInputs, 'webPresenceLevel' | 'isStormZone' | 'niche' | 'hasOnlineBooking'>;
  fromName: string;
  fromSignoff?: string;
}

export interface RenderedEmail {
  subject: string;
  body: string;
  slotKey: SlotKey;
  variantSeed: bigint;
}

export function pickSlot(signals: RenderContext['signals'], variantOverride?: SlotKey): SlotKey {
  if (variantOverride) return variantOverride;
  if (signals.webPresenceLevel === 'none') return 'no_website';
  if (signals.isStormZone && (signals.niche === 'Roofer' || signals.niche === 'Water/Mold')) return 'storm_zone';
  if (signals.webPresenceLevel === 'social_only') return 'social_only';
  if (signals.webPresenceLevel === 'gbp_only') return 'gbp_only';
  return 'default';
}

/**
 * 64-bit stable hash — FNV-1a flavored, but enough for slot selection.
 * Same lead.id => same output forever.
 */
export function stableHash(seed: string): bigint {
  let h = 14695981039346656037n;
  for (let i = 0; i < seed.length; i++) {
    h ^= BigInt(seed.charCodeAt(i));
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  return h;
}

function pickByHash<T>(arr: T[], seed: bigint): T {
  if (arr.length === 0) throw new Error('pickByHash: empty array');
  const idx = Number(seed % BigInt(arr.length));
  return arr[idx]!;
}

export function renderEmail(template: Template, ctx: RenderContext): RenderedEmail {
  const seed = stableHash(ctx.leadId);
  const slotKey = pickSlot(ctx.signals);
  const openers = template.openerVariants[slotKey] ?? template.openerVariants.default;
  const opener = pickByHash(openers, seed);
  const subject = pickByHash(template.subjectVariants, seed + 1n);
  const pain = pickByHash(template.painVariants, seed + 2n);

  /* Two-pass: opener / pain first (may themselves contain {{business}} or {{city}}),
     then the leaf tokens. */
  const expandSlots = (s: string) =>
    s.replace(/\{\{opener\}\}/g, opener)
     .replace(/\{\{pain\}\}/g, pain);
  const expandLeaves = (s: string) =>
    s.replace(/\{\{business\}\}/g, ctx.business || 'your business')
     .replace(/\{\{city\}\}/g, ctx.city || 'your area')
     .replace(/\{\{from_name\}\}/g, ctx.fromName)
     .replace(/\{\{from_signoff\}\}/g, ctx.fromSignoff ?? '');
  const replace = (s: string) => expandLeaves(expandSlots(s));

  return {
    subject: replace(subject),
    body: replace(template.bodyTemplate).trim(),
    slotKey,
    variantSeed: seed,
  };
}
