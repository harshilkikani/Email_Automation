/**
 * Owner / decision-maker email finding — the deterministic core of an Apollo/
 * Hunter-style finder. Pure functions, no I/O, so they're fully testable:
 *
 *   1. extractPeople()        — pull person names + roles from page text
 *   2. pickDecisionMaker()    — choose the owner/founder/president
 *   3. detectEmailPattern()   — infer the company's email format from known emails
 *   4. generateCandidates()   — produce likely addresses for a name + domain
 *   5. chooseBestEmail()      — rank found vs. inferred vs. generic
 *
 * The network crawl + MX verification live in the server service that calls these.
 */

export interface Person {
  name: string;
  firstName: string;
  lastName: string;
  role: string | null;
}

/* Decision-maker roles, highest authority first. */
const ROLE_RANK: Array<[RegExp, number, string]> = [
  [/\bowner\b/i, 6, 'owner'],
  [/\b(founder|co-?founder)\b/i, 5, 'founder'],
  [/\b(president|principal|proprietor)\b/i, 4, 'president'],
  [/\b(ceo|chief executive)\b/i, 4, 'ceo'],
  [/\b(general manager|gm|operations manager)\b/i, 3, 'general manager'],
  [/\b(vice president|vp|director)\b/i, 2, 'director'],
  [/\bmanager\b/i, 1, 'manager'],
];

/* Case-SENSITIVE capitalized name sequence (2–3 words). No `i` flag — real names. */
const NAME_SEQ = /\b[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?){1,2}\b/g;
/* Any role word, for finding the closest-to-the-name title. */
const ROLE_RE = /\b(owner|co-?founders?|founders?|president|principal|proprietor|ceo|chief executive(?: officer)?|general manager|operations manager|vice president|director|manager)\b/i;

function roleLabel(raw: string): string {
  for (const [re, , label] of ROLE_RANK) if (re.test(raw)) return label;
  return raw.toLowerCase();
}

/**
 * Extract decision-makers from page text. A capitalized name is only kept when a
 * role word (owner/founder/…) sits right next to it — this is what separates a
 * real "John Smith, Owner" from headings, business names, and stray phrases.
 */
export function extractPeople(text: string): Person[] {
  const clean = text.replace(/\s+/g, ' ');
  const found = new Map<string, Person>();
  for (const m of clean.matchAll(NAME_SEQ)) {
    const full = m[0];
    const idx = m.index ?? 0;
    const parts = full.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) continue;
    const firstName = parts[0]!, lastName = parts[parts.length - 1]!;
    if (STOPWORDS.has(firstName.toLowerCase()) || STOPWORDS.has(lastName.toLowerCase())) continue;

    const after = clean.slice(idx + full.length, idx + full.length + 32).toLowerCase();
    const before = clean.slice(Math.max(0, idx - 28), idx).toLowerCase();
    let role: string | null = null;
    /* "Name, Role" / "Name - Role" — the FIRST role right after the name (closest
       wins, so we don't grab the next person's title). */
    if (/^\s*[,\-–|:&(]/.test(after)) {
      const m = after.slice(0, 24).match(ROLE_RE);
      if (m) role = roleLabel(m[0]);
    }
    /* "Role: Name" / "founded by Name" — role IMMEDIATELY before the name only. */
    if (!role) {
      if (/\b(founded|owned)\s+(?:and operated\s+)?by\s*$/.test(before)) role = 'owner';
      else for (const [re, , label] of ROLE_RANK) {
        if (new RegExp(`${re.source}\\s*[:\\-–]?\\s*$`, 'i').test(before)) { role = label; break; }
      }
    }
    if (!role) continue;   // no adjacent role → not a confirmed decision-maker

    const key = `${firstName} ${lastName}`.toLowerCase();
    const prevRank = found.has(key) ? roleRankOf(found.get(key)!.role) : -1;
    if (roleRankOf(role) > prevRank) found.set(key, { name: `${firstName} ${lastName}`, firstName, lastName, role });
  }
  return [...found.values()];
}

function roleRankOf(role: string | null): number {
  return role ? (ROLE_RANK.find(([, , label]) => label === role)?.[1] ?? 0) : -1;
}

/** Choose the most senior person; ties → first seen. Null if none. */
export function pickDecisionMaker(people: Person[]): Person | null {
  let best: Person | null = null;
  let bestRank = -1;
  for (const p of people) {
    const rank = p.role ? (ROLE_RANK.find(([, , label]) => label === p.role)?.[1] ?? 0) : 0;
    if (rank > bestRank) { best = p; bestRank = rank; }
  }
  return best;
}

