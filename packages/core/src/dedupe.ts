/**
 * Tiered, deterministic dedupe. Runs in-process so it works for both bulk
 * imports and live discovery.
 *
 *  1. Exact email
 *  2. Normalized phone (digits-only, length >= 7)
 *  3. Normalized website domain
 *  4. Normalized address (lowercase alnum-only, length >= 8)
 *  5. Normalized name + city + state
 *  6. Fuzzy name (Dice similarity) + address — when no other key matched
 *
 * The Dice coefficient gives a stable, cheap "fuzzy" without bringing in a
 * heavy fuzzy-string library. We bias toward not-deduping when in doubt.
 */
import type { LeadCandidate } from './types.js';

export function normEmail(s?: string | null): string | null {
  if (!s) return null;
  return s.trim().toLowerCase();
}
export function normPhone(s?: string | null): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length >= 7 ? d : null;
}
export function normDomain(s?: string | null): string | null {
  if (!s) return null;
  return s.toString().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9.\-]/g, '') || null;
}
export function normName(s?: string | null): string | null {
  if (!s) return null;
  const n = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return n || null;
}
export function normAddress(s?: string | null): string | null {
  if (!s) return null;
  const a = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return a.length >= 8 ? a : null;
}
export function normCityState(city?: string | null, state?: string | null): string {
  return [city, state].filter(Boolean).join('|').toLowerCase().replace(/[^a-z0-9|]/g, '');
}

export interface DedupeIndex {
  emails: Set<string>;
  phones: Set<string>;
  domains: Set<string>;
  addrs: Set<string>;
  nameCityState: Set<string>;
  externalIds: Set<string>;
  /** lowercase, no-punct names — for fuzzy fallback */
  fuzzyNames: string[];
  /** parallel: city|state of each fuzzy name above */
  fuzzyCityState: string[];
}

export function makeIndex(): DedupeIndex {
  return {
    emails: new Set(), phones: new Set(), domains: new Set(),
    addrs: new Set(), nameCityState: new Set(), externalIds: new Set(),
    fuzzyNames: [], fuzzyCityState: [],
  };
}

export interface IndexableLead {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  name?: string | null;
  city?: string | null;
  state?: string | null;
  source?: string | null;
  sourceExternalId?: string | null;
}

export function addToIndex(idx: DedupeIndex, lead: IndexableLead): void {
  const e = normEmail(lead.email); if (e) idx.emails.add(e);
  const p = normPhone(lead.phone); if (p) idx.phones.add(p);
  const d = normDomain(lead.website); if (d) idx.domains.add(d);
  const a = normAddress(lead.address); if (a) idx.addrs.add(a);
  const n = normName(lead.name);
  if (n) {
    const cs = normCityState(lead.city, lead.state);
    idx.nameCityState.add(`${n}|${cs}`);
    idx.fuzzyNames.push(n);
    idx.fuzzyCityState.push(cs);
  }
  if (lead.source && lead.sourceExternalId) {
    idx.externalIds.add(`${lead.source}:${lead.sourceExternalId}`);
  }
}

export interface DedupeResult {
  duplicate: boolean;
  reason?: 'email' | 'phone' | 'domain' | 'address' | 'name_citystate' | 'fuzzy_name' | 'external_id';
  similarity?: number;
}

export function checkDuplicate(cand: LeadCandidate, idx: DedupeIndex): DedupeResult {
  const e = normEmail(cand.email);
  if (e && idx.emails.has(e)) return { duplicate: true, reason: 'email' };
  const p = normPhone(cand.phone);
  if (p && idx.phones.has(p)) return { duplicate: true, reason: 'phone' };
  const d = normDomain(cand.website);
  if (d && idx.domains.has(d)) return { duplicate: true, reason: 'domain' };
  const a = normAddress(cand.address);
  if (a && idx.addrs.has(a)) return { duplicate: true, reason: 'address' };
  const n = normName(cand.name);
  if (n) {
    const cs = normCityState(cand.city, cand.state);
    if (idx.nameCityState.has(`${n}|${cs}`)) return { duplicate: true, reason: 'name_citystate' };
    /* Fuzzy fallback against same city/state to avoid false positives across geographies. */
    for (let i = 0; i < idx.fuzzyNames.length; i++) {
      if (idx.fuzzyCityState[i] !== cs) continue;
      const sim = diceSimilarity(n, idx.fuzzyNames[i]!);
      if (sim >= 0.92) return { duplicate: true, reason: 'fuzzy_name', similarity: sim };
    }
  }
  if (cand.source && cand.sourceExternalId &&
      idx.externalIds.has(`${cand.source}:${cand.sourceExternalId}`)) {
    return { duplicate: true, reason: 'external_id' };
  }
  return { duplicate: false };
}

/** Sørensen-Dice on character bigrams; fast and robust for business-name variants. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.slice(i, i + 2);
      m.set(bi, (m.get(bi) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a), mb = bigrams(b);
  let inter = 0;
  for (const [k, va] of ma) {
    const vb = mb.get(k);
    if (vb) inter += Math.min(va, vb);
  }
  const total = (a.length - 1) + (b.length - 1);
  return total === 0 ? 0 : (2 * inter) / total;
}
