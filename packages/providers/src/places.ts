/**
 * Google Places (New) discovery adapter — finds real businesses in any industry
 * and, crucially, returns their **website** so the scraper can extract an email.
 *
 * Uses the Places API (New) Text Search:
 *   POST https://places.googleapis.com/v1/places:searchText
 * Auth: X-Goog-Api-Key; a field mask keeps the response (and billing tier) tight.
 * Requires a Google Cloud project with "Places API (New)" + billing enabled.
 */
import type { LeadCandidate, Niche } from '@keres/core';
import type { DiscoveryProvider, DiscoveryQuery, DiscoveryResult } from './types.js';

export interface PlacesConfig {
  enabled: boolean;
  apiKey: string;
  /** Test seam. */
  fetcher?: (query: string, pageToken?: string) => Promise<PlacesResponse>;
}

interface PlaceResult {
  id?: string;
  displayName?: { text?: string };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  formattedAddress?: string;
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
}
export interface PlacesResponse { places?: PlaceResult[]; nextPageToken?: string }

const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.websiteUri',
  'places.nationalPhoneNumber', 'places.formattedAddress', 'places.addressComponents',
  'nextPageToken',
].join(',');

/** Rough Text Search (New) Pro-tier cost; for budget accounting only. */
const COST_CENTS_PER_REQUEST = 4;

export class PlacesAdapter implements DiscoveryProvider {
  readonly name = 'places';
  constructor(private cfg: PlacesConfig) {}
  isEnabled() { return this.cfg.enabled && !!this.cfg.apiKey; }

  async search(q: DiscoveryQuery): Promise<DiscoveryResult & { costCents: number }> {
    if (!this.isEnabled()) return { candidates: [], source: 'places', attribution: '', costCents: 0 };
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    const textQuery = `${q.keyword ? q.keyword + ' ' : ''}${nicheToQuery(q.niche)} in ${q.city}, ${q.state}`;

    const candidates: LeadCandidate[] = [];
    const warnings: string[] = [];
    let pageToken: string | undefined;
    let requests = 0;
    /* Page until we have enough (Places returns ≤20/page). Cap pages for cost. */
    while (candidates.length < q.targetCount && requests < 3) {
      let resp: PlacesResponse;
      try {
        resp = await fetcher(textQuery, pageToken);
      } catch (e: any) {
        warnings.push(`places_error: ${e?.message ?? e}`);
        break;
      }
      requests++;
      for (const p of resp.places ?? []) {
        const website = p.websiteUri?.trim();
        if (!website) continue;                       // no site → can't scrape an email
        const name = p.displayName?.text?.trim();
        if (!name) continue;
        candidates.push({
          name,
          website,
          phone: p.nationalPhoneNumber ?? null,
          address: p.formattedAddress ?? null,
          city: pickComponent(p, 'locality') ?? q.city,
          state: pickComponent(p, 'administrative_area_level_1', true) ?? q.state,
          postalCode: pickComponent(p, 'postal_code') ?? null,
          niche: q.niche,
          source: 'places',
          sourceExternalId: p.id ?? null,
        });
      }
      pageToken = resp.nextPageToken;
      if (!pageToken) break;
    }

    return {
      candidates: candidates.slice(0, q.targetCount),
      source: 'places',
      attribution: 'Business data © Google (Places API).',
      warnings: warnings.length ? warnings : undefined,
      costCents: requests * COST_CENTS_PER_REQUEST,
    };
  }

  private async realFetch(query: string, pageToken?: string): Promise<PlacesResponse> {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.cfg.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(pageToken ? { textQuery: query, pageToken } : { textQuery: query }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({})) as PlacesResponse & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Places ${res.status}: ${(json as any)?.error?.message ?? res.statusText}`);
    return json;
  }
}

function pickComponent(p: PlaceResult, type: string, short = false): string | null {
  const c = (p.addressComponents ?? []).find(c => (c.types ?? []).includes(type));
  return (short ? c?.shortText : c?.longText) ?? c?.longText ?? null;
}

/** Map our niche to a natural Places search term. */
function nicheToQuery(niche: Niche): string {
  const m: Record<Niche, string> = {
    Septic: 'septic service', Roofer: 'roofing contractor', 'Water/Mold': 'water damage restoration',
    HVAC: 'HVAC contractor', Plumber: 'plumber', Electrician: 'electrician',
    Towing: 'towing service', 'Real Estate': 'real estate agency',
  };
  return m[niche] ?? niche;
}