export type EmailPattern =
  | '{first}' | '{last}' | '{f}{last}' | '{first}{last}'
  | '{first}.{last}' | '{f}.{last}' | '{first}_{last}' | '{first}{l}' | '{last}{f}';

/* Patterns to try for a name+domain, most common first. */
const ALL_PATTERNS: EmailPattern[] = [
  '{first}', '{first}.{last}', '{f}{last}', '{first}{last}', '{f}.{last}',
  '{first}_{last}', '{last}', '{first}{l}', '{last}{f}',
];

function renderPattern(p: EmailPattern, first: string, last: string): string {
  const f = first[0] ?? '', l = last[0] ?? '';
  return p
    .replace('{first}', first).replace('{last}', last)
    .replace('{f}', f).replace('{l}', l);
}

/**
 * Infer the company's email format from known (email, name) pairs. Strongest when
 * a found email maps to a known person; falls back to local-part shape heuristics.
 */
export function detectEmailPattern(known: Array<{ email: string; person?: Person }>): EmailPattern | null {
  const tally = new Map<EmailPattern, number>();
  for (const k of known) {
    const local = k.email.split('@')[0]?.toLowerCase();
    if (!local || GENERIC_LOCALS.has(local)) continue;
    if (k.person) {
      const first = k.person.firstName.toLowerCase(), last = k.person.lastName.toLowerCase();
      for (const p of ALL_PATTERNS) {
        if (renderPattern(p, first, last) === local) tally.set(p, (tally.get(p) ?? 0) + 1);
      }
    }
  }
  if (tally.size === 0) return null;
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** Candidate addresses for a person at a domain. Detected pattern first. */
export function generateCandidates(person: { firstName: string; lastName: string }, domain: string, pattern?: EmailPattern | null): string[] {
  const first = person.firstName.toLowerCase().replace(/[^a-z]/g, '');
  const last = person.lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (!first || !domain) return [];
  const order = pattern ? [pattern, ...ALL_PATTERNS.filter(p => p !== pattern)] : ALL_PATTERNS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of order) {
    const local = renderPattern(p, first, last);
    if (local && !seen.has(local)) { seen.add(local); out.push(`${local}@${domain}`); }
  }
  return out;
}

export interface ChosenEmail {
  email: string;
  /** direct_owner = found on site & matches owner; pattern = inferred; generic = info@-style */
  source: 'direct_owner' | 'pattern' | 'generic';
  confidence: number;   // 0–1
}

/**
 * Pick the best email to use. Priority: an address found on the site that matches
 * the owner (real + personal) > a pattern-inferred owner address (real format,
 * inferred mailbox) > the best generic mailbox (always real). Caller MX-verifies.
 */
export function chooseBestEmail(
  owner: Person | null,
  foundEmails: string[],
  domain: string,
  pattern: EmailPattern | null,
): ChosenEmail | null {
  const lower = foundEmails.map(e => e.toLowerCase());
  /* 1. A found address whose local-part contains the owner's name. */
  if (owner) {
    const f = owner.firstName.toLowerCase(), l = owner.lastName.toLowerCase();
    const direct = lower.find(e => {
      const local = e.split('@')[0] ?? '';
      return local.includes(f) || (l.length > 2 && local.includes(l));
    });
    if (direct) return { email: direct, source: 'direct_owner', confidence: 0.95 };
  }
  /* 2. Pattern-inferred owner address (only when we actually detected a pattern). */
  if (owner && pattern) {
    const cand = generateCandidates(owner, domain, pattern)[0];
    if (cand) return { email: cand, source: 'pattern', confidence: 0.6 };
  }
  /* 3. Best generic mailbox. */
  const generic = pickGeneric(lower);
  if (generic) return { email: generic, source: 'generic', confidence: 0.8 };
  return null;
}

const GENERIC_PREFERENCE = ['info', 'office', 'contact', 'hello', 'sales', 'service', 'admin', 'support'];
const GENERIC_LOCALS = new Set([...GENERIC_PREFERENCE, 'team', 'mail', 'help', 'inbox', 'general']);

function pickGeneric(emails: string[]): string | null {
  for (const pref of GENERIC_PREFERENCE) {
    const hit = emails.find(e => (e.split('@')[0] ?? '') === pref);
    if (hit) return hit;
  }
  return emails[0] ?? null;
}

const STOPWORDS = new Set([
  'home', 'about', 'contact', 'services', 'team', 'our', 'the', 'we', 'us', 'service',
  'septic', 'plumbing', 'roofing', 'heating', 'cooling', 'electric', 'company', 'llc',
  'inc', 'co', 'group', 'solutions', 'pros', 'experts', 'free', 'call', 'today', 'get',
  'privacy', 'policy', 'terms', 'monday', 'friday', 'emergency', 'quote', 'request',
]);
