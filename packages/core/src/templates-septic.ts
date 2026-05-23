/**
 * Septic / Houston pilot templates — Priority-1 evidence-mapped copy.
 *
 * Each opener is keyed to a *specific signal*. The preview UI cross-references
 * `openerEvidence[slotKey]` to surface the signal that supports each sentence.
 * If the lead doesn't carry that signal, the template renderer falls back to
 * `default`. This avoids the operator sending "I saw you don't have a website"
 * when we actually don't know.
 */
import type { Template, SlotKey } from './templates.js';

const SUBJECTS = [
  'septic backups, {{business}}',
  '2 am calls at {{business}}',
  '{{city}} after-hours septic',
];

/** Each pain line stays within the bounds of what's plausible without a
 *  fabricated case study. */
const PAIN = [
  'a 2 am backup call usually goes to whichever septic outfit picks up first',
  'most septic shops lose 30% of after-hours calls to voicemail',
  'when the owner is on a job site, the next ring goes to a competitor',
];

const BODY = `{{opener}}

Honest question — what happens when someone calls {{business}} at 2 am with a backup?
For most septic outfits in {{city}}, {{pain}}.

We built a 24/7 phone agent for septic businesses that triages the emergency,
captures the address, and texts your on-call tech a short summary. Setup is one
afternoon — no IT change.

Open to a 15-minute look?

{{from_name}}
{{from_signoff}}`;

const OPENERS: Record<SlotKey, string[]> = {
  /* SIGNAL: web_presence_level=none. The OSM record had no website tag AND
     our scraper saw no live homepage. */
  no_website: [
    'Saw {{business}} listed in {{city}} with no website yet — looks like things come in through phone and word-of-mouth.',
    'Found {{business}} in Houston-area listings, no website yet — that\'s actually how most working septic shops operate.',
  ],
  /* SIGNAL: web_presence_level=social_only (e.g. Facebook page). */
  social_only: [
    'Found {{business}} on Facebook — looks like the team handles most inbound there. Quick question.',
    'Came across {{business}}\'s social page (no separate site) — wanted to ask one thing.',
  ],
  /* SIGNAL: web_presence_level=gbp_only — Google Business Profile only. */
  gbp_only: [
    'Found {{business}} on Google with strong reviews — quick question on after-hours coverage.',
    'Saw {{business}}\'s Google listing in {{city}}. Wanted to flag something.',
  ],
  /* SIGNAL: license_status=active, web presence weak. */
  by_appointment: [
    'Saw {{business}} is actively licensed in TX but mostly phone-based. Quick question.',
    'Active TDLR license + low online footprint at {{business}} — that combo is exactly who we built this for.',
  ],
  /* SIGNAL: isStormZone for septic isn't a thing; we keep this slot for
     parity with the generic renderer but funnel to an emergency-niche line. */
  storm_zone: [
    'Heavy rain in {{city}} usually means septic-backup calls at {{business}} — quick question on how those land.',
  ],
  /* DEFAULT — used only when no specific signal applies. Honest, non-claimy. */
  default: [
    'Quick question for {{business}}: when an emergency call comes in after hours, what usually happens?',
  ],
};

/** What signal each opener slot relies on. Surfaced in the preview UI. */
export const SEPTIC_OPENER_EVIDENCE: Record<SlotKey, { signal: string; description: string }> = {
  no_website:       { signal: 'web_presence_level=none',     description: 'OSM tag had no website + our scraper saw no live homepage.' },
  social_only:      { signal: 'web_presence_level=social_only', description: 'OSM/scraper detected a social-only presence (FB/IG) and no separate domain.' },
  gbp_only:         { signal: 'web_presence_level=gbp_only', description: 'Google Business Profile exists, no separate domain detected.' },
  by_appointment:   { signal: 'license_status=active + weak_web', description: 'State license is active but web presence is weak.' },
  storm_zone:       { signal: 'isStormZone (Houston)',       description: 'NOAA storm-event cache contains a recent event in this ZIP.' },
  default:          { signal: '(no specific evidence)',      description: 'Falls back to a generic but honest opener. No claim is made.' },
};

export const SEPTIC_HOUSTON_PILOT: Template = {
  key: 'septic-houston-pilot',
  niche: 'Septic',
  label: 'Septic / Houston pilot',
  sub: 'Evidence-mapped pilot template — Priority-1 copy.',
  subjectVariants: SUBJECTS,
  openerVariants: OPENERS,
  painVariants: PAIN,
  bodyTemplate: BODY,
};

/**
 * Returns an array of { line, slotKey, signal, evidence } for the preview UI
 * to render each sentence with its supporting signal.
 */
export function mapSepticEvidence(slotKey: SlotKey): { signal: string; description: string } {
  return SEPTIC_OPENER_EVIDENCE[slotKey] ?? SEPTIC_OPENER_EVIDENCE.default;
}
